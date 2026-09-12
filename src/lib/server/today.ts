/**
 * The Today view — DAILY class (Spec §8.1).
 *
 * Purpose: tell you today's number and take your log entry. Nothing else.
 *
 * Note what `TodayView` structurally cannot contain: any account balance, any
 * category total, any "remaining this period" figure, any period-to-date sum.
 * That is enforced by the guard at the bottom of this file, not by review.
 */

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db, schema } from './db';
import { dailyAllowance, displayBand, tripDailyFigure, type Band } from '$lib/allowance';
import { addDays, daysBetween, localToday } from './clock';
import { subscriptionHorizon } from './subscriptions';
import { computeStreak, type Streak } from './streak';
import { weeklyReviewDue } from './review';
import { openPeriodOn } from './rollover';
import { coverage, upcoming } from './irregulars';
import { ensureAllocations, stalePending } from './allocations';
import { activeTrip, tripSpentLocalMinor, tripSpentMinor } from './trips';
import { ripeItems } from './rules';
import type { CategoryKey } from '$lib/categories';
import type { Assert, DailySurfaceVerdict } from './withholding';
import type { Period, Settings } from './db/schema';

export const STRIP_DAYS = 28;

export interface TodayEntry {
	id: number;
	amountMinor: number;
	/** Trip rows only: what the user actually typed, in the local currency. */
	amountLocalMinor: number | null;
	category: CategoryKey;
	planned: boolean;
	note: string | null;
	enteredAt: string;
}

export interface TodayView {
	/** Local date in the configured timezone — the authority for the log day. */
	date: string;
	currency: { code: string; symbol: string; minorUnits: number };
	/** The band, never a precise figure. Null when no period is open. */
	band: Band | null;
	/** Today's entries only. Deliberately without a running total (Spec §8.1.3). */
	entries: TodayEntry[];
	/** True once an explicit log_day row exists — including a zero-entry night. */
	dayClosed: boolean;
	/** The physical record from F7: one cell per day, oldest first. */
	strip: { date: string; logged: boolean }[];
	streak: Streak;
	/** The week label of an outstanding weekly review, else null (Spec §8.1.7). */
	reviewDue: string | null;
	/**
	 * An irregular landing inside 7 days (Spec §8.1.6). `funded` is a status,
	 * not a figure — the amount in Irregulars stays withheld.
	 */
	horizon: { label: string; dueOn: string; funded: boolean } | null;
	/**
	 * A subscription decision deadline inside 7 days.
	 *
	 * Kept separate from `horizon` rather than merged into it, for two reasons.
	 * `funded` is meaningless here — the question is not whether the money is
	 * ready, it is whether you still want the thing. And merging would let one
	 * hide the other, so a trial converting silently could be masked by an
	 * unfunded electricity bill.
	 *
	 * This does widen Spec §8.1's closed widget list, which is a real cost. It
	 * earns the slot on the same grounds as `pendingMoves`: both describe money
	 * about to move in a way no other number on the screen reflects. It carries
	 * a date and a name and no amount, so the withholding layer is intact — and
	 * it obeys the horizon's seven-day rule rather than camping on the daily
	 * surface for the whole 30-day notification lead.
	 */
	subscriptionDue: { id: number; label: string; deadline: string; isTrial: boolean } | null;
	/**
	 * Unexecuted allocations past their date (Spec §8.1.8). This is the sole
	 * exception to the no-additions rule and it earns it: an unexecuted split
	 * means every other number on this screen describes money that is not
	 * where the app thinks it is.
	 */
	pendingMoves: { count: number; firstLabel: string } | null;
	/** 72-hour items whose wait is up (Spec §8.1.5). Only renders when ripe. */
	ripeWaits: { id: number; label: string; amountMinor: number | null }[];
	/**
	 * The trip variant (Spec §8.1). While a trip is active the hero swaps to a
	 * PRECISE figure in the trip's own currency, not a band.
	 *
	 * That is not a hole in the withholding layer — it is Spec §6.1b. A period
	 * has a next period to borrow from, so a precise remaining figure licenses
	 * spending to zero and past it (F5). A trip has a hard end and no tomorrow,
	 * so drawing the envelope to near-zero on the last day is the correct
	 * outcome. Everything the layer hides at home stays hidden: no account
	 * balances, no category totals, no period figures.
	 *
	 * The fields are named for the envelope being drawn down, which is what
	 * they are — not for an account balance, which is what they are not.
	 */
	trip: {
		id: number;
		label: string;
		currency: { code: string; symbol: string; minorUnits: number };
		/** The locked effective rate, so the keypad can show the home equivalent. */
		fxRateToHome: number;
		/** Today's figure, in the trip's currency. Recomputed every morning. */
		figureLocal: number;
		/** How far past the envelope, if at all. */
		overLocal: number;
		envelopeLocal: number;
		drawnLocal: number;
		dayOfTrip: number;
		tripDays: number;
		burnPct: number;
	} | null;
}

