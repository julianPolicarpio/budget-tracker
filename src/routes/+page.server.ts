import { existsSync } from 'node:fs';
import { fail, type Actions } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import { forUser, schema } from '$lib/server/db';
import {
	catchUpEligible,
	closeLogDay,
	CATCH_UP_WINDOW_DAYS,
	loadSettings,
	openPeriodOn,
	todayContext
} from '$lib/server/today';
import { addDays, localToday } from '$lib/server/clock';
import { activeTrip, localToHome, tripSpentMinor } from '$lib/server/trips';
import { tripDailyFigure } from '$lib/allowance';
import { resolveWaitItem } from '$lib/server/rules';
import * as panels from '$lib/server/panel-forms';
import type { PanelResult } from '$lib/server/panel-forms';
import type { Settings } from '$lib/server/db/schema';
import { isCategory } from '$lib/categories';
import { setupTodo } from '$lib/server/setup-status';
import { parseMoney } from '$lib/money';
import {
	answerWord,
	buildParseContext,
	commitResolvedEntry,
	resolveEntry
} from '$lib/server/entry';
import {
	cancelSubscription,
	getSubscription,
	restoreSubscription
} from '$lib/server/subscriptions';
import { recordArrival } from '$lib/server/arrivals';
import { recordRefund } from '$lib/server/refunds';
import type { PageServerLoad } from './$types';

// Which commands the empty states should quote. Telling a containerised user
// to run `npm run …` sends them to a shell where it will not work, and the
// empty state is the very first thing a new install shows.
const inContainer = existsSync('/.dockerenv') || process.env.SPLIT_IN_CONTAINER === '1';

export const load: PageServerLoad = ({ locals }) => {
	const ctx = todayContext(locals.userId);
	if (!ctx) return { view: null, hasPeriod: false, inContainer, userId: locals.userId };

	// What the "Money landed" / "Money back" forms need (account/refund-
	// candidate pickers) now comes from the root layout's shared
	// `actionContext` (`$lib/actions/context.ts`, Task 2c) rather than a
	// second copy of the same queries here — Spec A6: "Do not... duplicate
	// accounting code across routes."
	return {
		view: ctx.view,
		hasPeriod: ctx.period !== null,
		inContainer,
		userId: locals.userId,
		setupTodo: setupTodo(locals.userId),
		parseContext: buildParseContext(locals.userId)
	};
};

type QuickOperation = (
	userId: number,
	form: FormData,
	settings: Settings
) => Promise<PanelResult>;

async function saveQuick(request: Request, userId: number, operation: QuickOperation) {
	const settings = loadSettings(userId);
	if (!settings) return fail(409, { error: 'Split is not initialised yet.' });
	const result = await operation(userId, await request.formData(), settings);
	if ('fail' in result) return fail(result.fail[0], result.fail[1]);
	return result.data;
}

