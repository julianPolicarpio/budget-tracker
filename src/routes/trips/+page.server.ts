import { fail, redirect, type Actions } from '@sveltejs/kit';
import { loadSettings } from '$lib/server/today';
import { localToday } from '$lib/server/clock';
import { parseMoney } from '$lib/money';
import * as panels from '$lib/server/panel-forms';
import { mapResult } from '$lib/server/panel-forms';
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
		return mapResult(await panels.declare(locals.userId, form, settings), '/trips');
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