export interface TodayContext {
	view: TodayView;
	settings: Settings;
	period: Period | null;
}

export function loadSettings(): Settings | null {
	return db.select().from(schema.settings).where(eq(schema.settings.id, 1)).get() ?? null;
}

export { openPeriodOn };

export function todayContext(now: Date = new Date()): TodayContext | null {
	const settings = loadSettings();
	if (!settings) return null;

	// The day boundary follows your body, not your bank: while a trip is active
	// the log day is keyed in the trip's timezone (Spec §4.5). Because log_day is
	// keyed on a date string, the 23- and 25-hour transition days are ordinary
	// rows and need no special handling.
	const trip = activeTrip();
	const date = localToday(trip?.tripTz ?? settings.timezone, now);
	const period = openPeriodOn(date);

	const entries = db
		.select({
			id: schema.txn.id,
			amountMinor: schema.txn.amountMinor,
			category: schema.txn.category,
			amountLocalMinor: schema.txn.amountLocalMinor,
			planned: schema.txn.planned,
			note: schema.txn.note,
			enteredAt: schema.txn.enteredAt
		})
		.from(schema.txn)
		.where(eq(schema.txn.spentOn, date))
		.orderBy(desc(schema.txn.id))
		.all()
		.map((r) => ({
			id: r.id,
			amountMinor: r.amountMinor,
			amountLocalMinor: r.amountLocalMinor,
			category: r.category as CategoryKey,
			planned: r.planned === 1,
			note: r.note,
			enteredAt: r.enteredAt
		}));

	// The whole log_day history: the streak needs the longest run, and one
	// user's nightly rows are a few thousand strings even after a decade.
	const allLogged = new Set(
		db
			.select({ loggedOn: schema.logDay.loggedOn })
			.from(schema.logDay)
			.all()
			.map((r) => r.loggedOn)
	);

	const stripFrom = addDays(date, -(STRIP_DAYS - 1));
	const strip = Array.from({ length: STRIP_DAYS }, (_, i) => {
		const d = addDays(stripFrom, i);
		return { date: d, logged: allLogged.has(d) };
	});

	// The band comes from the period's frozen daily_allowance_minor — never
	// recomputed against what is left (Spec §6.1).
	const band = period
		? displayBand(period.dailyAllowanceMinor, {
				bandPct: settings.bandPct,
				roundingStep: settings.roundingStep
			})
		: null;

	const due = weeklyReviewDue(date, settings.weekStartsOn);

	let tripView: TodayView['trip'] = null;
	if (trip) {
		const drawnHome = tripSpentMinor(trip.id);
		const drawnLocal = tripSpentLocalMinor(trip.id);
		const figure = tripDailyFigure(
			{
				envelopeMinor: trip.envelopeMinor,
				bufferDrawMinor: trip.bufferDrawMinor,
				endsOn: trip.endsOn
			},
			drawnHome,
			date
		);

		// The hero is in the trip's currency, because the user is standing in a
		// shop reading a price tag. A home-currency figure needs mental
		// arithmetic at exactly the moment of decision, so it is useless there.
		const scale = 10 ** (trip.localMinorUnits - settings.minorUnits);
		const toLocal = (homeMinor: number) => Math.round((homeMinor / trip.fxRateToHome) * scale);
		const envelopeHome = trip.envelopeMinor + trip.bufferDrawMinor;

		tripView = {
			id: trip.id,
			label: trip.label,
			currency: {
				code: trip.currencyCode,
				symbol: trip.currencySymbol,
				minorUnits: trip.localMinorUnits
			},
			fxRateToHome: trip.fxRateToHome,
			figureLocal: toLocal(figure.figure),
			overLocal: toLocal(figure.over),
			envelopeLocal: toLocal(envelopeHome),
			drawnLocal,
			dayOfTrip: Math.max(1, daysBetween(trip.startsOn, date) + 1),
			tripDays: daysBetween(trip.startsOn, trip.endsOn) + 1,
			burnPct: envelopeHome > 0 ? Math.min(100, (drawnHome / envelopeHome) * 100) : 0
		};
	}

	// Only within 7 days, and only the nearest one. A list of everything
	// upcoming belongs on the Irregulars screen, which is REVIEW class.
	const soon = upcoming(date, addDays(date, 7))[0] ?? null;
	const cover = soon ? coverage(date) : null;
	const horizon = soon
		? {
				label: soon.label,
				dueOn: soon.dueOn,
				funded: (cover?.balanceMinor ?? 0) >= soon.expectedMinor
			}
		: null;

	// Seven days, matching the horizon. The 30-day lead belongs to the desktop
	// notification, which fires once; this surface would simply nag.
	const subDue = subscriptionHorizon(date);
	const subscriptionDue =
		subDue && subDue.daysLeft <= 7
			? {
					id: subDue.id,
					label: subDue.label,
					deadline: subDue.deadline,
					isTrial: subDue.isTrial
				}
			: null;

	let pendingMoves: TodayView['pendingMoves'] = null;
	if (period) {
		ensureAllocations(period, date);
		const stale = stalePending(period, date);
		if (stale.length > 0) {
			pendingMoves = { count: stale.length, firstLabel: stale[0].accountName };
		}
	}

	const view: TodayView = {
		date,
		currency: {
			code: settings.currencyCode,
			symbol: settings.currencySymbol,
			minorUnits: settings.minorUnits
		},
		band,
		entries,
		dayClosed: allLogged.has(date),
		strip,
		streak: computeStreak(allLogged, date),
		reviewDue: due?.label ?? null,
		horizon,
		subscriptionDue,
		pendingMoves,
		ripeWaits: ripeItems(now).map((w) => ({
			id: w.id,
			label: w.label,
			amountMinor: w.amountMinor
		})),
		trip: tripView
	};

	return { view, settings, period };
}

