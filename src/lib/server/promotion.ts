/**
 * Category promotion: eligibility and the promotion itself (Spec §5.9).
 *
 * A taught word starts as a label on the row. Once it has enough transactions
 * spread across enough distinct weeks, the weekly review offers to make it a
 * leaf. `eligiblePromotions()` answers "is a word eligible"; `promote()` does
 * the mutation — creating the `category_leaf` row and retroactively pointing
 * every past `txn` (and this user's `label_map` entry) at it. The review UI
 * that decides WHEN to call `promote()` ships with a later task; the function
 * itself is data-layer and belongs here, not deferred alongside the UI.
 */

import { isNull, isNotNull } from 'drizzle-orm';
import { and, eq } from 'drizzle-orm';
import { forUser, schema } from './db';
import { loadSettings } from './today';
import { weekOf } from './week';
import type { CategoryKey } from '$lib/categories';

/**
 * Chosen, not measured — see Spec §5.9. Kept as one constant so the shape
 * (spread across weeks, not a raw count) survives any future retuning.
 */
export const PROMOTION_THRESHOLD = { minTxns: 5, minWeeks: 3 } as const;

export interface EligibleWord {
	label: string;
	root: CategoryKey;
	txnCount: number;
	weekCount: number;
}

/**
 * Every `txn.label` with enough rows across enough distinct weeks (this
 * user's week, via `weekOf()` — not a raw ISO week) to offer promotion.
 *
 * Excludes trip rows (invariant 9: `AND trip_id IS NULL`, the shared
 * selector's own filter, not one this function must remember to add) and
 * rows already carrying a `leaf_id` (already promoted).
 */
export function eligiblePromotions(userId: number): EligibleWord[] {
	const settings = loadSettings(userId);
	if (!settings) return [];

	const { db, owns } = forUser(userId);
	const rows = db
		.select({
			label: schema.txn.label,
			category: schema.txn.category,
			spentOn: schema.txn.spentOn
		})
		.from(schema.txn)
		.where(
			and(
				owns(schema.txn),
				isNotNull(schema.txn.label),
				isNull(schema.txn.leafId),
				isNull(schema.txn.tripId)
			)
		)
		.all();

	const byLabel = new Map<string, { root: CategoryKey; count: number; weeks: Set<string> }>();
	for (const r of rows) {
		const label = r.label!;
		const entry = byLabel.get(label) ?? {
			root: r.category as CategoryKey,
			count: 0,
			weeks: new Set<string>()
		};
		entry.count += 1;
		entry.weeks.add(weekOf(r.spentOn, settings.weekStartsOn).startsOn);
		byLabel.set(label, entry);
	}

	const out: EligibleWord[] = [];
	for (const [label, entry] of byLabel) {
		if (entry.count >= PROMOTION_THRESHOLD.minTxns && entry.weeks.size >= PROMOTION_THRESHOLD.minWeeks) {
			out.push({ label, root: entry.root, txnCount: entry.count, weekCount: entry.weeks.size });
		}
	}
	return out;
}

/**
 * Promote a label to a leaf under `root`, named `leafName`.
 *
 * Retroactive by design (Spec §5.9): every past `txn` carrying this exact
 * `(label, root)` — still unpromoted — gains the new `leaf_id`, and this
 * user's `label_map` row for the word gains it too, so the NEXT transaction
 * using that word arrives with a leaf already attached, with no extra lookup
 * (see `LearnedEntry.leafId` in `entry-parser.ts`).
 *
 * Safe precisely because the root never changes: no root total moves, no
 * month-to-month comparison breaks, and rows only gain a pointer they lacked.
 * Idempotent on the `(user_id, root, name)` leaf — promoting the same label
 * twice reuses the existing leaf rather than erroring or duplicating it.
 *
 * Returns the leaf's id.
 */
export function promote(userId: number, label: string, root: CategoryKey, leafName: string, now: Date = new Date()): number {
	const { db, owns } = forUser(userId);

	return db.transaction((tx) => {
		const existing = tx
			.select()
			.from(schema.categoryLeaf)
			.where(and(owns(schema.categoryLeaf), eq(schema.categoryLeaf.root, root), eq(schema.categoryLeaf.name, leafName)))
			.get();

		const leafId =
			existing?.id ??
			tx
				.insert(schema.categoryLeaf)
				.values({ userId, root, name: leafName, createdAt: now.toISOString() })
				.returning({ id: schema.categoryLeaf.id })
				.get().id;

		// Every past row this label described. `category` (the root) is part
		// of the match on purpose: the same English label is not guaranteed
		// unique across roots, and a leaf belongs to exactly one root.
		tx.update(schema.txn)
			.set({ leafId })
			.where(
				and(
					owns(schema.txn),
					eq(schema.txn.label, label),
					eq(schema.txn.category, root),
					isNull(schema.txn.leafId)
				)
			)
			.run();

		// So the word's next transaction arrives pre-attached to the leaf.
		tx.update(schema.labelMap)
			.set({ leafId })
			.where(and(owns(schema.labelMap), eq(schema.labelMap.english, label), eq(schema.labelMap.root, root)))
			.run();

		return leafId;
	});
}
