import { existsSync } from 'node:fs';
import { fail, type Actions } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import { forUser, schema } from '$lib/server/db';
import {
	catchUpEligible,
	closeLogDay,
	loadSettings,
	openPeriodOn,
	todayContext
} from '$lib/server/today';
import { addDays, localToday } from '$lib/server/clock';
import { activeTrip, localToHome, tripSpentMinor } from '$lib/server/trips';
import { tripDailyFigure } from '$lib/allowance';
import { addWaitItem, resolveWaitItem } from '$lib/server/rules';
import { isCategory } from '$lib/categories';
import { parseMoney } from '$lib/money';
import type { PageServerLoad } from './$types';

// Which commands the empty states should quote. Telling a containerised user
// to run `npm run …` sends them to a shell where it will not work, and the
// empty state is the very first thing a new install shows.
const inContainer = existsSync('/.dockerenv') || process.env.SPLIT_IN_CONTAINER === '1';

export const load: PageServerLoad = ({ locals }) => {
	const ctx = todayContext(locals.userId);
	if (!ctx) return { view: null, hasPeriod: false, inContainer };
	return { view: ctx.view, hasPeriod: ctx.period !== null, inContainer };
};

export const actions: Actions = {
	/** Log one discretionary purchase. The whole point of the app (F6). */
	logTxn: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const rawAmount = String(form.get('amount') ?? '');
		const category = String(form.get('category') ?? '');
		const rawPlanned = String(form.get('planned') ?? '');
		const clientUuid = String(form.get('clientUuid') ?? '') || null;

		// Parsed at the TRIP's scale while one is active: JPY/KRW/VND have no
		// decimals, and parsing ¥1000 at two would log ¥100000.
		const scaleUnits = activeTrip(locals.userId)?.localMinorUnits ?? settings.minorUnits;
		const amountMinor = parseMoney(rawAmount, scaleUnits);
		if (amountMinor === null) {
			const example = scaleUnits > 0 ? `185${'.' + '5'.padEnd(scaleUnits, '0')}` : '185';
			return fail(400, {
				field: 'amount',
				error: `Enter an amount like ${example}.`,
				rawAmount
			});
		}
		if (amountMinor <= 0) {
			return fail(400, { field: 'amount', error: 'Enter an amount above zero.', rawAmount });
		}
		if (!isCategory(category)) {
			return fail(400, { field: 'category', error: 'Pick a category.', rawAmount });
		}
		if (rawPlanned !== '0' && rawPlanned !== '1') {
			return fail(400, { field: 'planned', error: 'Mark it planned or unplanned.', rawAmount });
		}

		const now = new Date();
		const trip = activeTrip(locals.userId);
		const spentOn = localToday(trip?.tripTz ?? settings.timezone, now);

		// On a trip the typed amount is LOCAL and is the source of truth; the
		// home figure is derived at the locked rate and frozen per row, so a
		// later rate correction recomputes it without touching what was typed.
		// Trip spending never touches the period (Spec §4.5).
		let values;
		if (trip) {
			const homeMinor = localToHome(amountMinor, trip, settings.minorUnits);

			// A tenfold fat-finger in an unfamiliar currency has no intuition to
			// catch it, so the app catches it (Spec §12). Confirmable, not blocked.
			const figure = tripDailyFigure(trip, tripSpentMinor(locals.userId, trip.id), spentOn);
			if (figure.figure > 0 && homeMinor > figure.figure * 10 && form.get('confirmed') !== '1') {
				return fail(409, {
					field: 'amount',
					error: `That is more than ten times today's figure. Tap save again to confirm.`,
					needsConfirm: true,
					rawAmount
				});
			}

			values = {
				spentOn,
				amountMinor: homeMinor,
				amountLocalMinor: amountMinor,
				fxRateUsed: trip.fxRateToHome,
				tripId: trip.id,
				category,
				planned: rawPlanned === '1' ? 1 : 0,
				note: null,
				periodId: null,
				enteredAt: now.toISOString(),
				clientUuid
			};
		} else {
			values = {
				spentOn,
				amountMinor,
				category,
				planned: rawPlanned === '1' ? 1 : 0,
				note: null,
				periodId: openPeriodOn(locals.userId, spentOn)?.id ?? null,
				enteredAt: now.toISOString(),
				clientUuid
			};
		}

		const { db } = forUser(locals.userId);
		try {
			db.insert(schema.txn)
				.values({ ...values, userId: locals.userId })
				.run();
		} catch (err) {
			// A repeat of the same client_uuid is a double-submit, not an error.
			const message = err instanceof Error ? err.message : '';
			if (!message.includes('UNIQUE') || !message.includes('client_uuid')) throw err;
		}

		closeLogDay(locals.userId, spentOn, now);
		return { saved: true };
	},

	/**
	 * Close the day with nothing on it. A zero-spend day is the cheapest
	 * possible way to keep the streak alive (Spec §4.6) — it is a first-class
	 * action here, not an absence.
	 */
	logNothing: ({ locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const now = new Date();
		closeLogDay(
			locals.userId,
			localToday(activeTrip(locals.userId)?.tripTz ?? settings.timezone, now),
			now
		);
		return { closed: true };
	},

	/** Rule 4: park it for 72 hours. Most items die on the list. */
	addWait: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const label = String(form.get('label') ?? '').trim();
		if (!label) return fail(400, { error: 'Name the thing you want.' });

		const raw = String(form.get('amount') ?? '').trim();
		addWaitItem(locals.userId, label, raw ? parseMoney(raw, settings.minorUnits) : null);
		return { waiting: true };
	},

	/** The 72 hours are up: buy it guilt-free, or let it go. */
	resolveWait: async ({ request, locals }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		const outcome = String(form.get('outcome') ?? '');
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown item.' });
		if (outcome !== 'bought' && outcome !== 'dropped') {
			return fail(400, { error: 'Bought or dropped.' });
		}
		resolveWaitItem(locals.userId, id, outcome);
		return { resolved: true };
	},

	/**
	 * File the pre-authorised lossy catch-up (Method Part V, Spec §4.6).
	 *
	 * One combined entry for both days, with no attempt to reconstruct
	 * details — because two missed nights is where systems die, and what kills
	 * them is the guilt of the backlog, not the missing data. There is
	 * deliberately no backfill flow behind this button.
	 *
	 * `mode=nothing` files the same day as a plain zero-spend close instead.
	 * The two are different facts: catch-up means "I lived that day and am not
	 * reconstructing it", zero-spend means "I lived that day and it cost
	 * nothing". Only one of them is true on any given night, and only the
	 * person who lived it knows which — so this offers both rather than
	 * guessing. It does NOT widen the window: both go through the same
	 * single-day eligibility check, because a flow that can reach further back
	 * than yesterday is the backfill Spec §4.6 refuses to build.
	 */
	catchUp: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const mode = String(form.get('mode') ?? 'catchup');
		if (mode !== 'catchup' && mode !== 'nothing') {
			return fail(400, { error: 'Unknown catch-up mode.' });
		}

		const now = new Date();
		const today = localToday(activeTrip(locals.userId)?.tripTz ?? settings.timezone, now);
		const yesterday = addDays(today, -1);

		if (!catchUpEligible(locals.userId, yesterday, today)) {
			return fail(409, { error: 'That catch-up window has closed. Start tonight.' });
		}

		// Filed late, but not lossy: a zero-spend day carries its full detail,
		// so it is not flagged as a catch-up. `is_catchup` marks the entry whose
		// contents were surrendered, and nothing was surrendered here.
		closeLogDay(locals.userId, yesterday, now, mode === 'catchup');

		// Only the lossy path closes today as well — that is what makes it "one
		// combined entry for both days". Asserting yesterday cost nothing says
		// nothing whatsoever about today, so today stays open.
		if (mode === 'catchup') closeLogDay(locals.userId, today, now);

		return { caughtUp: true };
	},

	/** Remove a mistyped entry. Today's entries only — history is not editable here. */
	deleteTxn: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown entry.' });

		const now = new Date();
		const today = localToday(activeTrip(locals.userId)?.tripTz ?? settings.timezone, now);

		const { db, owns } = forUser(locals.userId);
		db.delete(schema.txn)
			.where(and(owns(schema.txn), sql`${schema.txn.id} = ${id} AND ${schema.txn.spentOn} = ${today}`))
			.run();

		// Keep the day's entry count honest, but never un-close the day.
		const closed = db
			.select()
			.from(schema.logDay)
			.where(and(owns(schema.logDay), eq(schema.logDay.loggedOn, today)))
			.get();
		if (closed) closeLogDay(locals.userId, today, now);

		return { deleted: true };
	}
};
