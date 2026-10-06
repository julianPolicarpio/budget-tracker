import { fail, redirect, type Actions } from '@sveltejs/kit';
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { forUser, schema } from '$lib/server/db';
import { loadSettings } from '$lib/server/today';
import { localToday } from '$lib/server/clock';
import { openPeriodOn } from '$lib/server/rollover';
import { parseMoney } from '$lib/money';
import * as panels from '$lib/server/panel-forms';
import { mapResult } from '$lib/server/panel-forms';
import { isCategory } from '$lib/categories';
import {
	addMonths,
	coverage,
	estimateAccuracy,
	materialise,
	monthlyOutflow,
	overdue,
	paddedAmount,
	requiredAccrualPerPeriod,
	rescheduleInstance,
	settleInstance,
	skipInstance,
	upcoming
} from '$lib/server/irregulars';
import {
	FundingError,
	fundPlannedExpense,
	outstandingFor,
	reservationBucketId,
	unassignedInBucket
} from '$lib/server/reservations';
import type { PageServerLoad } from './$types';

const CADENCES = [
	'one_off',
	'monthly',
	'quarterly',
	'semiannual',
	'annual',
	'every_n_years'
] as const;

export const load: PageServerLoad = ({ locals }) => {
	const settings = loadSettings(locals.userId);
	if (!settings) return { ready: false as const };

	const { db, owns } = forUser(locals.userId);
	const today = localToday(settings.timezone);
	// Cheap and idempotent; keeps the page honest if the nightly job was missed.
	materialise(locals.userId, today);

	const period = openPeriodOn(locals.userId, today);

	// The two series for the accrual chart are both recoverable from the review
	// snapshots: the balance is asserted at R1, and dividing it by the stored
	// coverage ratio gives back what was due in the 90 days from that date.
	const history = db
		.select({
			endsOn: schema.review.endsOn,
			accruedMinor: schema.review.irregularsMinor,
			coverageRatioBp: schema.review.coverageRatioBp
		})
		.from(schema.review)
		.where(and(owns(schema.review), eq(schema.review.kind, 'weekly'), isNotNull(schema.review.completedAt)))
		.orderBy(asc(schema.review.endsOn))
		.all()
		.filter((r) => r.accruedMinor !== null)
		.map((r) => ({
			endsOn: r.endsOn,
			accruedMinor: r.accruedMinor!,
			requiredMinor:
				r.coverageRatioBp && r.coverageRatioBp > 0
					? Math.round((r.accruedMinor! * 10_000) / r.coverageRatioBp)
					: null
		}));

	const definitions = db
		.select()
		.from(schema.irregular)
		.where(and(owns(schema.irregular), isNull(schema.irregular.archivedAt)))
		.orderBy(asc(schema.irregular.nextDueOn))
		.all();

	// The funding form (A3.2) needs two numbers the reservation ledger already
	// knows: what's already promised to each expense, and what's still free to
	// promise in the Irregulars bucket. A user who archived or never had the
	// bucket sees a form with nothing to assign rather than a 500.
	let irregularsAccountId: number | null = null;
	try {
		irregularsAccountId = reservationBucketId(locals.userId);
	} catch (err) {
		if (!(err instanceof FundingError)) throw err;
	}
	const irregularsUnassignedMinor =
		irregularsAccountId !== null ? unassignedInBucket(locals.userId, irregularsAccountId) : null;
	const definitionsWithFunding = definitions.map((d) => ({
		...d,
		outstandingMinor:
			irregularsAccountId !== null ? outstandingFor(locals.userId, d.id, irregularsAccountId) : 0
	}));

	return {
		ready: true as const,
		today,
		coverage: coverage(locals.userId, today),
		overdue: overdue(locals.userId, today),
		upcoming: upcoming(locals.userId, today, addMonths(today, 12)),
		outflow: monthlyOutflow(locals.userId, today),
		accuracy: estimateAccuracy(locals.userId, addMonths(today, -12)),
		history,
		definitions: definitionsWithFunding,
		irregularsAccountId,
		irregularsUnassignedMinor,
		archived: db
			.select()
			.from(schema.irregular)
			.where(and(owns(schema.irregular), isNotNull(schema.irregular.archivedAt)))
			.orderBy(desc(schema.irregular.archivedAt))
			.limit(5)
			.all(),
		accrualPerPeriod: period ? requiredAccrualPerPeriod(locals.userId, today, period.days) : null,
		periodDays: period?.days ?? null,
		currency: {
			code: settings.currencyCode,
			symbol: settings.currencySymbol,
			minorUnits: settings.minorUnits
		}
	};
};

