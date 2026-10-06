/**
 * Period rollover (Spec §4.1 stages 3 and 7).
 *
 * A period is an immutable allocation snapshot. Rollover never edits one: it
 * closes the finished period, records the swept surplus, and inserts the next.
 *
 * ─── What Phase 2 deliberately does NOT do ───────────────────────────────
 * It does not compute the next allocation. The full stage-1 path — project
 * every active income source onto a real calendar, resolve the split, detect
 * the three-paycheck month — needs income sources, which are Phase 3. So the
 * next period carries forward the closed period's allocation and day count
 * verbatim.
 *
 * That is not a placeholder for convenience; it is the only honest option. The
 * alternative, inventing a monthly figure by dividing an annual one, is the
 * exact bug Spec §12 tells you to treat as a defect on sight: bi-weekly is 26
 * arrivals a year, not 24. Carrying forward is boring and correct, and it also
 * means the daily number cannot swing at rollover, so the >25% confirmation
 * gate has nothing to fire on until Phase 3 gives it real inputs.
 */

import { and, desc, eq, gt, isNull, lt, lte, gte, or, sql } from 'drizzle-orm';
import { forUser, schema } from './db';
import { dailyAllowance } from '$lib/allowance';
import { addDays } from './clock';
import type { Period, Settings } from './db/schema';

export interface RolloverResult {
	closed: { id: number; sweptMinor: number }[];
	opened: { id: number; startsOn: string; endsOn: string }[];
}

/** Guard against an unbounded insert loop if a date is nonsense. */
const MAX_PERIODS_PER_RUN = 400;

export function runRollover(
	userId: number,
	today: string,
	settings: Settings,
	now: Date = new Date()
): RolloverResult {
	const { db, owns } = forUser(userId);
	const result: RolloverResult = { closed: [], opened: [] };

	const due = db
		.select()
		.from(schema.period)
		.where(and(owns(schema.period), isNull(schema.period.closedAt), lt(schema.period.endsOn, today)))
		.orderBy(schema.period.startsOn)
		.all();

	for (const p of due) result.closed.push(closePeriod(userId, p, now));

	// Nothing to roll into if a period already covers today, or if none exists
	// at all — a first period is created by hand (Spec §13 Phase 1).
	let last = latestPeriod(userId);
	if (!last) return result;

	for (let i = 0; i < MAX_PERIODS_PER_RUN && last.endsOn < today; i++) {
		last = openNext(userId, last, settings, now);
		result.opened.push({ id: last.id, startsOn: last.startsOn, endsOn: last.endsOn });

		// Catching up after the server was off for a fortnight materialises
		// periods whose windows have already passed. Those are history, not the
		// open period: close each one as it is created, so its sweep is recorded
		// and the next run has nothing left to do. Leaving them open makes
		// rollover non-idempotent, which is the one property Spec §3 requires of
		// it — a home server reboots and a tick gets missed.
		if (last.endsOn < today) result.closed.push(closePeriod(userId, last, now));
	}

	return result;
}

/**
 * Close one period and record the sweep.
 *
 * The surplus is what the 15% haircut quietly accumulated (F5) plus whatever
 * was simply not spent. Method Part III sends it to Irregulars. Phase 2
 * *records* it; the actual transfer is a line on the Money Map's checklist in
 * Phase 3, because this app never claims to have moved money it cannot see.
 */
