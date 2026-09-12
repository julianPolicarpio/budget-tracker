import { fail, redirect, type Actions } from '@sveltejs/kit';
import { db, schema } from '$lib/server/db';
import { eq } from 'drizzle-orm';
import { loadSettings } from '$lib/server/today';
import { localToday, addDays } from '$lib/server/clock';
import { lastCompleteWeek, weekDays, weekOf } from '$lib/server/week';
import { logAdherenceBp, topThree, weekActuals } from '$lib/server/metrics';
import { openPeriodOn, supersedePeriod } from '$lib/server/rollover';
import { parseMoney } from '$lib/money';
import {
	REVIEW_STEPS,
	completeReview,
	ensureWeeklyReview,
	isStepKey,
	markShared,
	priorReview,
	deltaVsPrior,
	saveBalances,
	saveStep,
	stepPayloads
} from '$lib/server/review';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const settings = loadSettings();
	if (!settings) return { ready: false as const };

	const today = localToday(settings.timezone);
	const week = lastCompleteWeek(today, settings.weekStartsOn);
	const review = ensureWeeklyReview(week);
	const done = stepPayloads(review.id);

	// Resume at the first unfinished step unless the user asked for one.
	const firstOpen = REVIEW_STEPS.findIndex((s) => !(s.key in done));
	const requested = Number(url.searchParams.get('step'));
	const step = Number.isInteger(requested)
		? Math.min(Math.max(requested, 1), REVIEW_STEPS.length)
		: firstOpen === -1
			? REVIEW_STEPS.length
			: firstOpen + 1;

	const range = { from: week.startsOn, to: week.endsOn };
	const actuals = weekActuals(range);
	const prior = priorReview(review);
	const period = openPeriodOn(today);

	return {
		ready: true as const,
		step,
		steps: REVIEW_STEPS.map((s, i) => ({ ...s, n: i + 1, done: s.key in done })),
		week,
		review,
		prior: prior
			? {
					label: prior.periodLabel,
					unplannedRatioBp: prior.unplannedRatioBp,
					totalSpentMinor: prior.totalSpentMinor,
					// R1's ghosts: last week's assertions, so a typo of 1,860 for
					// 18,600 is visible as a tenfold drop rather than accepted.
					spendBalanceMinor: prior.spendBalanceMinor,
					irregularsMinor: prior.irregularsMinor,
					bufferMinor: prior.bufferMinor,
					debtTotalMinor: prior.debtTotalMinor
				}
			: null,
		delta: deltaVsPrior(review, prior),
		payloads: done,
		actuals,
		topThree: topThree(range),
		adherenceBp: logAdherenceBp(range),
		aheadDays: weekDays(weekOf(addDays(week.endsOn, 1), settings.weekStartsOn)),
		period,
		currency: {
			code: settings.currencyCode,
			symbol: settings.currencySymbol,
			minorUnits: settings.minorUnits
		},
		haircutPct: settings.haircutPct,
		bandPct: settings.bandPct,
		roundingStep: settings.roundingStep,
		weeklyTakeHomeMinor: settings.weeklyTakeHomeMinor
	};
};

function requireContext() {
	const settings = loadSettings();
	if (!settings) return null;
	const today = localToday(settings.timezone);
	const week = lastCompleteWeek(today, settings.weekStartsOn);
	return { settings, today, week, review: ensureWeeklyReview(week) };
}

export const actions: Actions = {
	/** R1 — the four asserted balances. Typing them is the work (F7). */
	balances: async ({ request }) => {
		const ctx = requireContext();
		if (!ctx) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const read = (name: string): number | null => {
			const raw = String(form.get(name) ?? '').trim();
			if (raw === '') return null;
			return parseMoney(raw, ctx.settings.minorUnits);
		};

		const values = {
			spendBalanceMinor: read('spend'),
			irregularsMinor: read('irregulars'),
			bufferMinor: read('buffer'),
			debtTotalMinor: read('debt')
		};

		for (const [name, v] of Object.entries(values)) {
			if (v !== null && v < 0) return fail(400, { error: `${name} cannot be negative.`, step: 1 });
		}

		saveBalances(ctx.review.id, values);
		saveStep(ctx.review.id, 'balances', values);
		redirect(303, '/review?step=2');
	},

	/** R2–R4 — acknowledgement steps whose payload is the answers themselves. */
	step: async ({ request }) => {
		const ctx = requireContext();
		if (!ctx) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const key = String(form.get('stepKey') ?? '');
		if (!isStepKey(key)) return fail(400, { error: 'Unknown step.' });

		const payload: Record<string, unknown> = {};
		for (const [k, v] of form.entries()) {
			if (k === 'stepKey' || k === 'next') continue;
			payload[k] = String(v);
		}

		saveStep(ctx.review.id, key, payload);
		const next = Number(form.get('next'));
		redirect(303, `/review?step=${Number.isInteger(next) ? next : 1}`);
	},

	/**
	 * R5 — adjust the number. Creates a superseding period; it never edits the
	 * open one. A budget you are allowed to update is a budget you do not
	 * abandon (F5).
	 */
	adjust: async ({ request }) => {
		const ctx = requireContext();
		if (!ctx) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const keep = form.get('keep') === '1';

		if (!keep) {
			const period = openPeriodOn(ctx.today);
			if (!period) return fail(409, { error: 'No open period to adjust.', step: 5 });

			const alloc = parseMoney(String(form.get('alloc') ?? ''), ctx.settings.minorUnits);
			if (alloc === null || alloc <= 0) {
				return fail(400, { error: 'Enter a Spend allocation above zero.', step: 5 });
			}
			if (alloc !== period.spendAllocMinor) {
				supersedePeriod(period, alloc, ctx.settings);
			}
		}

		saveStep(ctx.review.id, 'adjust', { keep });
		redirect(303, '/review?step=6');
	},

	/** R6 — snapshot the metrics, write the row, generate the one-liner. */
	complete: async () => {
		const ctx = requireContext();
		if (!ctx) return fail(409, { error: 'Split is not initialised yet.' });

		saveStep(ctx.review.id, 'send', { completed: true });
		completeReview(ctx.review, ctx.settings);
		redirect(303, '/review?step=6');
	},

	/** The public-reporting moderator, and it is one tap (F7). */
	share: async () => {
		const ctx = requireContext();
		if (!ctx) return fail(409, { error: 'Split is not initialised yet.' });

		const row = db.select().from(schema.review).where(eq(schema.review.id, ctx.review.id)).get();
		if (!row?.completedAt) return fail(409, { error: 'Finish the review first.', step: 6 });

		markShared(ctx.review.id);
		return { shared: true };
	}
};