/**
 * Record an explicit close for a log day. A night with zero purchases still
 * gets a row: the streak counts *logged* days, not spending days, and a
 * zero-spend day is the cheapest possible way to keep it alive (Spec §4.6).
 *
 * `isCatchup` marks the pre-authorised lossy catch-up from Method Part V — one
 * combined entry for two days, with no attempt to reconstruct details.
 */
export function closeLogDay(date: string, now: Date = new Date(), isCatchup = false): void {
	const count =
		db
			.select({ n: sql<number>`count(*)` })
			.from(schema.txn)
			.where(eq(schema.txn.spentOn, date))
			.get()?.n ?? 0;

	const stamp = now.toISOString();
	db.insert(schema.logDay)
		.values({ loggedOn: date, entryCount: count, isCatchup: isCatchup ? 1 : 0, closedAt: stamp })
		.onConflictDoUpdate({
			target: schema.logDay.loggedOn,
			set: { entryCount: count, closedAt: stamp }
		})
		.run();
}

/** True if `date` is the single-day gap the streak will still forgive today. */
export function catchUpEligible(date: string, today: string): boolean {
	const logged = new Set(
		db
			.select({ loggedOn: schema.logDay.loggedOn })
			.from(schema.logDay)
			.where(
				and(gte(schema.logDay.loggedOn, addDays(today, -3)), lte(schema.logDay.loggedOn, today))
			)
			.all()
			.map((r) => r.loggedOn)
	);
	return computeStreak(logged, today).catchUpDate === date;
}

/** Recomputed for the period-open path only. See allowance.ts for the rule. */
export { dailyAllowance };

// ─── The guard (Spec §4.2) ────────────────────────────────────────────────
// Adding a balance, a category total or a precise remaining figure to
// TodayView turns the next line into a compile error naming the field.
type _withholdingGuard = Assert<DailySurfaceVerdict<TodayView>>;
