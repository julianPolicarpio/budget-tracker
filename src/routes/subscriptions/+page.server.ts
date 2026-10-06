import { fail, type Actions } from '@sveltejs/kit';
import { loadSettings } from '$lib/server/today';
import * as panels from '$lib/server/panel-forms';
import { openPeriodOn } from '$lib/server/rollover';
import { localToday, daysBetween } from '$lib/server/clock';
import { parseMoney } from '$lib/money';
import { isCategory } from '$lib/categories';
import {
	advanceCharge,
	annualisedTotalMinor,
	cancelSubscription,
	createSubscription,
	cullList,
	listSubscriptions,
	keepSubscription,
	markUsed,
	commitmentsByKind,
	commitmentsPerPeriod,
	updateSubscription,
	restoreSubscription,
	getSubscription
} from '$lib/server/subscriptions';
import {
	CADENCES,
	DEFAULT_LEAD_DAYS,
	FINAL_ALERT_DAYS,
	trialAlertDays,
	type Cadence
} from '$lib/subscription-cadence';
import type { PageServerLoad } from './$types';

/** YYYY-MM-DD, and a real date — `2027-02-31` parses but does not exist. */
function isDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const d = new Date(value + 'T00:00:00Z');
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const load: PageServerLoad = ({ locals }) => {
	const settings = loadSettings(locals.userId);
	if (!settings) return { ready: false as const };

	const today = localToday(settings.timezone);
	const period = openPeriodOn(locals.userId, today);
	const byKind = commitmentsByKind(locals.userId);

	return {
		ready: true as const,
		today,
		rows: cullList(locals.userId, today),
		essential: byKind.essential,
		cancelled: listSubscriptions(locals.userId, true).filter((r) => r.cancelledAt !== null),
		annualisedTotalMinor: annualisedTotalMinor(locals.userId),
		// What the split has to reserve every period to keep these paid. The
		// number that tells you whether the commitments actually fit.
		perPeriodMinor: period ? commitmentsPerPeriod(locals.userId, period.days, today) : null,
		periodDays: period?.days ?? null,
		currency: {
			code: settings.currencyCode,
			symbol: settings.currencySymbol,
			minorUnits: settings.minorUnits
		}
	};
};

