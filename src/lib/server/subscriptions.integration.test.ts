/**
 * Subscription deadlines and the alert state machine.
 *
 * The property under test that matters most is the one the row-state design
 * exists for: an alert whose trigger date passes while the machine is asleep
 * must still fire afterwards. A date-keyed job cannot do that, and a
 * once-in-twelve-months warning that silently no-ops is worse than no feature.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_LEAD_DAYS } from '$lib/subscription-cadence';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	subs: typeof import('./subscriptions');
};

let m: Mod;
const TZ = 'Asia/Manila';

/** The Google AI Plus trial from the screenshot that prompted this feature. */
const GOOGLE = {
	label: 'Google AI Plus (400 GB)',
	vendor: 'Google One',
	amountMinor: 28_500,
	taxMinor: 3_054,
	cadence: 'monthly' as const,
	nextChargeOn: '2027-08-23',
	trialEndsOn: '2027-08-23',
	cancelByOn: '2027-08-23',
	leadDays: 30
};

beforeAll(async () => {
	process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-subs-')), 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	const migrations = resolve('migrations');
	for (const f of readdirSync(migrations)
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		dbMod.sqlite.exec(readFileSync(join(migrations, f), 'utf8'));
	}
	dbMod.sqlite.exec(
		`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
		                       period_kind, week_starts_on, haircut_pct, band_pct, phase,
		                       timezone, created_at)
		 VALUES (1, 'PHP', '₱', 2, 1000, 'weekly', 0, 15, 10, 0, '${TZ}', '2026-01-01T00:00:00.000Z')`
	);
	m = { sqlite: dbMod.sqlite, subs: await import('./subscriptions') };
});

beforeEach(() => m.sqlite.exec('DELETE FROM subscription;'));

describe('annualised cost', () => {
	it('reports what each cadence really costs per year', () => {
		const cases = [
			['monthly', 28_500, 342_000],
			['quarterly', 28_500, 114_000],
			['semiannual', 28_500, 57_000],
			['annual', 28_500, 28_500]
		] as const;
		for (const [cadence, amountMinor, expected] of cases) {
			expect(m.subs.annualisedMinor({ amountMinor, cadence })).toBe(expected);
		}
	});

	it('turns ₱285 a month into the ₱3,420 a year that makes the case', () => {
		m.subs.createSubscription(GOOGLE);
		// The whole point of the cull headline: same fact, different volume.
		expect(m.subs.annualisedTotalMinor()).toBe(342_000);
	});
});

describe('alert windows', () => {
	it('stays silent outside the lead window', () => {
		m.subs.createSubscription(GOOGLE);
		expect(m.subs.pendingAlerts('2027-07-01')).toEqual([]);
	});

	it('fires stage 1 once the lead window opens, then not again', () => {
		const id = m.subs.createSubscription(GOOGLE);

		const first = m.subs.pendingAlerts('2027-07-24');
		expect(first).toHaveLength(1);
		expect(first[0].stage).toBe(1);
		expect(first[0].daysLeft).toBe(30);

		m.subs.recordAlert(id, 1);
		expect(m.subs.pendingAlerts('2027-07-25')).toEqual([]);
	});

	it('fires a second, final alert inside seven days', () => {
		const id = m.subs.createSubscription(GOOGLE);
		m.subs.recordAlert(id, 1);

		const final = m.subs.pendingAlerts('2027-08-17');
		expect(final).toHaveLength(1);
		expect(final[0].stage).toBe(2);

		m.subs.recordAlert(id, 2);
		expect(m.subs.pendingAlerts('2027-08-22')).toEqual([]);
	});

	it('SLEEP-PROOF: still alerts when the trigger date passed unobserved', () => {
		m.subs.createSubscription(GOOGLE);

		// The lead window opened on 2027-07-24 and the machine was shut. Nothing
		// ran that day, that week, or for the three weeks after it. A date-keyed
		// job would now be permanently past its only chance to fire.
		const late = m.subs.pendingAlerts('2027-08-19');

		expect(late).toHaveLength(1);
		expect(late[0].daysLeft).toBe(4);
		// Four days out it should be shouting, not delivering the gentle one.
		expect(late[0].stage).toBe(1);
	});

	it('goes quiet once the deadline has passed — the charge already landed', () => {
		m.subs.createSubscription(GOOGLE);
		expect(m.subs.pendingAlerts('2027-08-24')).toEqual([]);
	});

	it('goes quiet on a cancelled subscription', () => {
		const id = m.subs.createSubscription(GOOGLE);
		m.subs.cancelSubscription(id);
		expect(m.subs.pendingAlerts('2027-08-01')).toEqual([]);
	});

	it('ignores a subscription with no deadline set', () => {
		m.subs.createSubscription({ ...GOOGLE, trialEndsOn: null, cancelByOn: null });
		expect(m.subs.pendingAlerts('2027-08-22')).toEqual([]);
	});
});

