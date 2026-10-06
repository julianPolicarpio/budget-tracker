/**
 * Method Part VIII's metrics (Spec §6.4).
 *
 * Do not measure success by "did I stick to the budget". These five are real
 * behavioural quantities.
 *
 * ─── The shared selector ─────────────────────────────────────────────────
 * Every txn-based metric composes from `spendTxns()` and nothing else. That is
 * the whole point of it existing: in Phase 3 the trip quarantine
 * (`AND trip_id IS NULL`, Spec §4.5) is added HERE, once, and every metric
 * inherits it — including metrics written in month eight by someone who has
 * never read that section. Retrofitting it after the trends grid exists means
 * auditing every query and re-deriving historical numbers.
 *
 * Log adherence is the deliberate exception and does not use this selector:
 * trip days count normally, because the streak's job is to keep the app open.
 */

import { and, desc, gte, isNull, lte, sql } from 'drizzle-orm';
import { forUser, schema } from './db';
import { CATEGORIES, type CategoryKey } from '$lib/categories';
import { daysBetweenInclusive } from './clock';

export interface Range {
	from: string;
	to: string;
}

export interface CategoryTotal {
	key: CategoryKey;
	label: string;
	minor: number;
}

export interface WeekActuals {
	byCategory: CategoryTotal[];
	totalMinor: number;
	unplannedMinor: number;
	/** Basis points. Null when nothing was spent — a ratio of nothing is not zero. */
	unplannedRatioBp: number | null;
}

export interface TopTxn {
	id: number;
	amountMinor: number;
	category: CategoryKey;
	label: string;
	planned: boolean;
	spentOn: string;
}

/**
 * The one selector.
 *
 * `trip_id IS NULL` is here and nowhere else. It is a query-layer default, not
 * a display filter, so a metric added in month eight inherits the exclusion
 * instead of quietly reintroducing the smear. Two weeks abroad at four times
 * normal spend will otherwise flatten a twelve-week rolling average into
 * uselessness and make a working system look broken for a quarter (Spec §4.5).
 *
 * Trip spending is not uncounted — it is measured against its own envelope on
 * the Trips screen, and nowhere else.
 *
 * `owns(schema.txn)` lives here for the same reason as the trip quarantine: one
 * place callers cannot forget, rather than 61 places they must remember.
 */
function spendTxns(userId: number, range: Range) {
	const { owns } = forUser(userId);
	return and(
		owns(schema.txn),
		gte(schema.txn.spentOn, range.from),
		lte(schema.txn.spentOn, range.to),
		isNull(schema.txn.tripId)
	);
}

export function weekActuals(userId: number, range: Range): WeekActuals {
	const { db } = forUser(userId);
	const rows = db
		.select({
			category: schema.txn.category,
			planned: schema.txn.planned,
			minor: sql<number>`sum(case when ${schema.txn.refundOf} is not null then -${schema.txn.amountMinor} else ${schema.txn.amountMinor} end)`
		})
		.from(schema.txn)
		.where(spendTxns(userId, range))
		.groupBy(schema.txn.category, schema.txn.planned)
		.all();

	const totals = new Map<string, number>();
	let totalMinor = 0;
	let unplannedMinor = 0;

	for (const r of rows) {
		totals.set(r.category, (totals.get(r.category) ?? 0) + r.minor);
		totalMinor += r.minor;
		if (r.planned === 0) unplannedMinor += r.minor;
	}

	const byCategory = CATEGORIES.map((c) => ({
		key: c.key,
		label: c.label,
		minor: totals.get(c.key) ?? 0
	})).sort((a, b) => b.minor - a.minor);

	return {
		byCategory,
		totalMinor,
		unplannedMinor,
		unplannedRatioBp: totalMinor === 0 ? null : Math.round((unplannedMinor * 10_000) / totalMinor)
	};
}

/**
 * Review step R3. Not the total — the top three, one question each. Three
 * answers, no analysis paralysis (Method Part III).
 */
export function topThree(userId: number, range: Range): TopTxn[] {
	const { db } = forUser(userId);
	return db
		.select({
			id: schema.txn.id,
			amountMinor: schema.txn.amountMinor,
			category: schema.txn.category,
			planned: schema.txn.planned,
			spentOn: schema.txn.spentOn
		})
		.from(schema.txn)
		// Top *expenses*: refund rows are money back, not spending — netting
		// lives in the sums, but a ranking of rows must not rank them at all.
		.where(and(spendTxns(userId, range), isNull(schema.txn.refundOf)))
		.orderBy(desc(schema.txn.amountMinor))
		.limit(3)
		.all()
		.map((r) => ({
			id: r.id,
			amountMinor: r.amountMinor,
			category: r.category as CategoryKey,
			label: CATEGORIES.find((c) => c.key === r.category)?.label ?? r.category,
			planned: r.planned === 1,
			spentOn: r.spentOn
		}));
}

/** Days logged ÷ days in range, in basis points. Trip days count normally. */
export function logAdherenceBp(userId: number, range: Range): number {
	const { db, owns } = forUser(userId);
	const days = daysBetweenInclusive(range.from, range.to);
	if (days <= 0) return 0;
	const logged =
		db
			.select({ n: sql<number>`count(*)` })
			.from(schema.logDay)
			.where(
				and(
					owns(schema.logDay),
					gte(schema.logDay.loggedOn, range.from),
					lte(schema.logDay.loggedOn, range.to)
				)
			)
			.get()?.n ?? 0;
	return Math.round((logged * 10_000) / days);
}

/**
 * Buffer balance ÷ weekly take-home, ×100 (F14 — the target is 6.0, being 6.2
 * weeks of take-home, not six months). Null until take-home is asserted.
 */
export function bufferWeeksX100(
	bufferMinor: number | null,
	weeklyTakeHomeMinor: number | null
): number | null {
	if (bufferMinor === null || !weeklyTakeHomeMinor) return null;
	return Math.round((bufferMinor * 100) / weeklyTakeHomeMinor);
}
