/**
 * The weekly money date (Spec §8.2, Method Part III).
 *
 * Six steps, fifteen minutes, one screen per step, resumable. The row it
 * writes is the artefact: Harkin et al.'s meta-analysis (138 RCTs, 19,951
 * participants) found monitoring goal progress improved attainment at d = 0.40,
 * and the effect was *larger* when progress was physically recorded and when it
 * was reported to someone. Both moderators are in this file — the row, and
 * `shared_at`.
 */

import { and, desc, eq, lt } from 'drizzle-orm';
import { forUser, schema } from './db';
import { formatMoney } from '$lib/money';
import { bufferWeeksX100, logAdherenceBp, weekActuals } from './metrics';
import { computeStreak } from './streak';
import { coverage } from './irregulars';
import { weekOf, type Week } from './week';
import { addDays } from './clock';
import type { Review, Settings } from './db/schema';

export const REVIEW_STEPS = [
	{ key: 'balances', title: 'Balances' },
	{ key: 'actuals', title: 'This week' },
	{ key: 'top_three', title: 'Top three' },
	{ key: 'week_ahead', title: 'Coming up' },
	{ key: 'adjust', title: 'Next week' },
	{ key: 'send', title: 'Finish' }
] as const;

export type StepKey = (typeof REVIEW_STEPS)[number]['key'];

export function isStepKey(v: unknown): v is StepKey {
	return typeof v === 'string' && REVIEW_STEPS.some((s) => s.key === v);
}

/** Get or create the weekly review row. Created open; R6 completes it. */
export function ensureWeeklyReview(userId: number, week: Week, now: Date = new Date()): Review {
	const { db, owns } = forUser(userId);
	const existing = db
		.select()
		.from(schema.review)
		.where(
			and(owns(schema.review), eq(schema.review.kind, 'weekly'), eq(schema.review.periodLabel, week.label))
		)
		.get();
	if (existing) return existing;

	db.insert(schema.review)
		.values({
			kind: 'weekly',
			periodLabel: week.label,
			startsOn: week.startsOn,
			endsOn: week.endsOn,
			createdAt: now.toISOString(),
			userId
		})
		.onConflictDoNothing()
		.run();

	return db
		.select()
		.from(schema.review)
		.where(
			and(owns(schema.review), eq(schema.review.kind, 'weekly'), eq(schema.review.periodLabel, week.label))
		)
		.get()!;
}

export function reviewByLabel(userId: number, label: string): Review | null {
	const { db, owns } = forUser(userId);
	return (
		db
			.select()
			.from(schema.review)
			.where(and(owns(schema.review), eq(schema.review.kind, 'weekly'), eq(schema.review.periodLabel, label)))
			.get() ?? null
	);
}

/** The review immediately before this one — the source of R1's ghost values. */
export function priorReview(userId: number, review: Review): Review | null {
	const { db, owns } = forUser(userId);
	return (
		db
			.select()
			.from(schema.review)
			.where(
				and(owns(schema.review), eq(schema.review.kind, 'weekly'), lt(schema.review.endsOn, review.endsOn))
			)
			.orderBy(desc(schema.review.endsOn))
			.limit(1)
			.get() ?? null
	);
}

export function stepPayloads(userId: number, reviewId: number): Record<string, unknown> {
	const { db, owns } = forUser(userId);
	const out: Record<string, unknown> = {};
	for (const row of db
		.select()
		.from(schema.reviewStep)
		.where(and(owns(schema.reviewStep), eq(schema.reviewStep.reviewId, reviewId)))
		.all()) {
		if (row.doneAt) out[row.stepKey] = row.payload ? JSON.parse(row.payload) : true;
	}
	return out;
}

export function saveStep(
	userId: number,
	reviewId: number,
	stepKey: StepKey,
	payload: unknown,
	now: Date = new Date()
): void {
	const { db } = forUser(userId);
	const values = {
		reviewId,
		stepKey,
		doneAt: now.toISOString(),
		payload: payload === undefined ? null : JSON.stringify(payload)
	};
	db.insert(schema.reviewStep)
		.values({ ...values, userId })
		.onConflictDoUpdate({
			target: [schema.reviewStep.reviewId, schema.reviewStep.stepKey],
			set: { doneAt: values.doneAt, payload: values.payload }
		})
		.run();
}