describe('the warning lead fits the cycle', () => {
	it('stays quiet on a monthly renewal until it is genuinely close', () => {
		// Recorded 24 Aug, first charge 24 Sept — the shape quick-add produces.
		const id = m.subs.createSubscription({
			...GOOGLE,
			trialEndsOn: null,
			nextChargeOn: '2026-09-24',
			cancelByOn: '2026-09-24',
			leadDays: DEFAULT_LEAD_DAYS.monthly
		});

		// A 30-day lead would have fired here, one day after recording it.
		expect(m.subs.pendingAlerts('2026-08-25')).toEqual([]);
		expect(m.subs.pendingAlerts('2026-09-10')).toEqual([]);

		// Seven days out it speaks up, once.
		const due = m.subs.pendingAlerts('2026-09-17');
		expect(due).toHaveLength(1);
		expect(due[0].sub.id).toBe(id);
	});

	it('still gives a yearly renewal a month of runway', () => {
		m.subs.createSubscription({
			...GOOGLE,
			cadence: 'annual',
			trialEndsOn: null,
			leadDays: DEFAULT_LEAD_DAYS.annual
		});
		// A decision worth ₱3,420 deserves more than a week to think about.
		expect(m.subs.pendingAlerts('2027-07-24')).toHaveLength(1);
	});
});

describe('decisions', () => {
	it('re-arms after a keep, so next year asks again', () => {
		const id = m.subs.createSubscription(GOOGLE);
		m.subs.recordAlert(id, 2);

		m.subs.keepSubscription(id, '2027-08-23');

		const sub = m.subs.getSubscription(id)!;
		expect(sub.trialEndsOn).toBeNull();
		expect(sub.nextChargeOn).toBe('2027-09-23');
		expect(sub.cancelByOn).toBe('2027-09-23');
		// Re-armed: the cull is recurring, not a one-time gate.
		expect(sub.alertStage).toBe(0);
		expect(m.subs.pendingAlerts('2027-09-01')).toHaveLength(1);
	});
});

describe('the cull (Spec §267)', () => {
	it('flags a never-used subscription as stale', () => {
		m.subs.createSubscription(GOOGLE);
		const [row] = m.subs.cullList('2027-01-01');
		expect(row.staleDays).toBeNull();
		// Never recorded as used is the exact case the cull hunts.
		expect(row.stale).toBe(true);
	});

	it('clears the flag when used inside 30 days, sets it beyond', () => {
		const id = m.subs.createSubscription(GOOGLE);

		m.subs.markUsed(id, '2026-12-20');
		expect(m.subs.cullList('2027-01-01')[0].stale).toBe(false);

		m.subs.markUsed(id, '2026-11-01');
		expect(m.subs.cullList('2027-01-01')[0].stale).toBe(true);
	});
});