export const actions: Actions = {
	transferMoney: ({ request, locals }) => saveQuick(request, locals.userId, panels.transfer),
	fundPlannedExpense: ({ request, locals }) => saveQuick(request, locals.userId, panels.fund),
	createPlannedExpense: ({ request, locals }) => saveQuick(request, locals.userId, panels.createPlanned),
	declareTrip: ({ request, locals }) => saveQuick(request, locals.userId, panels.declare),
	quickAddBill: ({ request, locals }) => saveQuick(request, locals.userId, panels.quickAddBill),
	addDebt: ({ request, locals }) => saveQuick(request, locals.userId, panels.addDebt),
	openAccount: ({ request, locals }) => saveQuick(request, locals.userId, panels.openAccount),
	upsertRule: ({ request, locals }) => saveQuick(request, locals.userId, panels.upsertRule),

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
	 * Log one typed string through A4a's record router (Spec §5.6). Home
	 * currency only — a trip in progress still logs through `logTxn` above,
	 * because `commitResolvedEntry()` has no trip fields at all (see
	 * `log-entry.svelte.ts`'s module doc for why that boundary is deliberate
	 * rather than an oversight).
	 *
	 * The text is re-resolved here from scratch rather than trusting the
	 * client's own `parseEntry()` result: the browser's copy of `label_map`
	 * and live commitments can be a save or two stale, and this is the one
	 * place that actually has to be right — a wrong KIND corrupts the band.
	 */
	logEntry: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const text = String(form.get('text') ?? '');
		const clientUuid = String(form.get('clientUuid') ?? '') || null;
		const rawPlanned = String(form.get('planned') ?? '');
		const rawCommitmentMode = String(form.get('commitmentMode') ?? '');
		const taughtWord = String(form.get('taughtWord') ?? '');
		const taughtEnglish = String(form.get('taughtEnglish') ?? '');
		const taughtRoot = String(form.get('taughtRoot') ?? '');

		// Persist a freshly-answered category question BEFORE resolving, so
		// this same save benefits from it (Spec §5.9 step 1 -> step 2) rather
		// than requiring the word be typed a second time.
		if (taughtWord && taughtEnglish && isCategory(taughtRoot)) {
			answerWord(locals.userId, taughtWord, taughtEnglish, taughtRoot);
		}

		const resolved = resolveEntry(locals.userId, text);

		if (resolved.kind === 'empty' || resolved.kind === 'need_word') {
			return fail(400, { field: 'text', error: 'Type what you spent on.', rawText: text });
		}
		if (resolved.kind === 'ask_kind' || resolved.kind === 'ask_category') {
			return fail(400, {
				field: 'text',
				error: 'Answer the question before saving.',
				rawText: text
			});
		}

		const now = new Date();
		const today = localToday(settings.timezone, now);

		let planned: boolean | undefined;
		if (resolved.kind === 'transaction') {
			if (rawPlanned !== '0' && rawPlanned !== '1') {
				return fail(400, {
					field: 'planned',
					error: 'Mark it planned or unplanned.',
					rawText: text
				});
			}
			planned = rawPlanned === '1';
		}

		let commitmentMode: 'same' | 'same_essential' | 'varies' | undefined;
		if (resolved.kind === 'new_commitment') {
			if (
				rawCommitmentMode !== 'same' &&
				rawCommitmentMode !== 'same_essential' &&
				rawCommitmentMode !== 'varies'
			) {
				return fail(400, {
					field: 'commitmentMode',
					error: 'Choose same, same and non-negotiable, or varies.',
					rawText: text
				});
			}
			commitmentMode = rawCommitmentMode;
			if (commitmentMode !== 'varies') {
				return fail(400, {
					field: 'text',
					error: 'Open the bill form to choose a billing date before saving.',
					rawText: text
				});
			}
		}

		let result;
		try {
			result = commitResolvedEntry(locals.userId, resolved, {
				today,
				now,
				clientUuid,
				planned,
				commitmentMode
			});
		} catch (err) {
			// A repeat of the same client_uuid is a double-submit, not an error —
			// same handling as `logTxn` above. `commitResolvedEntry()`'s
			// `transaction` branch is the only one that writes `client_uuid`
			// (server/entry.ts), so this is the only branch that can throw here.
			const message = err instanceof Error ? err.message : '';
			if (!message.includes('UNIQUE') || !message.includes('client_uuid')) throw err;
			result = { ok: true as const, wrote: 'transaction' as const };
		}
		if (!result.ok) return fail(400, { field: 'text', error: result.error, rawText: text });

		return { saved: true, wrote: result.wrote };
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
		const result = await panels.addWait(locals.userId, await request.formData(), settings);
		if ('fail' in result) return fail(result.fail[0], result.fail[1]);
		return result.data;
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

	/**
	 * Close one missed day (Spec §4.6, extended).
	 *
	 * The old catch-up reached exactly one day and offered one combined entry
	 * for it. This takes a date and one of three honest answers, because those
	 * are the three things that can actually be true about a day you did not
	 * log, and collapsing them loses the difference:
	 *
	 *   entries  — you remember what you bought. Typed, parsed and dated to
	 *              that day, then flagged `is_catchup` because it was recalled
	 *              rather than caught at the moment of spending.
	 *   nothing  — you affirm nothing was spent. Full detail, NOT flagged;
	 *              nothing was surrendered.
	 *   forgot   — you genuinely cannot remember. Flagged, no entries, and the
	 *              review will say so rather than counting it as a clean day.
	 *
	 * Deliberately one day per submit, not a week in one figure. Finding 10:
	 * people underestimate weekly spending by ~30%, and the named debiaser is
	 * "predicting events rather than time periods". A single box for a week is
	 * the shape that understates, in the direction that reads comfortably.
	 */
	catchUpDay: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const date = String(form.get('date') ?? '');
		const mode = String(form.get('mode') ?? '');
		const text = String(form.get('text') ?? '').trim();

		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, { error: 'Unknown day.' });
		if (mode !== 'entries' && mode !== 'nothing' && mode !== 'forgot') {
			return fail(400, { error: 'Unknown catch-up mode.' });
		}

		const now = new Date();
		const today = localToday(activeTrip(locals.userId)?.tripTz ?? settings.timezone, now);

		// Inside the window, and never today or the future. Today is logged the
		// ordinary way; letting catch-up claim it would let a reconstructed
		// entry masquerade as one made at the moment of spending.
		if (date >= today || date < addDays(today, -CATCH_UP_WINDOW_DAYS)) {
			return fail(409, { error: 'That day is outside the catch-up window.' });
		}

		if (mode === 'entries') {
			if (!text) return fail(400, { error: 'Type what you remember, or pick one of the others.' });

			/*
			 * A missed day is usually several purchases, so one field per day has
			 * to take several. Comma-separated, parsed independently.
			 *
			 * Resolve ALL of them before committing ANY. A day half-filed is
			 * worse than one not filed: the log_day row would close, the row
			 * would vanish from Today, and the entries that failed would be
			 * silently gone with no way back to them.
			 */
			const parts = text
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);

			const resolved = parts.map((t) => resolveEntry(locals.userId, t));

			const unanswered = resolved.findIndex(
				(r) => r.kind === 'ask_category' || r.kind === 'ask_kind'
			);
			if (unanswered >= 0) {
				return fail(400, {
					error: `"${parts[unanswered]}" needs an answer first — log it tonight instead, or drop it from this line.`,
					date
				});
			}

			for (const r of resolved) {
				const result = commitResolvedEntry(locals.userId, r, { today: date, now });
				if (!result.ok) return fail(400, { error: result.error, date });
			}
		}

		// `nothing` is the one mode that is not a reconstruction: you are
		// asserting a fact about the day, at full detail.
		closeLogDay(locals.userId, date, now, mode !== 'nothing');

		return { caughtUpDay: date };
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
			.where(
				and(owns(schema.txn), sql`${schema.txn.id} = ${id} AND ${schema.txn.spentOn} = ${today}`)
			)
			.run();

		// Keep the day's entry count honest, but never un-close the day.
		const closed = db
			.select()
			.from(schema.logDay)
			.where(and(owns(schema.logDay), eq(schema.logDay.loggedOn, today)))
			.get();
		if (closed) closeLogDay(locals.userId, today, now);

		return { deleted: true };
	},

	/**
	 * "I cancelled it" (Spec §7.4). No new capability — `cancelSubscription()`
	 * already exists — only a way in from wherever a deadline is actually
	 * shown. Today's widget list is closed (Spec §8.1), so this attaches to
	 * the existing `subscriptionDue` horizon line rather than adding one; the
	 * cull screen already has its own "Cancelled it" plus a restore, and this
	 * gives Today the same one-click decision with undo.
	 */
	cancelSub: async ({ request, locals }) => {
		const id = Number((await request.formData()).get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown subscription.' });

		// getSubscription() is scoped through forUser() — an id belonging to
		// another tenant simply is not found here, same as everywhere else.
		const sub = getSubscription(locals.userId, id);
		if (!sub) return fail(400, { error: 'Unknown subscription.' });

		cancelSubscription(locals.userId, id);
		// Carries the label so the undo notice below can name what it is
		// undoing without a second lookup after the reload `use:enhance` triggers.
		return { cancelledSubId: id, cancelledSubLabel: sub.label };
	},

	/** Undo an "I cancelled it" typed on Today. One click made it, one undoes it. */
	restoreSub: async ({ request, locals }) => {
		const id = Number((await request.formData()).get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown subscription.' });
		restoreSubscription(locals.userId, id);
		return { restoredSubId: id };
	},

	/**
	 * Money arrived (A6, op 2). An arrival is not income reporting —
	 * it moves real money into a bucket now. The schedule (\`income\` tab)
	 * never advances: arrivals are records of what actually happened.
	 */
	landMoney: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const rawAmount = String(form.get('amount') ?? '');
		const accountId = Number(form.get('accountId') ?? '');
		const note = String(form.get('note') ?? '').trim() || null;
		const clientUuid = String(form.get('clientUuid') ?? '') || null;

		const amountMinor = parseMoney(rawAmount, settings.minorUnits);
		if (amountMinor === null) {
			return fail(400, {
				field: 'amount',
				error: 'Enter an amount like 15000.',
				rawAmount
			});
		}
		if (!Number.isInteger(accountId)) {
			return fail(400, {
				field: 'accountId',
				error: 'Pick which account the money landed in.',
				rawAmount
			});
		}

		const now = new Date();
		try {
			recordArrival(locals.userId, {
				amountMinor,
				accountId,
				arrivedOn: localToday(settings.timezone, now),
				note,
				clientUuid
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : '';
			// A repeat of the same client_uuid is a double-submit, not an error.
			if (message.includes('UNIQUE')) return { saved: true };
			return fail(409, { field: 'accountId', error: message, rawAmount });
		}
		return { landed: true };
	},

	/**
	 * Money refunded (A6, op 8). A refund rides on an existing expense:
	 * spending goes down on that category, the money lands in a chosen
	 * bucket, and the schedule is never touched.
	 */
	refundMoney: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const originalTxnId = Number(form.get('originalTxnId') ?? '');
		const rawAmount = String(form.get('amount') ?? '');
		const accountId = Number(form.get('accountId') ?? '');
		const note = String(form.get('note') ?? '').trim() || null;
		const clientUuid = String(form.get('clientUuid') ?? '') || null;

		const amountMinor = parseMoney(rawAmount, settings.minorUnits);
		if (!Number.isInteger(originalTxnId)) {
			return fail(400, {
				error: "That expense isn't in the pick list anymore — refresh the page."
			});
		}
		if (amountMinor === null) {
			return fail(400, { field: 'amount', error: 'Enter an amount like 15000.', rawAmount });
		}
		if (!Number.isInteger(accountId)) {
			return fail(400, {
				field: 'accountId',
				error: 'Pick which account the money landed in.',
				rawAmount
			});
		}

		const now = new Date();
		try {
			recordRefund(locals.userId, {
				originalTxnId,
				amountMinor,
				accountId,
				refundedOn: localToday(settings.timezone, now),
				note,
				clientUuid
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : '';
			if (message.includes('UNIQUE')) return { saved: true };
			return fail(409, { field: 'amount', error: message, rawAmount });
		}
		return { refunded: true };
	}
};
