/**
 * The irregulars engine (Spec §4.3, §6.2).
 *
 * The only subsystem with non-trivial logic, and the one that determines
 * whether the system survives year two.
 *
 * Two biases stack here. People underestimate weekly spending by roughly 30%;
 * worse, Sussman & Alter's "The Exception Is the Rule" shows people
 * systematically exclude *exceptional* costs — the wedding gift, the laptop
 * charger, the surprise fee — from their mental budget precisely because each
 * one feels like a one-off, while in aggregate they are perfectly predictable
 * (F10). So this engine does three things: it holds an event-by-event list
 * rather than a monthly average, it pads every estimate by 25%, and it accrues
 * the money before the cost lands.
 */

import { and, asc, desc, eq, gte, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { forUser, schema, type Scope } from './db';
import { addDays, daysBetween } from './clock';
import type { Irregular, IrregularInstance } from './db/schema';

/** How far forward instances are materialised. */
export const HORIZON_MONTHS = 24;

export type Cadence = Irregular['cadence'];

/** The amount actually accrued: the estimate plus its mandatory padding (F10). */
export function paddedAmount(amountMinor: number, paddingPct: number): number {
	return Math.round((amountMinor * (100 + paddingPct)) / 100);
}

/**
 * Default padding on creation, by how often the cost is observed (Spec
 * §5.3). Consulted only when a new irregular is created with no explicit
 * padding of its own — the column keeps its existing meaning, and no
 * existing row is ever rewritten to match a new default.
 *
 * This deliberately overrides `migrations/0003_phase3.sql`'s "Not negotiable
 * downward" for the DEFAULT only. That comment guards against underestimating
 * a cost you rarely see — F10's finding is specifically about costs that feel
 * like one-offs — and a weekly cost is observed 52 times a year, with none of
 * that bias. Recorded as an owner decision in Spec §2.2, not something to
 * re-litigate per irregular.
 */
export const DEFAULT_PADDING_PCT: Record<Cadence, number> = {
	one_off: 25,
	weekly: 5,
	fortnightly: 10,
	monthly: 15,
	quarterly: 20,
	semiannual: 25,
	annual: 25,
	every_n_years: 25
};

/**
 * An irregular's cadence acquires a kind, same as a subscription's (Spec
 * §5.1): `one_off` has no step at all, weekly/fortnightly step in days, and
 * everything else steps in whole months. Day-based and month-based cadences
 * cannot share a divisor — that shared divisor is exactly how the old
 * fractional-month bug happened — so this returns which arithmetic applies
 * rather than a single number.
 */
function cadenceStep(
	cadence: Cadence,
	cadenceN: number | null
): { kind: 'days' | 'months'; n: number } | null {
	switch (cadence) {
		case 'one_off':
			return null;
		case 'weekly':
			return { kind: 'days', n: 7 };
		case 'fortnightly':
			return { kind: 'days', n: 14 };
		case 'monthly':
			return { kind: 'months', n: 1 };
		case 'quarterly':
			return { kind: 'months', n: 3 };
		case 'semiannual':
			return { kind: 'months', n: 6 };
		case 'annual':
			return { kind: 'months', n: 12 };
		case 'every_n_years':
			return { kind: 'months', n: 12 * Math.max(1, cadenceN ?? 1) };
	}
}

/**
 * Project an irregular's due dates forward from `from`.
 *
 * Month arithmetic clamps to the end of short months: an annual cost due on
 * the 31st recurs on the 28th in February rather than silently rolling into
 * March, which would move the cost into the wrong accrual window. A weekly or
 * fortnightly cadence never goes near month arithmetic at all — it advances
 * with `addDays`, so a due date lands on the same day of the week forever,
 * unaffected by month length or a leap year's extra day.
 */
export function projectDueDates(
	irregular: Pick<Irregular, 'cadence' | 'cadenceN' | 'nextDueOn'>,
	from: string,
	to: string
): string[] {
	const step = cadenceStep(irregular.cadence, irregular.cadenceN);
	if (step === null) {
		return irregular.nextDueOn >= from && irregular.nextDueOn <= to ? [irregular.nextDueOn] : [];
	}

	const out: string[] = [];
	// Bounded: 24 months of a monthly cadence is 24 dates, and the 24-month
	// horizon at the shortest (weekly) cadence is ~104 dates — well inside
	// 400. The guard is for a nonsense cadence_n, not for normal data.
	for (let i = 0; i < 400; i++) {
		const due =
			step.kind === 'days'
				? addDays(irregular.nextDueOn, step.n * i)
				: addMonths(irregular.nextDueOn, step.n * i);
		if (due > to) break;
		if (due >= from) out.push(due);
	}
	return out;
}

/** Add whole months to a 'YYYY-MM-DD', clamping to the target month's length. */
export function addMonths(isoDate: string, months: number): string {
	const [y, m, d] = isoDate.split('-').map(Number);
	const target = new Date(Date.UTC(y, m - 1 + months, 1));
	const lastDay = new Date(
		Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
	).getUTCDate();
	const day = Math.min(d, lastDay);
	return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Materialise instances 24 months forward. Idempotent on
 * `(irregular_id, due_on)`, so the nightly job can run twice or be missed.
 *
 * Only `projected` rows are refreshed. A settled or skipped instance is
 * history and is never rewritten by a projection.
 */
export function materialise(userId: number, today: string, now: Date = new Date()): number {
	const { db, owns } = forUser(userId);
	const horizon = addMonths(today, HORIZON_MONTHS);
	const live = db
		.select()
		.from(schema.irregular)
		.where(and(owns(schema.irregular), isNull(schema.irregular.archivedAt)))
		.all();

	// Project from the irregular's own next due date when that is already in the
	// past, not from today. Declaring a cost that was due last week must still
	// materialise that instance, or it can never appear in the reconciliation
	// queue — and an obligation the app cannot see is exactly the silent drift
	// Spec §4.3 says kills the system. Clamped to a year back so a long-stale
	// definition does not generate a decade of history on first run.
	const floor = addMonths(today, -12);

	let written = 0;
	for (const irr of live) {
		const expected = paddedAmount(irr.amountMinor, irr.paddingPct);
		const from = irr.nextDueOn < today ? (irr.nextDueOn < floor ? floor : irr.nextDueOn) : today;

		for (const dueOn of projectDueDates(irr, from, horizon)) {
			const result = db
				.insert(schema.irregularInstance)
				.values({
					irregularId: irr.id,
					dueOn,
					expectedMinor: expected,
					status: dueOn <= today ? 'due' : 'projected',
					userId
				})
				.onConflictDoNothing()
				.run();
			written += result.changes;
		}
	}

	// Anything projected whose date has arrived becomes due, so the
	// reconciliation prompt can find it.
	db.update(schema.irregularInstance)
		.set({ status: 'due' })
		.where(
			and(
				owns(schema.irregularInstance),
				eq(schema.irregularInstance.status, 'projected'),
				lte(schema.irregularInstance.dueOn, today)
			)
		)
		.run();

	void now;
	return written;
}

/**
 * Required accrual for one period (Spec §6.2).
 *
 * Recomputed each period rather than fixed at setup, so adding a large cost due
 * in two months automatically raises the next two periods' accrual instead of
 * quietly under-funding it.
 */
export function requiredAccrualPerPeriod(
	userId: number,
	today: string,
	daysPerPeriod: number
): number {
	const rows = unsettledDueBy(userId, today, addMonths(today, 12));
	let total = 0;
	for (const inst of rows) {
		const periodsLeft = Math.max(1, Math.ceil(daysBetween(today, inst.dueOn) / daysPerPeriod));
		total += inst.expectedMinor / periodsLeft;
	}
	return Math.round(total);
}

export interface Coverage {
	/** Basis points. Null when nothing is due in the window — not infinity, not zero. */
	ratioBp: number | null;
	balanceMinor: number;
	due90Minor: number;
	shortfallMinor: number;
	/** The instance that bounces first if the shortfall is not closed. */
	firstAtRisk: { label: string; dueOn: string; expectedMinor: number } | null;
}

/**
 * Coverage = irregulars balance ÷ everything due in the next 90 days.
 *
 * Below 1.0 is the leading indicator that Buffer is about to get raided, which
 * is why the Review screen leads with it rather than making it one tile among
 * twelve (Spec §4.3).
 */
export function coverage(userId: number, today: string): Coverage {
	const { db, owns } = forUser(userId);
	const balanceMinor =
		db
			.select({ n: schema.account.balanceMinor })
			.from(schema.account)
			.where(and(owns(schema.account), eq(schema.account.kind, 'irregulars')))
			.get()?.n ?? 0;

	const rows = unsettledDueBy(userId, today, addDays(today, 90));
	const due90Minor = rows.reduce((sum, r) => sum + r.expectedMinor, 0);

	if (due90Minor === 0) {
		return { ratioBp: null, balanceMinor, due90Minor: 0, shortfallMinor: 0, firstAtRisk: null };
	}

	// Which instance bounces first: walk the queue spending the balance down.
	let remaining = balanceMinor;
	let firstAtRisk: Coverage['firstAtRisk'] = null;
	for (const r of rows) {
		if (remaining < r.expectedMinor) {
			firstAtRisk = { label: r.label, dueOn: r.dueOn, expectedMinor: r.expectedMinor };
			break;
		}
		remaining -= r.expectedMinor;
	}

	return {
		ratioBp: Math.round((balanceMinor * 10_000) / due90Minor),
		balanceMinor,
		due90Minor,
		shortfallMinor: Math.max(0, due90Minor - balanceMinor),
		firstAtRisk
	};
}

export interface UpcomingInstance {
	id: number;
	irregularId: number;
	label: string;
	dueOn: string;
	expectedMinor: number;
	status: IrregularInstance['status'];
	category: string | null;
}

function unsettledDueBy(userId: number, from: string, to: string): UpcomingInstance[] {
	const { db, owns } = forUser(userId);
	return db
		.select({
			id: schema.irregularInstance.id,
			irregularId: schema.irregularInstance.irregularId,
			label: schema.irregular.label,
			dueOn: schema.irregularInstance.dueOn,
			expectedMinor: schema.irregularInstance.expectedMinor,
			status: schema.irregularInstance.status,
			category: schema.irregular.category
		})
		.from(schema.irregularInstance)
		.innerJoin(schema.irregular, eq(schema.irregular.id, schema.irregularInstance.irregularId))
		.where(
			and(
				owns(schema.irregularInstance),
				or(
					eq(schema.irregularInstance.status, 'projected'),
					eq(schema.irregularInstance.status, 'due')
				),
				gte(schema.irregularInstance.dueOn, from),
				lte(schema.irregularInstance.dueOn, to)
			)
		)
		.orderBy(asc(schema.irregularInstance.dueOn))
		.all();
}

/** Everything unsettled between two dates — the Upcoming table and R4's strip. */
export function upcoming(userId: number, from: string, to: string): UpcomingInstance[] {
	return unsettledDueBy(userId, from, to);
}

/**
 * Instances that came and went without being marked.
 *
 * This is the silent failure that kills the system: the user stops settling,
 * the ledger drifts from reality, and the app keeps reporting healthy coverage
 * while the real account is empty. The monthly ritual forces a three-way
 * choice on every one of these — paid, skipped, or rescheduled. There is no
 * dismiss (Spec §4.3).
 */
export function overdue(userId: number, today: string): UpcomingInstance[] {
	return unsettledDueBy(userId, '0000-01-01', addDays(today, -1));
}

/**
 * Mark an instance paid. Stores the actual separately from the estimate — the
 * delta is what feeds the annual re-estimate and is the honest measure of your
 * prediction bias.
 */
export function settleInstance(
	userId: number,
	instanceId: number,
	actualMinor: number,
	settledOn: string,
	now: Date = new Date()
): void {
	const { db, owns } = forUser(userId);
	db.transaction((tx) => {
		const inst = tx
			.select()
			.from(schema.irregularInstance)
			.where(and(owns(schema.irregularInstance), eq(schema.irregularInstance.id, instanceId)))
			.get();
		if (!inst) throw new Error(`No irregular instance ${instanceId}`);

		tx.update(schema.irregularInstance)
			.set({ status: 'settled', actualMinor, settledOn })
			.where(and(owns(schema.irregularInstance), eq(schema.irregularInstance.id, instanceId)))
			.run();

		// Drawdown: the money leaves Irregulars because the cost landed.
		tx.update(schema.account)
			.set({
				balanceMinor: sql`max(0, ${schema.account.balanceMinor} - ${actualMinor})`,
				balanceAsOf: settledOn
			})
			.where(and(owns(schema.account), eq(schema.account.kind, 'irregulars')))
			.run();

		advanceNextDue(userId, tx, inst.irregularId, inst.dueOn);
	});
	void now;
}

export function skipInstance(userId: number, instanceId: number): void {
	const { db, owns } = forUser(userId);
	db.transaction((tx) => {
		const inst = tx
			.select()
			.from(schema.irregularInstance)
			.where(and(owns(schema.irregularInstance), eq(schema.irregularInstance.id, instanceId)))
			.get();
		if (!inst) throw new Error(`No irregular instance ${instanceId}`);

		tx.update(schema.irregularInstance)
			.set({ status: 'skipped' })
			.where(and(owns(schema.irregularInstance), eq(schema.irregularInstance.id, instanceId)))
			.run();

		advanceNextDue(userId, tx, inst.irregularId, inst.dueOn);
	});
}

export function rescheduleInstance(userId: number, instanceId: number, dueOn: string): void {
	const { db, owns } = forUser(userId);
	db.update(schema.irregularInstance)
		.set({ dueOn, status: dueOn <= new Date().toISOString().slice(0, 10) ? 'due' : 'projected' })
		.where(and(owns(schema.irregularInstance), eq(schema.irregularInstance.id, instanceId)))
		.run();
}

/** A transaction handle from `db.transaction()` — same query surface, no `$client`. */
type Tx = Parameters<Parameters<Scope['db']['transaction']>[0]>[0];

/** Keep `irregular.next_due_on` pointing at the earliest live instance. */
function advanceNextDue(userId: number, tx: Tx, irregularId: number, settledDueOn: string): void {
	const { owns } = forUser(userId);
	const next = tx
		.select({ dueOn: schema.irregularInstance.dueOn })
		.from(schema.irregularInstance)
		.where(
			and(
				owns(schema.irregularInstance),
				eq(schema.irregularInstance.irregularId, irregularId),
				ne(schema.irregularInstance.status, 'settled'),
				ne(schema.irregularInstance.status, 'skipped')
			)
		)
		.orderBy(asc(schema.irregularInstance.dueOn))
		.get();

	if (next) {
		tx.update(schema.irregular)
			.set({ nextDueOn: next.dueOn })
			.where(and(owns(schema.irregular), eq(schema.irregular.id, irregularId)))
			.run();
		return;
	}

	// A one-off with nothing left is finished; a recurring one just needs its
	// next window materialised on the following nightly run.
	const irr = tx
		.select()
		.from(schema.irregular)
		.where(and(owns(schema.irregular), eq(schema.irregular.id, irregularId)))
		.get();
	if (irr?.cadence === 'one_off') {
		tx.update(schema.irregular)
			.set({ archivedAt: new Date().toISOString() })
			.where(and(owns(schema.irregular), eq(schema.irregular.id, irregularId)))
			.run();
	} else if (irr) {
		tx.update(schema.irregular)
			.set({ nextDueOn: addDays(settledDueOn, 1) })
			.where(and(owns(schema.irregular), eq(schema.irregular.id, irregularId)))
			.run();
	}
}

export interface MonthlyOutflow {
	month: string;
	expectedMinor: number;
}

/** Expected outflow per month for the next 12 — reveals the spikes you forget. */
export function monthlyOutflow(userId: number, today: string, months = 12): MonthlyOutflow[] {
	const rows = unsettledDueBy(userId, today, addMonths(today, months));
	const buckets = new Map<string, number>();
	for (let i = 0; i < months; i++) buckets.set(addMonths(today, i).slice(0, 7), 0);
	for (const r of rows) {
		const key = r.dueOn.slice(0, 7);
		if (buckets.has(key)) buckets.set(key, buckets.get(key)! + r.expectedMinor);
	}
	return [...buckets].map(([month, expectedMinor]) => ({ month, expectedMinor }));
}

export interface EstimateError {
	label: string;
	settledOn: string;
	expectedMinor: number;
	actualMinor: number;
}

/**
 * Expected versus actual per settled instance. This is your personal
 * calibration on F10, and the delta is the only honest way to know whether the
 * 25% padding is enough for *you*.
 */
export function estimateAccuracy(userId: number, sinceDate: string): EstimateError[] {
	const { db, owns } = forUser(userId);
	return db
		.select({
			label: schema.irregular.label,
			settledOn: schema.irregularInstance.settledOn,
			expectedMinor: schema.irregularInstance.expectedMinor,
			actualMinor: schema.irregularInstance.actualMinor
		})
		.from(schema.irregularInstance)
		.innerJoin(schema.irregular, eq(schema.irregular.id, schema.irregularInstance.irregularId))
		.where(
			and(
				owns(schema.irregularInstance),
				eq(schema.irregularInstance.status, 'settled'),
				gte(schema.irregularInstance.settledOn, sinceDate)
			)
		)
		.orderBy(desc(schema.irregularInstance.settledOn))
		.all()
		.filter((r): r is EstimateError => r.settledOn !== null && r.actualMinor !== null);
}