describe('delivery is what advances the state', () => {
	it('leaves the row pending when the OS did not take the notification', async () => {
		// SPLIT_DISABLE_NOTIFY makes notify() resolve false, which is the same
		// shape as a genuine osascript failure or a non-macOS host.
		process.env.SPLIT_DISABLE_NOTIFY = '1';
		const jobs = await import('./jobs');

		const id = m.subs.createSubscription({
			...GOOGLE,
			// Inside the lead window relative to the real clock, so the scheduler
			// function — which reads the wall clock — actually sees it.
			nextChargeOn: '2099-01-15',
			trialEndsOn: '2099-01-15',
			cancelByOn: '2099-01-15',
			leadDays: 365 * 100
		});

		const delivered = await jobs.runSubscriptionAlerts();

		expect(delivered).toBe(0);
		// Still stage 0: undelivered is not the same as sent, so the next sweep
		// tries again rather than silently swallowing the only warning.
		expect(m.subs.getSubscription(id)!.alertStage).toBe(0);
		delete process.env.SPLIT_DISABLE_NOTIFY;
	});
});

describe('what the split must reserve', () => {
	it('spreads a monthly bill at its long-run weekly rate', () => {
		// ₱750/month over a 7-day period. Not ₱750/4 — a month is not four weeks,
		// and the error compounds to a fortnight a year.
		m.subs.createSubscription({
			...GOOGLE,
			label: 'Home wifi',
			amountMinor: 75_000,
			isEssential: true
		});
		expect(m.subs.commitmentsPerPeriod(7)).toBe(17_248);
	});

	it('does not lurch as the charge date approaches', () => {
		m.subs.createSubscription({ ...GOOGLE, amountMinor: 75_000 });
		// The irregulars accrual rises as a deadline closes in, correctly, because
		// the lump must be ready by a date. A recurring bill has no such date, so
		// this figure is the same today as in three weeks.
		const now = m.subs.commitmentsPerPeriod(7);
		m.sqlite.exec(`UPDATE subscription SET next_charge_on = '2027-08-24'`);
		expect(m.subs.commitmentsPerPeriod(7)).toBe(now);
	});

	it('adds every live commitment together, rounding once at the end', () => {
		m.subs.createSubscription({ ...GOOGLE, amountMinor: 75_000, isEssential: true });
		m.subs.createSubscription({ ...GOOGLE, label: 'Google AI Plus', amountMinor: 28_500 });

		// 23803, not 17248 + 6554 = 23802. Rounding each line first and adding
		// the results throws away a centavo per row; the reservation is one
		// figure, so it is rounded once.
		expect(m.subs.commitmentsPerPeriod(7)).toBe(23_803);
	});

	it('reserves nothing for a commitment still inside its free trial', () => {
		m.subs.createSubscription({ ...GOOGLE, amountMinor: 28_500 }); // trial to 2027-08-23
		m.subs.createSubscription({
			...GOOGLE,
			label: 'Home wifi',
			amountMinor: 75_000,
			trialEndsOn: null,
			isEssential: true
		});

		// Only the wifi. Parking money against a charge you can still decline is
		// how a budget starves the present to fund a hypothetical.
		expect(m.subs.commitmentsPerPeriod(7, '2026-08-23')).toBe(17_248);

		// The day it starts charging, it starts costing.
		expect(m.subs.commitmentsPerPeriod(7, '2027-08-23')).toBe(23_803);
	});

	it('drops a cancelled commitment from the reservation', () => {
		const id = m.subs.createSubscription({ ...GOOGLE, amountMinor: 75_000 });
		m.subs.cancelSubscription(id);
		expect(m.subs.commitmentsPerPeriod(7)).toBe(0);
	});
});