/** R1's four asserted balances. Typing them is the intervention (F7). */
export function saveBalances(
	userId: number,
	reviewId: number,
	b: {
		spendBalanceMinor: number | null;
		irregularsMinor: number | null;
		bufferMinor: number | null;
		debtTotalMinor: number | null;
	}
): void {
	const { db, owns } = forUser(userId);
	db.update(schema.review)
		.set(b)
		.where(and(owns(schema.review), eq(schema.review.id, reviewId)))
		.run();
}

/**
 * R6. Snapshots the metrics, writes the one-liner, closes the row.
 *
 * Save rate stays null: it needs income rows, which Spec §13's roadmap never
 * assigns to a phase. A fabricated metric is worse than a missing one — the
 * whole point of the artefact is that it is true.
 */
export function completeReview(
	userId: number,
	review: Review,
	settings: Settings,
	now: Date = new Date()
): Review {
	const { db, owns } = forUser(userId);
	const range = { from: review.startsOn, to: review.endsOn };
	const actuals = weekActuals(userId, range);

	const loggedDays = db
		.select({ loggedOn: schema.logDay.loggedOn })
		.from(schema.logDay)
		.where(owns(schema.logDay))
		.all()
		.map((r) => r.loggedOn);
	const streak = computeStreak(loggedDays, review.endsOn);

	const snapshot = {
		completedAt: now.toISOString(),
		totalSpentMinor: actuals.totalMinor,
		unplannedRatioBp: actuals.unplannedRatioBp,
		bufferWeeksX100: bufferWeeksX100(review.bufferMinor, settings.weeklyTakeHomeMinor),
		// Below 1.0 this is the leading indicator that Buffer is about to be
		// raided, which is why it is snapshotted rather than merely displayed.
		coverageRatioBp: coverage(userId, review.endsOn).ratioBp,
		logAdherenceBp: logAdherenceBp(userId, range),
		streakAtClose: streak.current,
		summaryLine: ''
	};

	snapshot.summaryLine = summaryLine({ ...review, ...snapshot }, settings);
	db.update(schema.review)
		.set(snapshot)
		.where(and(owns(schema.review), eq(schema.review.id, review.id)))
		.run();

	return db
		.select()
		.from(schema.review)
		.where(and(owns(schema.review), eq(schema.review.id, review.id)))
		.get()!;
}

export function markShared(userId: number, reviewId: number, now: Date = new Date()): void {
	const { db, owns } = forUser(userId);
	db.update(schema.review)
		.set({ sharedAt: now.toISOString() })
		.where(and(owns(schema.review), eq(schema.review.id, reviewId)))
		.run();
}

/**
 * The one line you send to one other human (Method Part III step 6).
 *
 *   "Week 33: spent ₱3,240 · unplanned 22% · buffer 3.1 weeks · streak 23"
 *
 * Parts with no honest value are omitted rather than shown as zero.
 */
export function summaryLine(review: Review, settings: Settings): string {
	const money = (m: number) =>
		formatMoney(m, { minorUnits: settings.minorUnits, symbol: settings.currencySymbol }).replace(
			/\.00$/,
			''
		);

	const parts: string[] = [];
	if (review.totalSpentMinor !== null) parts.push(`spent ${money(review.totalSpentMinor)}`);
	if (review.unplannedRatioBp !== null)
		parts.push(`unplanned ${Math.round(review.unplannedRatioBp / 100)}%`);
	if (review.bufferWeeksX100 !== null)
		parts.push(`buffer ${(review.bufferWeeksX100 / 100).toFixed(1)} weeks`);
	if (review.streakAtClose !== null) parts.push(`streak ${review.streakAtClose}`);

	const week = Number(review.periodLabel.slice(-2));
	return `Week ${week}: ${parts.join(' · ')}`;
}

/** Deltas against the prior review — the "is this moving" half of the artefact. */
export function deltaVsPrior(review: Review, prior: Review | null) {
	if (!prior) return null;
	const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
	return {
		totalSpentMinor: delta(review.totalSpentMinor, prior.totalSpentMinor),
		unplannedRatioBp: delta(review.unplannedRatioBp, prior.unplannedRatioBp),
		bufferWeeksX100: delta(review.bufferWeeksX100, prior.bufferWeeksX100)
	};
}

/**
 * Is a weekly review outstanding? True once the week has finished and no
 * completed row exists for it.
 */
export function weeklyReviewDue(userId: number, today: string, weekStartsOn: number): Week | null {
	const week = weekOf(addDays(weekOf(today, weekStartsOn).startsOn, -1), weekStartsOn);
	const existing = reviewByLabel(userId, week.label);
	return existing?.completedAt ? null : week;
}
