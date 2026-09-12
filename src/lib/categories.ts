/**
 * Eight categories. Fixed, not user-editable (Method Part II).
 *
 * Making them editable is how you end up with forty, and finer categories are
 * the one intervention that measurably backfired (F5). They exist for the
 * weekly review, not for the daily log, and there is no per-category budget
 * anywhere in this app.
 */

export const CATEGORIES = [
	// Labelled for what they mean, not for the spec's shorthand. "Food-in" and
	// "Food-out" mean eaten in versus eaten out, but they read as money in
	// versus money out — which is exactly the wrong question to raise in an app
	// that cannot record income at all. The keys stay as the spec names them.
	{ key: 'food_in', label: 'Groceries' },
	{ key: 'food_out', label: 'Eating out' },
	{ key: 'transport', label: 'Transport' },
	{ key: 'study_work', label: 'Study/Work' },
	{ key: 'health', label: 'Health' },
	{ key: 'social', label: 'Social' },
	{ key: 'stuff', label: 'Stuff' },
	{ key: 'other', label: 'Other' }
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]['key'];

const KEYS: readonly string[] = CATEGORIES.map((c) => c.key);

export function isCategory(value: unknown): value is CategoryKey {
	return typeof value === 'string' && KEYS.includes(value);
}

export function categoryLabel(key: CategoryKey): string {
	return CATEGORIES.find((c) => c.key === key)!.label;
}