export const actions: Actions = {
	add: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const label = String(form.get('label') ?? '').trim();
		if (!label) return fail(400, { field: 'label', error: 'Name the subscription.' });

		const amountMinor = parseMoney(String(form.get('amount') ?? ''), settings.minorUnits);
		if (amountMinor === null || amountMinor <= 0) {
			return fail(400, { field: 'amount', error: 'Enter the charge, like 285.00.' });
		}

		const rawTax = String(form.get('tax') ?? '').trim();
		const taxMinor = rawTax ? parseMoney(rawTax, settings.minorUnits) : null;
		if (rawTax && (taxMinor === null || taxMinor < 0)) {
			return fail(400, { field: 'tax', error: 'Tax must be a number, or blank.' });
		}

		const cadence = String(form.get('cadence') ?? '') as Cadence;
		if (!CADENCES.includes(cadence)) {
			return fail(400, { field: 'cadence', error: 'Pick how often it bills.' });
		}

		const nextChargeOn = String(form.get('nextChargeOn') ?? '');
		if (!isDate(nextChargeOn)) {
			return fail(400, { field: 'nextChargeOn', error: 'Give the billing date.' });
		}

		const isTrial = form.get('isTrial') === '1';
		const rawCancelBy = String(form.get('cancelByOn') ?? '').trim();
		// The deadline defaults to the charge date, because that is what it is
		// unless the vendor demands notice. Never left null on a trial: a trial
		// with no deadline is the silent conversion this feature exists to stop.
		const cancelByOn = rawCancelBy || nextChargeOn;
		if (!isDate(cancelByOn)) {
			return fail(400, { field: 'cancelByOn', error: 'Give a real cancel-by date.' });
		}

		const leadDays = Number(form.get('leadDays') ?? 30);
		if (!Number.isInteger(leadDays) || leadDays < 1 || leadDays > 365) {
			return fail(400, { field: 'leadDays', error: 'Warn me between 1 and 365 days ahead.' });
		}

		const rawCategory = String(form.get('category') ?? '');
		const vendor = String(form.get('vendor') ?? '').trim();

		createSubscription(locals.userId, {
			label,
			vendor: vendor || null,
			amountMinor,
			taxMinor,
			cadence,
			nextChargeOn,
			trialEndsOn: isTrial ? nextChargeOn : null,
			cancelByOn,
			leadDays,
			category: isCategory(rawCategory) ? rawCategory : null,
			note: String(form.get('note') ?? '').trim() || null,
			isEssential: form.get('isEssential') === '1'
		});
		return { added: true };
	},

	/**
	 * Quick add — the fast path.
	 *
	 * Four fields, because a commitment you cannot be bothered to record is a
	 * commitment that gets paid out of Spend forever. Dates are inferred: the
	 * next charge is one cadence out, and an essential cost gets no cancel-by
	 * deadline at all, because there is no decision pending on your own wifi.
	 */
	quickAdd: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const result = await panels.quickAddBill(locals.userId, form, settings);

		// This route never redirected on quick-add (the panel lives here), so
		// success just returns the payload; only the failure half needs map.
		if ('fail' in result) return fail(result.fail[0], result.fail[1]);
		return result.data;
	},

	/**
	 * Revise a recorded commitment.
	 *
	 * Shares the add path's validation rather than trusting an existing row:
	 * the fields come off a form either way, and a record already in the table
	 * has no more claim to being well-formed than a new one.
	 */
	edit: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id) || !getSubscription(locals.userId, id)) {
			return fail(400, { error: 'Unknown subscription.' });
		}

		const label = String(form.get('label') ?? '').trim();
		if (!label) return fail(400, { id, field: 'label', error: 'Name it.' });

		const amountMinor = parseMoney(String(form.get('amount') ?? ''), settings.minorUnits);
		if (amountMinor === null || amountMinor <= 0) {
			return fail(400, { id, field: 'amount', error: 'Enter the charge, like 285.00.' });
		}

		const rawTax = String(form.get('tax') ?? '').trim();
		const taxMinor = rawTax ? parseMoney(rawTax, settings.minorUnits) : null;
		if (rawTax && (taxMinor === null || taxMinor < 0)) {
			return fail(400, { id, field: 'tax', error: 'Tax must be a number, or blank.' });
		}

		const cadence = String(form.get('cadence') ?? '') as Cadence;
		if (!CADENCES.includes(cadence)) return fail(400, { id, error: 'Pick how often it bills.' });

		const nextChargeOn = String(form.get('nextChargeOn') ?? '');
		if (!isDate(nextChargeOn)) {
			return fail(400, { id, field: 'nextChargeOn', error: 'Give the billing date.' });
		}

		const rawTrialEnds = String(form.get('trialEndsOn') ?? '').trim();
		if (rawTrialEnds && !isDate(rawTrialEnds)) {
			return fail(400, { id, field: 'trialEndsOn', error: 'Give a real date, or leave it blank.' });
		}

		const isEssential = form.get('isEssential') === '1';
		const rawCancelBy = String(form.get('cancelByOn') ?? '').trim();
		if (rawCancelBy && !isDate(rawCancelBy)) {
			return fail(400, { id, field: 'cancelByOn', error: 'Give a real cancel-by date.' });
		}
		// A non-negotiable has nothing to decide, so it carries no deadline and
		// raises no alerts — the same rule the add path applies.
		const cancelByOn = isEssential ? null : rawCancelBy || nextChargeOn;

		const leadDays = Number(form.get('leadDays') ?? 30);
		if (!Number.isInteger(leadDays) || leadDays < 1 || leadDays > 365) {
			return fail(400, { id, field: 'leadDays', error: 'Warn me between 1 and 365 days ahead.' });
		}

		const rawCategory = String(form.get('category') ?? '');
		const vendor = String(form.get('vendor') ?? '').trim();

		updateSubscription(locals.userId, id, {
			label,
			vendor: vendor || null,
			amountMinor,
			taxMinor,
			cadence,
			nextChargeOn,
			trialEndsOn: rawTrialEnds || null,
			cancelByOn,
			leadDays,
			category: isCategory(rawCategory) ? rawCategory : null,
			note: String(form.get('note') ?? '').trim() || null,
			isEssential
		});
		return { edited: true };
	},

	/** Undo an "Ended it". One click made it; one click should unmake it. */
	restore: async ({ request, locals }) => {
		const id = Number((await request.formData()).get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown subscription.' });
		restoreSubscription(locals.userId, id);
		return { restored: true };
	},

	/** The two halves of Spec §374's rule: decide right then, never "later". */
	keep: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });
		const id = Number((await request.formData()).get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown subscription.' });
		/*
		 * `skipped` is how many charge cycles went by while this was left
		 * alone. The screen says so rather than silently jumping the date four
		 * months, which looked identical to the old bug where Keep appeared to
		 * do nothing at all.
		 */
		const skipped = keepSubscription(locals.userId, id, localToday(settings.timezone));
		return { kept: true, skipped };
	},

	cancel: async ({ request, locals }) => {
		const id = Number((await request.formData()).get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown subscription.' });
		cancelSubscription(locals.userId, id);
		return { cancelled: true };
	},

	used: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });
		const id = Number((await request.formData()).get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown subscription.' });
		markUsed(locals.userId, id, localToday(settings.timezone));
		return { used: true };
	},

	/**
	 * The paste-a-trial-confirmation flow (Spec §7.1). `trial-parser.ts` runs
	 * client-side and fills what it can read off the pasted text; this action
	 * only ever sees the reviewed/completed result, the same shape `quickAdd`
	 * already handles above.
	 *
	 * `isEssential` is never a field here and is never sent — Spec §7.1 is
	 * explicit that a trial signed up for in order to cancel is never
	 * essential, so the question is not asked and the row is never created
	 * that way.
	 */
	addFromPaste: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const label = String(form.get('label') ?? '').trim();
		if (!label) return fail(400, { field: 'pasteLabel', error: 'Name the trial.' });

		const amountMinor = parseMoney(String(form.get('amount') ?? ''), settings.minorUnits);
		if (amountMinor === null || amountMinor <= 0) {
			return fail(400, { field: 'pasteAmount', error: 'Enter the price it converts to.' });
		}

		const cadence = String(form.get('cadence') ?? '') as Cadence;
		if (!CADENCES.includes(cadence)) {
			return fail(400, {
				field: 'pasteCadence',
				error: 'Pick how often it bills after the trial.'
			});
		}

		const trialEndsOn = String(form.get('trialEndsOn') ?? '').trim();
		if (!isDate(trialEndsOn)) {
			return fail(400, { field: 'pasteDate', error: 'Give the date it converts.' });
		}

		const today = localToday(settings.timezone);
		// Spec §7.3, same fix as quickAdd: the lead scales to how far away the
		// trial's own deadline is right now, not a flat 30 days.
		const { leadDays, finalLeadDays } = trialAlertDays(daysBetween(today, trialEndsOn));

		createSubscription(locals.userId, {
			label,
			amountMinor,
			cadence,
			nextChargeOn: trialEndsOn,
			trialEndsOn,
			cancelByOn: trialEndsOn,
			leadDays,
			finalLeadDays,
			isEssential: false
		});
		return { addedFromPaste: true };
	}
};
