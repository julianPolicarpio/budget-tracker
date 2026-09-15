import { fail, redirect, type Actions } from '@sveltejs/kit';
import { completeSetup, needsSetup } from '$lib/server/setup';
import { loadSettings } from '$lib/server/today';
import { parseMoney } from '$lib/money';
import { CADENCES, CADENCE_LABEL, type IncomeCadence } from '$lib/income-cadence';
import type { PageServerLoad } from './$types';

const PERIOD_KINDS = ['weekly', 'semimonthly', 'monthly'] as const;

/** YYYY-MM-DD, and a real date — `2027-02-31` parses but does not exist. */
function isDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const d = new Date(value + 'T00:00:00Z');
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// `satisfies` rather than a `: PageServerLoad` annotation, deliberately. The
// annotation widens the exported binding to PageServerLoad's generic default
// (which includes `void`) — invisible everywhere else, because every other
// caller reaches this only through SvelteKit's generated PageData, which
// strips that back out. setup-route.test.ts imports this module directly and
// calls load() itself, so it sees the raw (unwidened) type; `satisfies`
// keeps the same contextual parameter typing while preserving the literal
// return shape on `load`.
export const load = (({ locals }) => {
	// The route exists only while there is nothing to show on Today. Once a
	// period exists the answer is already in the database, and asking again
	// could only produce a duplicate.
	if (!needsSetup(locals.userId)) redirect(303, '/');

	return {
		cadences: CADENCES.filter((c) => c !== 'irregular').map((c) => ({
			value: c,
			label: CADENCE_LABEL[c]
		})),
		periodKinds: PERIOD_KINDS
	};
}) satisfies PageServerLoad;

export const actions: Actions = {
	complete: async ({ request, locals }) => {
		if (!needsSetup(locals.userId)) redirect(303, '/');

		const settings = loadSettings(locals.userId);
		// `field: null`, matching every other branch's shape below — not just
		// `{ error }` — so `form?.field === '...'` in +page.svelte stays valid
		// against every member of the resulting ActionData union.
		if (!settings) return fail(409, { field: null, error: 'This account is not provisioned.' });

		const form = await request.formData();
		const minorUnits = Number(form.get('minorUnits') ?? 2);
		if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 3) {
			return fail(400, { field: 'currency', error: 'Pick a currency.' });
		}

		const timezone = String(form.get('timezone') ?? '').trim();
		if (!timezone) return fail(400, { field: 'timezone', error: 'Pick a timezone.' });

		const currencyCode = String(form.get('currencyCode') ?? '')
			.trim()
			.toUpperCase();
		const currencySymbol = String(form.get('currencySymbol') ?? '').trim();
		if (!/^[A-Z]{3}$/.test(currencyCode) || !currencySymbol) {
			return fail(400, { field: 'currency', error: 'Pick a currency.' });
		}

		const label = String(form.get('label') ?? '').trim();
		if (!label) return fail(400, { field: 'label', error: 'Name the income, e.g. "Salary".' });

		const amountMinor = parseMoney(String(form.get('amount') ?? ''), minorUnits);
		if (amountMinor === null || amountMinor <= 0) {
			return fail(400, { field: 'amount', error: 'How much arrives each time?' });
		}

		const cadence = String(form.get('cadence') ?? '') as IncomeCadence;
		if (!CADENCES.includes(cadence) || cadence === 'irregular') {
			return fail(400, { field: 'cadence', error: 'How often are you paid?' });
		}

		const anchorOn = String(form.get('anchorOn') ?? '');
		if (!isDate(anchorOn)) {
			return fail(400, { field: 'anchorOn', error: 'When does the next one arrive?' });
		}

		// Semi-monthly needs its SECOND date of the month; bi-weekly steps from
		// the anchor. Conflating the two is the ~8% error migration 0014 exists
		// to prevent, so the second date is required rather than inferred.
		let secondDay: number | null = null;
		if (cadence === 'semimonthly') {
			secondDay = Number(form.get('secondDay') ?? NaN);
			if (!Number.isInteger(secondDay) || secondDay < 1 || secondDay > 31) {
				return fail(400, { field: 'secondDay', error: 'Which other day of the month?' });
			}
		}

		const monthlyBillsMinor = parseMoney(String(form.get('bills') ?? ''), minorUnits);
		if (monthlyBillsMinor === null || monthlyBillsMinor < 0) {
			return fail(400, { field: 'bills', error: 'Roughly what do the fixed bills come to?' });
		}

		const periodKind = String(form.get('periodKind') ?? '') as (typeof PERIOD_KINDS)[number];
		if (!PERIOD_KINDS.includes(periodKind)) {
			return fail(400, { field: 'periodKind', error: 'Pick a rhythm.' });
		}

		const weekStartsOn = Number(form.get('weekStartsOn') ?? 0);
		if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
			return fail(400, { field: 'weekStartsOn', error: 'Pick a day.' });
		}

		completeSetup(locals.userId, {
			timezone,
			currencyCode,
			currencySymbol,
			minorUnits,
			// One step in the user's currency: ₱10, €1, ¥100. Derived rather than
			// asked, because nobody knows what a rounding step is.
			roundingStep: 10 ** minorUnits,
			periodKind,
			weekStartsOn,
			income: { label, amountMinor, cadence, anchorOn, secondDay, baselineMinor: null },
			monthlyBillsMinor
		});

		redirect(303, '/');
	}
};
