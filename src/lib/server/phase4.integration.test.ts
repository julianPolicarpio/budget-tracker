/**
 * Phase 4: Trip Mode, the payoff price switch, and the 72-hour list.
 *
 * The trip cases here are the ones Spec §11's golden set names explicitly: a
 * zero-decimal currency round-tripping through entry, storage and display; a
 * rate edit leaving local amounts byte-identical; an envelope overspent
 * mid-trip; and a declared-then-cancelled trip.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tripDailyFigure } from '$lib/allowance';
import { parseMoney, formatMoney } from '$lib/money';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	schema: typeof import('./db').schema;
	trips: typeof import('./trips');
	rules: typeof import('./rules');
	payoff: typeof import('./payoff');
	metrics: typeof import('./metrics');
	accounts: typeof import('./accounts');
};

let m: Mod;

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-p4-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	const migrations = resolve('migrations');
	for (const f of readdirSync(migrations)
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		dbMod.sqlite.exec(readFileSync(join(migrations, f), 'utf8'));
	}

	m = {
		sqlite: dbMod.sqlite,
		schema: dbMod.schema,
		trips: await import('./trips'),
		rules: await import('./rules'),
		payoff: await import('./payoff'),
		metrics: await import('./metrics'),
		accounts: await import('./accounts')
	};

	m.sqlite
		.prepare(
			`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
			                       period_kind, week_starts_on, haircut_pct, band_pct, phase,
			                       timezone, weekly_take_home_minor, created_at)
			 VALUES (1,'PHP','₱',2,1000,'weekly',0,15,10,1,'Asia/Manila',600000,'2026-08-01T00:00:00Z')`
		)
		.run();
	m.accounts.assertBalance(4, 5_000_000, '2026-08-16'); // Irregulars
	m.accounts.assertBalance(5, 3_000_000, '2026-08-16'); // Buffer
});

// ─── The inversion ────────────────────────────────────────────────────────
describe('tripDailyFigure', () => {
	const trip = { envelopeMinor: 1_000_000, bufferDrawMinor: 0, endsOn: '2026-09-10' };

	it('divides by days REMAINING — the opposite of dailyAllowance', () => {
		// 10 days left, nothing spent.
		expect(tripDailyFigure(trip, 0, '2026-09-01').figure).toBe(100_000);
		// Same envelope, half gone, 5 days left → the figure moves. A period's
		// number must never do this; a trip's must.
		expect(tripDailyFigure(trip, 500_000, '2026-09-06').figure).toBe(100_000);
	});

	it('front-loading shrinks the rest of the trip rather than being ignored', () => {
		expect(tripDailyFigure(trip, 800_000, '2026-09-06').figure).toBe(40_000);
	});

	it('reports how far over rather than going negative', () => {
		const f = tripDailyFigure(trip, 1_200_000, '2026-09-06');
		expect(f.figure).toBe(0);
		expect(f.over).toBe(200_000);
	});

	it('spends the envelope to near-zero on the last day, which is correct', () => {
		const f = tripDailyFigure(trip, 900_000, '2026-09-10');
		expect(f.daysLeft).toBe(1);
		expect(f.figure).toBe(100_000);
	});

	it('applies no haircut — there is no next period to sweep into', () => {
		expect(tripDailyFigure(trip, 0, '2026-09-01').figure).toBe(100_000);
	});
});

// ─── Zero-decimal currencies ──────────────────────────────────────────────
describe('a zero-decimal currency', () => {
	it('round-trips through entry, storage and display without a 100x error', () => {
		// ¥1,000 is 1000 minor units at zero decimals. Parsed at two it would be
		// 100000 — the first purchase abroad, silently wrong by 100x.
		expect(parseMoney('1000', 0)).toBe(1000);
		expect(parseMoney('1000', 2)).toBe(100_000);
		expect(formatMoney(1000, { minorUnits: 0, symbol: '¥' })).toBe('¥1,000');
		expect(parseMoney('1000.50', 0)).toBeNull();
	});

	it('converts to home currency across differing minor-unit scales', () => {
		const trip = { fxRateToHome: 0.38, localMinorUnits: 0 };
		// ¥1,000 at ₱0.38/¥ is ₱380.00 → 38000 home minor units.
		expect(m.trips.localToHome(1000, trip, 2)).toBe(38_000);
	});
});

// ─── Declare → fund → activate → settle ───────────────────────────────────
describe('the trip lifecycle', () => {
	let tripId: number;

	it('declares a trip as a funded irregular, padded like any other estimate', () => {
		const trip = m.trips.declareTrip({
			label: 'Tokyo, September',
			startsOn: '2026-09-01',
			endsOn: '2026-09-10',
			tripTz: 'Asia/Tokyo',
			currencyCode: 'JPY',
			currencySymbol: '¥',
			localMinorUnits: 0,
			fxRateToHome: 0.38,
			estimateMinor: 4_000_000 // ₱40,000
		});
		tripId = trip.id;

		expect(trip.status).toBe('planned');
		expect(trip.envelopeMinor).toBe(5_000_000); // +25%
		// A planned trip with no linked instance is a validation error, not a
		// warning — an unfunded trip eats two periods of Spend silently.
		expect(trip.irregularInstanceId).not.toBeNull();
	});

	it('refuses a stay long enough to be a relocation', () => {
		expect(() =>
			m.trips.declareTrip({
				label: 'Semester abroad',
				startsOn: '2027-01-01',
				endsOn: '2027-06-01',
				tripTz: 'Europe/Lisbon',
				currencyCode: 'EUR',
				currencySymbol: '€',
				localMinorUnits: 2,
				fxRateToHome: 62,
				estimateMinor: 20_000_000
			})
		).toThrow(m.trips.TripTooLong);
	});

	it('runs the funding check 14 days out, not on the day', () => {
		const trip = m.trips.tripById(tripId)!;
		expect(m.trips.fundingCheck(trip, '2026-08-01').due).toBe(false);
		const check = m.trips.fundingCheck(trip, '2026-08-20');
		expect(check.due).toBe(true);
		expect(check.daysToDeparture).toBe(12);
	});

	it('demands an IOU for the third option', () => {
		expect(() => m.trips.coverShortfall(tripId, 500_000, '   ', null, '2026-08-20')).toThrow(
			m.accounts.IouRequired
		);

		m.trips.coverShortfall(
			tripId,
			500_000,
			'Short on Tokyo, back in October',
			'2026-10-31',
			'2026-08-20'
		);
		expect(m.trips.tripById(tripId)!.bufferDrawMinor).toBe(500_000);
		expect(m.accounts.openIous('2026-08-20')).toHaveLength(1);
	});

	it('activates, and refuses a second overlapping trip', () => {
		m.trips.activateTrip(tripId);
		expect(m.trips.activeTrip()?.id).toBe(tripId);

		const other = m.trips.declareTrip({
			label: 'Cebu',
			startsOn: '2026-09-05',
			endsOn: '2026-09-07',
			tripTz: 'Asia/Manila',
			currencyCode: 'PHP',
			currencySymbol: '₱',
			localMinorUnits: 2,
			fxRateToHome: 1.0, // domestic: everything collapses to the normal path
			estimateMinor: 500_000
		});
		expect(() => m.trips.activateTrip(other.id)).toThrow(/still active/);
		m.trips.cancelTrip(other.id);
	});

	it('cancelling releases the linked irregular instance', () => {
		const cancelled = m.sqlite.prepare(`SELECT status FROM trip WHERE label = 'Cebu'`).get() as {
			status: string;
		};
		expect(cancelled.status).toBe('cancelled');

		const inst = m.sqlite
			.prepare(
				`SELECT ii.status FROM irregular_instance ii
				 JOIN irregular i ON i.id = ii.irregular_id WHERE i.label = 'Cebu'`
			)
			.get() as { status: string };
		expect(inst.status).toBe('skipped');
	});
});

// ─── The rate edit ────────────────────────────────────────────────────────
describe('editing the locked rate', () => {
	function logTrip(localMinor: number, spentOn: string) {
		const trip = m.trips.activeTrip()!;
		m.sqlite
			.prepare(
				`INSERT INTO txn (spent_on, amount_minor, category, planned, entered_at,
				                  trip_id, amount_local_minor, fx_rate_used)
				 VALUES (?,?,?,?,?,?,?,?)`
			)
			.run(
				spentOn,
				m.trips.localToHome(localMinor, trip, 2),
				'food_out',
				0,
				`${spentOn}T12:00:00Z`,
				trip.id,
				localMinor,
				trip.fxRateToHome
			);
	}

	it('leaves the local amounts byte-identical and recomputes home', () => {
		logTrip(3800, '2026-09-01'); // ¥3,800
		logTrip(12_500, '2026-09-02'); // ¥12,500

		const trip = m.trips.activeTrip()!;
		const before = m.sqlite
			.prepare(
				'SELECT amount_local_minor AS l, amount_minor AS h FROM txn WHERE trip_id = ? ORDER BY id'
			)
			.all(trip.id) as { l: number; h: number }[];

		expect(before.map((r) => r.l)).toEqual([3800, 12_500]);
		expect(before.map((r) => r.h)).toEqual([144_400, 475_000]);

		// The ATM fee turned out worse than assumed.
		m.trips.setRate(trip.id, 0.41, 2);

		const after = m.sqlite
			.prepare(
				'SELECT amount_local_minor AS l, amount_minor AS h FROM txn WHERE trip_id = ? ORDER BY id'
			)
			.all(trip.id) as { l: number; h: number }[];

		// What the user typed is untouched; only the derived side moves.
		expect(after.map((r) => r.l)).toEqual(before.map((r) => r.l));
		expect(after.map((r) => r.h)).toEqual([155_800, 512_500]);
	});
});

// ─── Settling ─────────────────────────────────────────────────────────────
describe('settling a trip', () => {
	it('separates estimate error from FX-and-fee error', () => {
		const trip = m.trips.activeTrip()!;
		const logged = m.trips.tripSpentMinor(trip.id);

		// The bank actually took more than the locked rate implied.
		const s = m.trips.settleTrip(trip.id, logged + 40_000, '2026-09-12');

		expect(s.loggedMinor).toBe(logged);
		// envelope − logged: did the trip cost what I thought?
		expect(s.estimateErrorMinor).toBe(trip.envelopeMinor - logged);
		// actual − logged: was my rate right? Different failure, different fix.
		expect(s.fxErrorMinor).toBe(40_000);
		expect(m.trips.activeTrip()).toBeNull();
	});

	it('feeds the settled trip into the estimate-accuracy history', () => {
		const row = m.sqlite
			.prepare(
				`SELECT ii.status, ii.actual_minor AS a FROM irregular_instance ii
				 JOIN irregular i ON i.id = ii.irregular_id WHERE i.label = 'Tokyo, September'`
			)
			.get() as { status: string; a: number };
		expect(row.status).toBe('settled');
		expect(row.a).toBeGreaterThan(0);
	});

	it('leaves the ongoing metrics untouched by the whole trip', () => {
		// The quarantine again, now with real trip rows behind it.
		const a = m.metrics.weekActuals({ from: '2026-09-01', to: '2026-09-10' });
		expect(a.totalMinor).toBe(0);
		expect(a.unplannedRatioBp).toBeNull();
	});
});

// ─── The payoff price switch ──────────────────────────────────────────────
describe('the payoff price switch', () => {
	const debts = [
		{ id: 1, label: 'Card', balanceMinor: 4_000_000, aprBp: 2400, minPaymentMinor: 200_000 },
		{ id: 2, label: 'Phone plan', balanceMinor: 500_000, aprBp: 0, minPaymentMinor: 50_000 },
		{ id: 3, label: 'Student loan', balanceMinor: 12_000_000, aprBp: 600, minPaymentMinor: 300_000 }
	];

	it('clears every debt and charges interest along the way', () => {
		const av = m.payoff.simulate(debts, 500_000, (a, b) => b.aprBp - a.aprBp);
		expect(av.stalled).toBe(false);
		expect(av.months).toBeGreaterThan(0);
		expect(av.totalInterestMinor).toBeGreaterThan(0);
		expect(av.cleared).toHaveLength(3);
	});

	it('avalanche never costs more interest than snowball', () => {
		const av = m.payoff.simulate(debts, 500_000, (a, b) => b.aprBp - a.aprBp);
		const sn = m.payoff.simulate(debts, 500_000, (a, b) => a.balanceMinor - b.balanceMinor);
		expect(av.totalInterestMinor).toBeLessThanOrEqual(sn.totalInterestMinor);
	});

	it('buys the motivation when it costs less than one period of Spend', () => {
		const plan = m.payoff.payoffPlan(debts, 500_000, 100_000_000)!;
		expect(plan.mode).toBe('snowball');
		expect(plan.order[0]).toBe(2); // smallest balance first
	});

	it('optimises when the motivation costs more, and still shows all three', () => {
		const plan = m.payoff.payoffPlan(debts, 500_000, 1)!;
		expect(plan.mode).not.toBe('snowball');
		expect(plan.avalanche.months).toBeGreaterThan(0);
		expect(plan.snowball.months).toBeGreaterThan(0);
		expect(plan.hybrid.months).toBeGreaterThan(0);
		expect(plan.priceMinor).toBeGreaterThan(0);
	});

	it('reports a plan that does not terminate rather than looping forever', () => {
		const hopeless = [
			{ id: 9, label: 'Payday loan', balanceMinor: 10_000_000, aprBp: 40_000, minPaymentMinor: 1 }
		];
		expect(m.payoff.simulate(hopeless, 0, () => 0).stalled).toBe(true);
	});

	it('returns null when there is nothing to pay off', () => {
		expect(m.payoff.payoffPlan([], 500_000, 100_000)).toBeNull();
	});
});

// ─── The 72-hour list ─────────────────────────────────────────────────────
describe('the 72-hour list', () => {
	const added = new Date('2026-08-16T20:00:00Z');

	it('is not ripe before 72 hours are up', () => {
		m.rules.addWaitItem('Mechanical keyboard', 320_000, added);
		expect(m.rules.ripeItems(new Date('2026-08-18T20:00:00Z'))).toHaveLength(0);
		expect(m.rules.waitingItems(new Date('2026-08-18T20:00:00Z'))).toHaveLength(1);
	});

	it('ripens at exactly 72 hours', () => {
		expect(m.rules.ripeItems(new Date('2026-08-19T20:00:01Z'))).toHaveLength(1);
	});

	it('reports the drop rate, which is the argument for the rule', () => {
		expect(m.rules.dropRateBp()).toBeNull();

		const ripe = m.rules.ripeItems(new Date('2026-08-19T20:00:01Z'))[0];
		m.rules.resolveWaitItem(ripe.id, 'dropped');
		expect(m.rules.dropRateBp()).toBe(10_000);

		m.rules.addWaitItem('Headphones', 500_000, added);
		const next = m.rules.ripeItems(new Date('2026-08-19T20:00:01Z'))[0];
		m.rules.resolveWaitItem(next.id, 'bought');
		expect(m.rules.dropRateBp()).toBe(5000);
	});
});

// ─── The pre-seeded if-then plans ─────────────────────────────────────────
describe('if-then plans', () => {
	it('ship pre-populated, because a blank page gets zero rules written', () => {
		const rules = m.rules.listRules();
		expect(rules.length).toBeGreaterThanOrEqual(18);
		expect(new Set(rules.map((r) => r.category)).size).toBe(6);
	});

	it('counts firings, which is what the quarterly audit reads', () => {
		const first = m.rules.listRules()[0];
		expect(first.firedCount).toBe(0);
		m.rules.fireRule(first.id);
		m.rules.fireRule(first.id);
		expect(m.rules.listRules()[0].firedCount).toBe(2);
		expect(m.rules.listRules()[0].lastFired).not.toBeNull();
	});
});
