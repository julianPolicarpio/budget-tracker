import { fail, redirect, type Actions } from '@sveltejs/kit';
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { db, schema } from '$lib/server/db';
import { loadSettings } from '$lib/server/today';
import { localToday } from '$lib/server/clock';
import { openPeriodOn } from '$lib/server/rollover';
import { parseMoney } from '$lib/money';
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
import type { PageServerLoad } from './$types';

const CADENCES = [
	'one_off',
	'monthly',
	'quarterly',
	'semiannual',
	'annual',
	'every_n_years'
] as const;

export const load: PageServerLoad = () => {
	const settings = loadSettings();
	if (!settings) return { ready: false as const };

	const today = localToday(settings.timezone);
	// Cheap and idempotent; keeps the page honest if the nightly job was missed.
	materialise(today);

	const period = openPeriodOn(today);

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
		.where(and(eq(schema.review.kind, 'weekly'), isNotNull(schema.review.completedAt)))
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

	return {
		ready: true as const,
		today,
		coverage: coverage(today),
		overdue: overdue(today),
		upcoming: upcoming(today, addMonths(today, 12)),
		outflow: monthlyOutflow(today),
		accuracy: estimateAccuracy(addMonths(today, -12)),
		history,
		definitions: db
			.select()
			.from(schema.irregular)
			.where(isNull(schema.irregular.archivedAt))
			.orderBy(asc(schema.irregular.nextDueOn))
			.all(),
		archived: db
			.select()
			.from(schema.irregular)
			.where(isNotNull(schema.irregular.archivedAt))
			.orderBy(desc(schema.irregular.archivedAt))
			.limit(5)
			.all(),
		accrualPerPeriod: period ? requiredAccrualPerPeriod(today, period.days) : null,
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
	upsert: async ({ request }) => {
		const settings = loadSettings();
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const label = String(form.get('label') ?? '').trim();
		const cadence = String(form.get('cadence') ?? '');
		const nextDueOn = String(form.get('nextDueOn') ?? '');
		const category = String(form.get('category') ?? '');
		const id = Number(form.get('id')) || null;

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

		if (id) {
			db.update(schema.irregular).set(values).where(eq(schema.irregular.id, id)).run();
			// Re-price the instances that have not happened yet; settled ones are
			// history and are never rewritten.
			db.update(schema.irregularInstance)
				.set({ expectedMinor: paddedAmount(amountMinor, paddingPct) })
				.where(
					and(
						eq(schema.irregularInstance.irregularId, id),
						isNull(schema.irregularInstance.settledOn)
					)
				)
				.run();
		} else {
			db.insert(schema.irregular)
				.values({ ...values, createdAt: new Date().toISOString() })
				.run();
		}

		materialise(localToday(settings.timezone));
		redirect(303, '/irregulars');
	},

	archive: async ({ request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown irregular.' });

		db.update(schema.irregular)
			.set({ archivedAt: new Date().toISOString() })
			.where(eq(schema.irregular.id, id))
			.run();
		redirect(303, '/irregulars');
	},

	/**
	 * The forced three-way choice (Spec §4.3).
	 *
	 * There is no dismiss. The failure this prevents is the silent one: the user
	 * stops marking instances, the ledger drifts from reality, and the app keeps
	 * reporting healthy coverage while the account is empty.
	 */
	reconcile: async ({ request }) => {
		const settings = loadSettings();
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
			settleInstance(instanceId, actualMinor, String(form.get('settledOn') || today));
		} else if (choice === 'skipped') {
			skipInstance(instanceId);
		} else if (choice === 'rescheduled') {
			const dueOn = String(form.get('dueOn') ?? '');
			if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
				return fail(400, { error: 'Pick the new date.', instanceId });
			}
			rescheduleInstance(instanceId, dueOn);
		} else {
			return fail(400, { error: 'Paid, skipped or rescheduled — there is no fourth option.' });
		}

		redirect(303, '/irregulars');
	}
};
