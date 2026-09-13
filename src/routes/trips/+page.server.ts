import { fail, redirect, type Actions } from '@sveltejs/kit';
import { loadSettings } from '$lib/server/today';
import { localToday } from '$lib/server/clock';
import { parseMoney } from '$lib/money';
import { IouRequired } from '$lib/server/accounts';
import {
	MAX_TRIP_DAYS,
	TripTooLong,
	activateTrip,
	activeTrip,
	burndown,
	cancelTrip,
	coverShortfall,
	declareTrip,
	fundingCheck,
	listTrips,
	setRate,
	settleTrip,
	tripById,
	tripSpentLocalMinor,
	tripSpentMinor
} from '$lib/server/trips';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const settings = loadSettings(locals.userId);
	if (!settings) return { ready: false as const };

	const today = localToday(settings.timezone);
	const trips = listTrips(locals.userId);
	const active = activeTrip(locals.userId);

	return {
		ready: true as const,
		today,
		maxTripDays: MAX_TRIP_DAYS,
		active: active
			? {
					trip: active,
					drawnMinor: tripSpentMinor(locals.userId, active.id),
					drawnLocalMinor: tripSpentLocalMinor(locals.userId, active.id),
					burndown: burndown(locals.userId, active, today)
				}
			: null,
		planned: trips
			.filter((t) => t.status === 'planned')
			.map((t) => ({ trip: t, check: fundingCheck(locals.userId, t, today) })),
		past: trips.filter((t) => t.status === 'settled' || t.status === 'cancelled'),
		currency: {
			code: settings.currencyCode,
			symbol: settings.currencySymbol,
			minorUnits: settings.minorUnits
		}
	};
};

export const actions: Actions = {
	/** The cue is the booking moment. An hour later the gap has already opened. */
	declare: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const label = String(form.get('label') ?? '').trim();
		const startsOn = String(form.get('startsOn') ?? '');
		const endsOn = String(form.get('endsOn') ?? '');
		const tripTz = String(form.get('tripTz') ?? '').trim();
		const currencyCode = String(form.get('currencyCode') ?? '')
			.trim()
			.toUpperCase();
		const currencySymbol = String(form.get('currencySymbol') ?? '').trim();
		const localMinorUnits = Number(form.get('localMinorUnits'));
		const fxRateToHome = Number(form.get('fxRateToHome'));
		const estimateMinor = parseMoney(String(form.get('estimate') ?? ''), settings.minorUnits);

		if (!label) return fail(400, { error: 'Give the trip a name.' });
		if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn) || !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) {
			return fail(400, { error: 'Both dates are required.' });
		}
		if (endsOn < startsOn) return fail(400, { error: 'It cannot end before it starts.' });
		try {
			new Intl.DateTimeFormat('en-CA', { timeZone: tripTz });
		} catch {
			return fail(400, { error: `"${tripTz}" is not a valid IANA timezone.` });
		}
		if (!currencyCode || !currencySymbol) {
			return fail(400, { error: 'The currency code and symbol are both needed.' });
		}
		// Never inherited from settings: JPY/KRW/VND have none, and a wrong
		// value here is a silent 100x entry error on the first purchase abroad.
		if (![0, 2, 3].includes(localMinorUnits)) {
			return fail(400, { error: 'Decimal places must be 0, 2 or 3 — check the currency.' });
		}
		if (!(fxRateToHome > 0)) return fail(400, { error: 'Enter the rate you actually got.' });
		if (estimateMinor === null || estimateMinor <= 0) {
			return fail(400, { error: 'Enter an estimate above zero.' });
		}

		try {
			declareTrip(locals.userId, {
				label,
				startsOn,
				endsOn,
				tripTz,
				currencyCode,
				currencySymbol,
				localMinorUnits,
				fxRateToHome,
				estimateMinor
			});
		} catch (err) {
			if (err instanceof TripTooLong) return fail(422, { error: err.message });
			return fail(400, { error: err instanceof Error ? err.message : 'Could not declare.' });
		}

		redirect(303, '/trips');
	},

	activate: async ({ request, locals }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown trip.' });
		try {
			activateTrip(locals.userId, id);
		} catch (err) {
			return fail(409, { error: err instanceof Error ? err.message : 'Could not activate.' });
		}
		redirect(303, '/trips');
	},

	cancel: async ({ request, locals }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown trip.' });
		cancelTrip(locals.userId, id);
		redirect(303, '/trips');
	},

	/** Option three of the funding check. Rule 3 applies without exception. */
	coverShortfall: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const id = Number(form.get('id'));
		const amountMinor = parseMoney(String(form.get('amount') ?? ''), settings.minorUnits);
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown trip.' });
		if (amountMinor === null || amountMinor <= 0) {
			return fail(400, { error: 'Enter an amount above zero.' });
		}

		try {
			coverShortfall(
				locals.userId,
				id,
				amountMinor,
				String(form.get('iouReason') ?? ''),
				String(form.get('iouRepayBy') ?? '') || null,
				localToday(settings.timezone)
			);
		} catch (err) {
			if (err instanceof IouRequired) return fail(422, { error: err.message, field: 'iouReason' });
			return fail(400, { error: err instanceof Error ? err.message : 'Could not cover it.' });
		}
		redirect(303, '/trips');
	},

	/** Editing the rate recomputes home figures; local amounts never move. */
	setRate: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const id = Number(form.get('id'));
		const rate = Number(form.get('fxRateToHome'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown trip.' });
		if (!(rate > 0)) return fail(400, { error: 'The rate must be above zero.' });

		setRate(locals.userId, id, rate, settings.minorUnits);
		redirect(303, '/trips');
	},

	/** Two numbers, and their difference is the point. */
	settle: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const id = Number(form.get('id'));
		const actualMinor = parseMoney(String(form.get('actual') ?? ''), settings.minorUnits);
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown trip.' });
		if (actualMinor === null || actualMinor < 0) {
			return fail(400, { error: 'Enter what the bank actually charged.' });
		}
		if (!tripById(locals.userId, id)) return fail(400, { error: 'Unknown trip.' });

		settleTrip(
			locals.userId,
			id,
			actualMinor,
			String(form.get('settledOn') || localToday(settings.timezone))
		);
		redirect(303, '/trips');
	}
};
