import { fail, type Actions } from '@sveltejs/kit';
import { loadSettings } from '$lib/server/today';
import { openPeriodOn } from '$lib/server/rollover';
import { localToday } from '$lib/server/clock';
import { parseMoney } from '$lib/money';
import { isCategory } from '$lib/categories';
import {
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
	CADENCE_MONTHS,
	DEFAULT_LEAD_DAYS,
	type Cadence
} from '$lib/subscription-cadence';
import { addMonths } from '$lib/server/irregulars';
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
			return fail(400, { field: 'nextChargeOn', error: 'Give the next charge date.' });
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
		const label = String(form.get('label') ?? '').trim();
		if (!label) return fail(400, { field: 'quickLabel', error: 'Name it.' });

		const amountMinor = parseMoney(String(form.get('amount') ?? ''), settings.minorUnits);
		if (amountMinor === null || amountMinor <= 0) {
			return fail(400, { field: 'quickAmount', error: 'Enter the charge, like 750.' });
		}

		const cadence = String(form.get('cadence') ?? 'monthly') as Cadence;
		if (!CADENCES.includes(cadence)) return fail(400, { error: 'Pick how often it bills.' });

		const isEssential = form.get('isEssential') === '1';
		const today = localToday(settings.timezone);

		/*
		 * "Free until" is the whole entry for a trial, and trials are the common
		 * case — a free AI offer is free today and priced later, so the only
		 * date that matters is the one where that flips. Without this the quick
		 * path records a trial as though it were already billing, which reserves
		 * real money in Bills against a charge of ₱0.
		 */
		const rawFreeUntil = String(form.get('freeUntil') ?? '').trim();
		if (rawFreeUntil && !isDate(rawFreeUntil)) {
			return fail(400, { field: 'freeUntil', error: 'Give a real date, or leave it blank.' });
		}
		const nextChargeOn = rawFreeUntil || addMonths(today, CADENCE_MONTHS[cadence]);

		// A trial's deadline is longer than one billing cycle away, so the
		// cadence-scaled lead would be far too short to act on. Give it a month.
		const leadDays = rawFreeUntil ? 30 : DEFAULT_LEAD_DAYS[cadence];

		createSubscription(locals.userId, {
			label,
			amountMinor,
			cadence,
			nextChargeOn,
			trialEndsOn: rawFreeUntil || null,
			// Non-negotiable: nothing to decide, so no deadline and no alerts.
			// Discretionary: the renewal IS the decision point (Spec §374).
			cancelByOn: isEssential ? null : nextChargeOn,
			leadDays,
			isEssential
		});
		return { added: true };
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
			return fail(400, { id, field: 'nextChargeOn', error: 'Give the next charge date.' });
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
		keepSubscription(locals.userId, id, localToday(settings.timezone));
		return { kept: true };
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
	}
};