describe('a pile of free trials', () => {
	it('reserves nothing while they are free, and everything once they are not', () => {
		// The realistic shape: several free AI offers, all ₱0 today, all
		// converting on different dates.
		const trials = [
			{ label: 'Google AI Plus', amountMinor: 28_500, ends: '2027-08-23' },
			{ label: 'AI tool B', amountMinor: 115_000, ends: '2026-11-01' },
			{ label: 'AI tool C', amountMinor: 60_000, ends: '2026-09-15' }
		];
		for (const t of trials) {
			m.subs.createSubscription({
				...GOOGLE,
				label: t.label,
				amountMinor: t.amountMinor,
				nextChargeOn: t.ends,
				trialEndsOn: t.ends,
				cancelByOn: t.ends
			});
		}

		// Free today: the split reserves nothing, correctly.
		expect(m.subs.commitmentsPerPeriod(7, '2026-08-24')).toBe(0);

		// But the annual headline shows the full exposure the whole time, which
		// is the number that should make you cancel two of them.
		expect(m.subs.annualisedTotalMinor()).toBe(28_500 * 12 + 115_000 * 12 + 60_000 * 12);

		// They convert one at a time, and the reservation steps up each time.
		expect(m.subs.commitmentsPerPeriod(7, '2026-09-15')).toBe(13_799);
		expect(m.subs.commitmentsPerPeriod(7, '2026-11-01')).toBe(40_246);
	});

	it('surfaces the nearest deadline first when several are pending', () => {
		m.subs.createSubscription({ ...GOOGLE, label: 'later', cancelByOn: '2026-11-01' });
		m.subs.createSubscription({ ...GOOGLE, label: 'sooner', cancelByOn: '2026-09-15' });

		const alerts = m.subs.pendingAlerts('2026-09-10');
		expect(alerts).toHaveLength(1);
		expect(alerts[0].sub.label).toBe('sooner');
	});
});

describe('essentials are not culled', () => {
	it('keeps a non-negotiable cost off the cull list entirely', () => {
		m.subs.createSubscription({ ...GOOGLE, label: 'Home wifi', isEssential: true });
		m.subs.createSubscription({ ...GOOGLE, label: 'Netflix' });

		const cull = m.subs.cullList('2026-08-23');

		// "Have you used your home internet lately" is not a question.
		expect(cull.map((r) => r.sub.label)).toEqual(['Netflix']);
		expect(m.subs.commitmentsByKind().essential).toHaveLength(1);
	});
});

describe('the Bills allocation tracks changes mid-period', () => {
	it('revises an unmade transfer, and never one already made', async () => {
		const alloc = await import('./allocations');
		const rollover = await import('./rollover');

		m.sqlite.exec(`DELETE FROM allocation; DELETE FROM period;`);
		m.sqlite
			.prepare(
				`INSERT INTO period (id, starts_on, ends_on, days, spend_alloc_minor,
				 daily_allowance_minor, haircut_pct_applied, phase_at_open, created_at)
				 VALUES (1,'2026-08-23','2026-08-29',7,100000,12143,15,0,?)`
			)
			.run('2026-08-23T00:00:00.000Z');
		const period = rollover.openPeriodOn('2026-08-24')!;

		m.subs.createSubscription({ ...GOOGLE, label: 'Wifi', amountMinor: 75_000, trialEndsOn: null });
		alloc.ensureAllocations(period, '2026-08-24');

		const billsId = (
			m.sqlite.prepare(`SELECT id FROM account WHERE kind='bills'`).get() as { id: number }
		).id;
		const read = () =>
			(
				m.sqlite
					.prepare(`SELECT amount_minor AS a FROM allocation WHERE account_id=?`)
					.get(billsId) as { a: number }
			).a;

		expect(read()).toBe(17_248);

		// A second commitment lands mid-week. The transfer has not been made, so
		// the figure must follow — otherwise the page and the money map disagree.
		m.subs.createSubscription({ ...GOOGLE, label: 'ChatGPT', amountMinor: 110_000, trialEndsOn: null });
		alloc.ensureAllocations(period, '2026-08-24');
		expect(read()).toBe(42_546);

		// Once the money has actually moved, the row is history, not a plan.
		m.sqlite
			.prepare(`UPDATE allocation SET executed_at=? WHERE account_id=?`)
			.run('2026-08-24T10:00:00.000Z', billsId);
		m.subs.createSubscription({ ...GOOGLE, label: 'Another', amountMinor: 50_000, trialEndsOn: null });
		alloc.ensureAllocations(period, '2026-08-24');
		expect(read()).toBe(42_546);
	});
});

