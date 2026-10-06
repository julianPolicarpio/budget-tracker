/**
 * `/settings` — the knobs (Task 4 of the first-run-setup plan), plus the
 * spending-budget section (owner decision: budget lives in Settings, not
 * buried in the weekly-review wizard).
 *
 * Two actions, two separate mechanisms, and neither may touch the other's
 * territory:
 *  - `save` writes the settings row via `updateSettings()`. It never touches
 *    a period (invariant 6) — a knob change takes effect at the NEXT period
 *    open, not the one already in progress.
 *  - `setBudget` supersedes the OPEN period via `supersedePeriod()`
 *    (src/lib/server/rollover.ts) — the only mechanism that opens a
 *    superseding period. It never mutates settings and never touches a
 *    historical (closed) period.
 *
 * `satisfies` rather than a `: PageServerLoad` annotation, matching
 * `/setup`'s `+page.server.ts` — the annotation would widen the exported
 * binding, and this route's own test imports the module directly and calls
 * `load()` itself, so it needs the literal (unwidened) return type.
 */
import { fail, type Actions } from '@sveltejs/kit';
import { loadSettings } from '$lib/server/today';
import { openPeriodOn, supersedePeriod } from '$lib/server/rollover';
import { localToday } from '$lib/server/clock';
import { updateSettings, type SettingsPatch } from '$lib/server/settings-write';
import { displayBand } from '$lib/allowance';
import { parseMoney } from '$lib/money';
import type { PageServerLoad } from './$types';

const PERIOD_KINDS = ['weekly', 'semimonthly', 'monthly'] as const;

export const load = (({ locals }) => {
	const settings = loadSettings(locals.userId);
	if (!settings) return { ready: false as const };

	const today = localToday(settings.timezone);
	const period = openPeriodOn(locals.userId, today);

	return {
		ready: true as const,
		settings: {
			timezone: settings.timezone,
			currencyCode: settings.currencyCode,
			currencySymbol: settings.currencySymbol,
			minorUnits: settings.minorUnits,
			roundingStep: settings.roundingStep,
			periodKind: settings.periodKind,
			weekStartsOn: settings.weekStartsOn,
			haircutPct: settings.haircutPct,
			bandPct: settings.bandPct
		},
		period: period
			? {
					startsOn: period.startsOn,
					endsOn: period.endsOn,
					days: period.days,
					spendAllocMinor: period.spendAllocMinor,
					dailyAllowanceMinor: period.dailyAllowanceMinor
				}
			: null,
		// Reuses the exact helper Today builds its band from — never a
		// hand-rolled percentage.
		band: period
			? displayBand(period.dailyAllowanceMinor, {
					bandPct: settings.bandPct,
					roundingStep: settings.roundingStep
				})
			: null
	};
}) satisfies PageServerLoad;

export const actions: Actions = {
	/**
	 * The knobs. `updateSettings()` is the only writer and it never touches
	 * `period` (invariant 6) — verified by settings-write.test.ts.
	 */
	save: async ({ request, locals }) => {
		// `entered` and `field` carry the same shape on every branch below —
		// not just the fail() calls — matching `/setup`'s convention (see its
		// own comment) so `form?.entered?.x` stays valid against every member
		// of the ActionData union without TypeScript losing the key on the
		// branches that have nothing to echo.
		const empty = {
			timezone: '',
			currencyCode: '',
			currencySymbol: '',
			minorUnits: '',
			roundingStep: '',
			periodKind: '',
			weekStartsOn: '',
			haircutPct: '',
			bandPct: ''
		};

		const settings = loadSettings(locals.userId);
		if (!settings) {
			return fail(409, {
				field: null,
				error: 'This account is not provisioned.',
				saved: false,
				entered: empty
			});
		}

		const form = await request.formData();
		const num = (k: string) => Number(form.get(k) ?? NaN);

		const periodKind = String(form.get('periodKind') ?? '') as (typeof PERIOD_KINDS)[number];
		const timezone = String(form.get('timezone') ?? '').trim();
		const currencyCode = String(form.get('currencyCode') ?? '')
			.trim()
			.toUpperCase();
		const currencySymbol = String(form.get('currencySymbol') ?? '').trim();

		// Echoed back on failure so a rejected save loses nothing the user
		// typed (Spec A2: "validation errors retain entered values").
		const entered = {
			timezone,
			currencyCode,
			currencySymbol,
			minorUnits: String(form.get('minorUnits') ?? ''),
			roundingStep: String(form.get('roundingStep') ?? ''),
			periodKind,
			weekStartsOn: String(form.get('weekStartsOn') ?? ''),
			haircutPct: String(form.get('haircutPct') ?? ''),
			bandPct: String(form.get('bandPct') ?? '')
		};

		const patch: SettingsPatch = {
			timezone,
			currencyCode,
			currencySymbol,
			minorUnits: num('minorUnits'),
			roundingStep: num('roundingStep'),
			periodKind,
			weekStartsOn: num('weekStartsOn'),
			haircutPct: num('haircutPct'),
			bandPct: num('bandPct')
		};

		try {
			updateSettings(locals.userId, patch);
		} catch (err) {
			return fail(400, {
				field: null,
				error: err instanceof Error ? err.message : 'Could not save.',
				saved: false,
				entered
			});
		}

		return { saved: true, field: null, error: null, entered };
	},

	/**
	 * The spending budget (Deliverable 2 — this is not part of Task 4's plan).
	 * `supersedePeriod()` is the ONLY path to a new allocation for an open
	 * period; this action never writes a period row itself and never touches
	 * `txn`. A3.3: superseding never rewrites historical transactions and
	 * never creates cash.
	 */
	setBudget: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { budgetField: null, budgetError: 'This account is not provisioned.', budgetRaw: '' });

		const form = await request.formData();
		const raw = String(form.get('amount') ?? '');
		const amountMinor = parseMoney(raw, settings.minorUnits);

		if (amountMinor === null || amountMinor <= 0) {
			return fail(400, {
				budgetField: 'amount',
				budgetError: 'Enter an amount above zero.',
				budgetRaw: raw
			});
		}

		const today = localToday(settings.timezone);
		const current = openPeriodOn(locals.userId, today);
		if (!current) {
			return fail(409, {
				budgetField: null,
				budgetError: 'No period is open right now, so there is nothing to change.',
				budgetRaw: raw
			});
		}

		const updated = supersedePeriod(locals.userId, current, amountMinor, settings);

		return {
			budgetSaved: true,
			budgetField: null,
			budgetAmountMinor: amountMinor,
			budgetWindow: { startsOn: updated.startsOn, endsOn: updated.endsOn },
			// Same helper Today uses — never a hand-rolled percentage.
			budgetBand: displayBand(updated.dailyAllowanceMinor, {
				bandPct: settings.bandPct,
				roundingStep: settings.roundingStep
			})
		};
	}
};