export const actions: Actions = {
	/** Declare an irregular. Padding defaults to 25% and is shown, never hidden. */
	upsert: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const id = Number(form.get('id')) || null;

		// Create path is shared with Today's quick panel (src/lib/server/
		// panel-forms.ts, helper `createPlanned`); the edit path is this
		// route's own business — instances are re-priced here, never there.
		if (!id) {
			return mapResult(await panels.createPlanned(locals.userId, form, settings), '/irregulars');
		}

		const label = String(form.get('label') ?? '').trim();
		const cadence = String(form.get('cadence') ?? '');
		const nextDueOn = String(form.get('nextDueOn') ?? '');
		const category = String(form.get('category') ?? '');

		const amountMinor = parseMoney(String(form.get('amount') ?? ''), settings.minorUnits);
		const paddingPct = Number(form.get('paddingPct') ?? 25);
		const cadenceN = Number(form.get('cadenceN')) || null;

		if (!label) return fail(400, { error: 'Give it a name you will recognise in a year.' });
		if (!(CADENCES as readonly string[]).includes(cadence)) {
			return fail(400, { error: 'Pick a cadence.' });
		}
		if (amountMinor === null || amountMinor <= 0) {
			return fail(400, { error: 'Enter an estimate above zero.' });
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDueOn)) {
			return fail(400, { error: 'Next due date must be a real date.' });
		}
		if (!Number.isInteger(paddingPct) || paddingPct < 0 || paddingPct > 200) {
			return fail(400, { error: 'Padding must be between 0 and 200 percent.' });
		}

		const values = {
			label,
			amountMinor,
			cadence: cadence as (typeof CADENCES)[number],
			cadenceN,
			nextDueOn,
			category: isCategory(category) ? category : null,
			paddingPct,
			isEstimate: 1
		};

		const { db, owns } = forUser(locals.userId);
		if (id) {
			db.update(schema.irregular)
				.set(values)
				.where(and(owns(schema.irregular), eq(schema.irregular.id, id)))
				.run();
			// Re-price the instances that have not happened yet; settled ones are
			// history and are never rewritten.
			db.update(schema.irregularInstance)
				.set({ expectedMinor: paddedAmount(amountMinor, paddingPct) })
				.where(
					and(
						owns(schema.irregularInstance),
						eq(schema.irregularInstance.irregularId, id),
						isNull(schema.irregularInstance.settledOn)
					)
				)
				.run();
		}

		materialise(locals.userId, localToday(settings.timezone));
		redirect(303, '/irregulars');
	},

	archive: async ({ request, locals }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown irregular.' });

		const { db, owns } = forUser(locals.userId);
		db.update(schema.irregular)
			.set({ archivedAt: new Date().toISOString() })
			.where(and(owns(schema.irregular), eq(schema.irregular.id, id)))
			.run();
		redirect(303, '/irregulars');
	},

	/**
	 * Add money to a planned expense (Spec A3.2, effect matrix op 5).
	 *
	 * `sourceAccountId` absent or blank is case 2 — assigning money already
	 * sitting in the destination bucket, no balance moves. Present is case 1 —
	 * a balanced move from that bucket into the destination, then the
	 * reservation. Either way `fundPlannedExpense` does the atomic
	 * available-to-assign check; this action only parses input and translates
	 * its `FundingError` into a form error the same money can be retried with.
	 */
	fund: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		return mapResult(await panels.fund(locals.userId, form, settings), '/irregulars');
	},

	/**
	 * The forced three-way choice (Spec §4.3).
	 *
	 * There is no dismiss. The failure this prevents is the silent one: the user
	 * stops marking instances, the ledger drifts from reality, and the app keeps
	 * reporting healthy coverage while the account is empty.
	 */
	reconcile: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const instanceId = Number(form.get('instanceId'));
		const choice = String(form.get('choice') ?? '');
		if (!Number.isInteger(instanceId)) return fail(400, { error: 'Unknown instance.' });

		const today = localToday(settings.timezone);

		if (choice === 'paid') {
			const actualMinor = parseMoney(String(form.get('actual') ?? ''), settings.minorUnits);
			if (actualMinor === null || actualMinor < 0) {
				return fail(400, { error: 'Enter what it actually cost.', instanceId });
			}
			settleInstance(locals.userId, instanceId, actualMinor, String(form.get('settledOn') || today));
		} else if (choice === 'skipped') {
			skipInstance(locals.userId, instanceId);
		} else if (choice === 'rescheduled') {
			const dueOn = String(form.get('dueOn') ?? '');
			if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
				return fail(400, { error: 'Pick the new date.', instanceId });
			}
			rescheduleInstance(locals.userId, instanceId, dueOn);
		} else {
			return fail(400, { error: 'Paid, skipped or rescheduled — there is no fourth option.' });
		}

		redirect(303, '/irregulars');
	}
};