describe('editing a commitment', () => {
	const base = { ...GOOGLE, leadDays: 30 };

	it('re-arms the warnings when the deadline moves', () => {
		const id = m.subs.createSubscription(base);
		m.subs.recordAlert(id, 2);
		expect(m.subs.getSubscription(id)!.alertStage).toBe(2);

		// You discover the trial actually runs to December, not August.
		m.subs.updateSubscription(id, {
			...base,
			trialEndsOn: '2027-12-01',
			cancelByOn: '2027-12-01',
			nextChargeOn: '2027-12-01'
		});

		// The warnings already sent described a date that no longer exists, so
		// they cannot count as having warned you about the new one.
		expect(m.subs.getSubscription(id)!.alertStage).toBe(0);
		expect(m.subs.pendingAlerts('2027-11-05')).toHaveLength(1);
	});

	it('does NOT re-arm when only the label or price changes', () => {
		const id = m.subs.createSubscription(base);
		m.subs.recordAlert(id, 1);

		m.subs.updateSubscription(id, { ...base, label: 'Google AI Pro', amountMinor: 39_900 });

		// Fixing a typo must not re-nag about a decision already surfaced.
		expect(m.subs.getSubscription(id)!.alertStage).toBe(1);
		expect(m.subs.getSubscription(id)!.label).toBe('Google AI Pro');
		expect(m.subs.getSubscription(id)!.amountMinor).toBe(39_900);
	});

	it('drops the deadline and the alerts when marked non-negotiable', () => {
		const id = m.subs.createSubscription(base);
		m.subs.updateSubscription(id, { ...base, cancelByOn: null, isEssential: true });

		const sub = m.subs.getSubscription(id)!;
		expect(sub.isEssential).toBe(1);
		expect(sub.cancelByOn).toBeNull();
		expect(m.subs.pendingAlerts('2027-08-01')).toEqual([]);
		// And it leaves the cull, which only hunts what can be cancelled.
		expect(m.subs.cullList('2027-08-01')).toEqual([]);
	});

	it('changes what the split reserves', () => {
		const id = m.subs.createSubscription({ ...base, trialEndsOn: null, amountMinor: 75_000 });
		expect(m.subs.commitmentsPerPeriod(7, '2026-08-24')).toBe(17_248);

		m.subs.updateSubscription(id, { ...base, trialEndsOn: null, amountMinor: 150_000 });
		expect(m.subs.commitmentsPerPeriod(7, '2026-08-24')).toBe(34_497);
	});

	it('restores something ended by mistake', () => {
		const id = m.subs.createSubscription({ ...base, trialEndsOn: null });
		m.subs.cancelSubscription(id);
		expect(m.subs.listSubscriptions()).toHaveLength(0);

		m.subs.restoreSubscription(id);
		expect(m.subs.listSubscriptions()).toHaveLength(1);
		expect(m.subs.getSubscription(id)!.cancelledAt).toBeNull();
	});

	it('ignores an edit to a row that does not exist', () => {
		expect(() => m.subs.updateSubscription(9999, base)).not.toThrow();
	});
});

describe('the Today horizon', () => {
	it('withholds the amount — Spec §4.2 applies to this surface too', () => {
		m.subs.createSubscription(GOOGLE);
		const h = m.subs.subscriptionHorizon('2027-08-01')!;

		expect(h.daysLeft).toBe(22);
		expect(h.isTrial).toBe(true);
		// A price on the daily surface is a balance wearing a hat.
		expect(Object.keys(h)).not.toContain('amountMinor');
	});

	it('shows nothing while the deadline is still far out', () => {
		m.subs.createSubscription(GOOGLE);
		expect(m.subs.subscriptionHorizon('2026-08-23')).toBeNull();
	});

	it('picks the most urgent deadline when several are live', () => {
		m.subs.createSubscription({ ...GOOGLE, label: 'far', cancelByOn: '2027-08-20' });
		m.subs.createSubscription({ ...GOOGLE, label: 'near', cancelByOn: '2027-08-05' });
		expect(m.subs.subscriptionHorizon('2027-08-01')!.label).toBe('near');
	});
});