export function closePeriod(
	userId: number,
	p: Period,
	now: Date = new Date()
): { id: number; sweptMinor: number } {
	const { db, owns } = forUser(userId);
	// A sweep is a claim that real money was left over. If nothing was logged
	// anywhere in the period's range, "spent" reads as zero for lack of a
	// record, not because it was a frugal week — sweeping the full allocation
	// would queue a transfer of money that may never have existed (Spec §4.1).
	// A catch-up row with entry_count = 0 is the owner affirming "nothing was
	// spent that day"; that IS data, so it does not make the period a gap.
	const logged =
		db
			.select({ n: sql<number>`count(*)` })
			.from(schema.logDay)
			.where(
				and(
					owns(schema.logDay),
					gte(schema.logDay.loggedOn, p.startsOn),
					lte(schema.logDay.loggedOn, p.endsOn),
					or(gt(schema.logDay.entryCount, 0), eq(schema.logDay.isCatchup, 1))
				)
			)
			.get()?.n ?? 0;

	if (logged === 0) {
		db.update(schema.period)
			.set({ closedAt: now.toISOString(), sweptMinor: 0, isGap: 1 })
			.where(and(owns(schema.period), eq(schema.period.id, p.id)))
			.run();

		return { id: p.id, sweptMinor: 0 };
	}

	const spent =
		db
			.select({
				n: sql<number>`coalesce(sum(case when ${schema.txn.refundOf} is not null then -${schema.txn.amountMinor} else ${schema.txn.amountMinor} end), 0)`
			})
			.from(schema.txn)
			.where(and(owns(schema.txn), eq(schema.txn.periodId, p.id)))
			.get()?.n ?? 0;

	const sweptMinor = Math.max(0, p.spendAllocMinor - spent);

	db.update(schema.period)
		.set({ closedAt: now.toISOString(), sweptMinor })
		.where(and(owns(schema.period), eq(schema.period.id, p.id)))
		.run();

	return { id: p.id, sweptMinor };
}

function openNext(userId: number, prev: Period, settings: Settings, now: Date): Period {
	const { db, owns } = forUser(userId);
	const startsOn = addDays(prev.endsOn, 1);
	const endsOn = addDays(startsOn, prev.days - 1);

	// Recomputed from the CURRENT haircut, then frozen. Nothing else in the
	// app may write daily_allowance_minor (Spec §12).
	const allowance = dailyAllowance(
		{ spendAllocMinor: prev.spendAllocMinor, days: prev.days },
		settings.haircutPct
	);

	const id = db
		.insert(schema.period)
		.values({
			startsOn,
			endsOn,
			days: prev.days,
			spendAllocMinor: prev.spendAllocMinor,
			dailyAllowanceMinor: allowance,
			haircutPctApplied: settings.haircutPct,
			phaseAtOpen: settings.phase,
			createdAt: now.toISOString(),
			userId
		})
		.returning({ id: schema.period.id })
		.get().id;

	return db
		.select()
		.from(schema.period)
		.where(and(owns(schema.period), eq(schema.period.id, id)))
		.get()!;
}

function latestPeriod(userId: number): Period | null {
	const { db, owns } = forUser(userId);
	return (
		db
			.select()
			.from(schema.period)
			.where(owns(schema.period))
			.orderBy(desc(schema.period.endsOn))
			.limit(1)
			.get() ?? null
	);
}

/**
 * Supersede the open period with a new allocation (review step R5).
 *
 * Mid-period adjustment is a documented anti-overspend intervention — a budget
 * you are allowed to update is a budget you do not abandon (F5). It still
 * never mutates the old row.
 */
export function supersedePeriod(
	userId: number,
	current: Period,
	spendAllocMinor: number,
	settings: Settings,
	now: Date = new Date()
): Period {
	const { db, owns } = forUser(userId);
	const allowance = dailyAllowance({ spendAllocMinor, days: current.days }, settings.haircutPct);

	return db.transaction((tx) => {
		tx.update(schema.period)
			.set({ closedAt: now.toISOString() })
			.where(and(owns(schema.period), eq(schema.period.id, current.id)))
			.run();

		const id = tx
			.insert(schema.period)
			.values({
				startsOn: current.startsOn,
				endsOn: current.endsOn,
				days: current.days,
				spendAllocMinor,
				dailyAllowanceMinor: allowance,
				haircutPctApplied: settings.haircutPct,
				phaseAtOpen: settings.phase,
				supersedesId: current.id,
				createdAt: now.toISOString(),
				userId
			})
			.returning({ id: schema.period.id })
			.get().id;

		return tx
			.select()
			.from(schema.period)
			.where(and(owns(schema.period), eq(schema.period.id, id)))
			.get()!;
	});
}

/** The open, non-superseded period covering `date`. */
export function openPeriodOn(userId: number, date: string): Period | null {
	const { db, owns } = forUser(userId);
	return (
		db
			.select()
			.from(schema.period)
			.where(
				and(
					owns(schema.period),
					isNull(schema.period.closedAt),
					lte(schema.period.startsOn, date),
					gte(schema.period.endsOn, date)
				)
			)
			.orderBy(desc(schema.period.id))
			.get() ?? null
	);
}
