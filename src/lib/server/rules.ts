/**
 * If-then plans and the 72-hour list (Spec §8.5, Rule 4, F8).
 *
 * Implementation intentions run at d = 0.65 — the largest effect size in the
 * whole plan, larger than monitoring, larger than financial education. The
 * format is what carries it: the cue must be a concrete detectable event and
 * the action must be specific and start within seconds of the cue.
 *
 * The rules ship pre-populated (migration 0004) because a blank rules page
 * gets zero rules written, and zero rules is zero effect.
 */

import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import { db, schema } from './db';
import type { Rule, WaitItem } from './db/schema';

/** Rule 4: wait this long before buying anything over the daily allowance. */
export const WAIT_HOURS = 72;

export const RULE_CATEGORIES = [
	{ key: 'adherence', label: 'Adherence' },
	{ key: 'overspend', label: 'Overspending' },
	{ key: 'structural', label: 'Structural' },
	{ key: 'social', label: 'Social' },
	{ key: 'travel', label: 'Travel' },
	{ key: 'motivation', label: 'Motivation' }
] as const;

export function listRules(): Rule[] {
	return db
		.select()
		.from(schema.rule)
		.orderBy(asc(schema.rule.sortOrder), asc(schema.rule.id))
		.all();
}

/**
 * Record that a rule fired. The count feeds the quarterly audit, where you read
 * which ones worked and rewrite the ones that did not — a rule that never fires
 * usually has a cue that is too vague to detect.
 */
export function fireRule(id: number, now: Date = new Date()): void {
	db.update(schema.rule)
		.set({
			firedCount: sql`${schema.rule.firedCount} + 1`,
			lastFired: now.toISOString()
		})
		.where(eq(schema.rule.id, id))
		.run();
}

export function upsertRule(
	r: { id?: number; cue: string; action: string; category: Rule['category'] },
	now: Date = new Date()
): void {
	void now;
	if (r.id) {
		db.update(schema.rule)
			.set({ cue: r.cue, action: r.action, category: r.category })
			.where(eq(schema.rule.id, r.id))
			.run();
		return;
	}
	db.insert(schema.rule)
		.values({ ...r, sortOrder: 99 })
		.run();
}

export function setRuleActive(id: number, active: boolean): void {
	db.update(schema.rule)
		.set({ active: active ? 1 : 0 })
		.where(eq(schema.rule.id, id))
		.run();
}

// ─── The 72-hour list ─────────────────────────────────────────────────────

export function addWaitItem(
	label: string,
	amountMinor: number | null,
	now: Date = new Date()
): void {
	db.insert(schema.waitItem)
		.values({
			label,
			amountMinor,
			addedAt: now.toISOString(),
			ripeAt: new Date(now.getTime() + WAIT_HOURS * 3_600_000).toISOString()
		})
		.run();
}

/** Items whose 72 hours are up and which are still unresolved. */
export function ripeItems(now: Date = new Date()): WaitItem[] {
	return db
		.select()
		.from(schema.waitItem)
		.where(and(isNull(schema.waitItem.resolvedAt), lte(schema.waitItem.ripeAt, now.toISOString())))
		.orderBy(asc(schema.waitItem.ripeAt))
		.all();
}

export function waitingItems(now: Date = new Date()): WaitItem[] {
	return db
		.select()
		.from(schema.waitItem)
		.where(
			and(isNull(schema.waitItem.resolvedAt), sql`${schema.waitItem.ripeAt} > ${now.toISOString()}`)
		)
		.orderBy(asc(schema.waitItem.ripeAt))
		.all();
}

export function resolvedItems(limit = 30): WaitItem[] {
	return db
		.select()
		.from(schema.waitItem)
		.where(sql`${schema.waitItem.resolvedAt} IS NOT NULL`)
		.orderBy(desc(schema.waitItem.resolvedAt))
		.limit(limit)
		.all();
}

export function resolveWaitItem(
	id: number,
	outcome: 'bought' | 'dropped',
	now: Date = new Date()
): void {
	db.update(schema.waitItem)
		.set({ outcome, resolvedAt: now.toISOString() })
		.where(eq(schema.waitItem.id, id))
		.run();
}

/**
 * The drop rate. Seeing "68% of items dropped" *is* the argument for the rule —
 * most things die on the list, and the ones that survive you buy guilt-free.
 */
export function dropRateBp(): number | null {
	const rows = db
		.select({ outcome: schema.waitItem.outcome })
		.from(schema.waitItem)
		.where(sql`${schema.waitItem.resolvedAt} IS NOT NULL`)
		.all();
	if (rows.length === 0) return null;

	const dropped = rows.filter((r) => r.outcome === 'dropped' || r.outcome === 'expired').length;
	return Math.round((dropped * 10_000) / rows.length);
}
