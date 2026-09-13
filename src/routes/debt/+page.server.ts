import { fail, redirect, type Actions } from '@sveltejs/kit';
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { forUser, schema } from '$lib/server/db';
import { loadSettings } from '$lib/server/today';
import { localToday } from '$lib/server/clock';
import { openPeriodOn } from '$lib/server/rollover';
import { parseMoney } from '$lib/money';
import { payoffPlan } from '$lib/server/payoff';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url, locals }) => {
	const settings = loadSettings(locals.userId);
	if (!settings) return { ready: false as const };

	const { db, owns } = forUser(locals.userId);
	const today = localToday(settings.timezone);
	const debts = db
		.select()
		.from(schema.debt)
		.where(and(owns(schema.debt), isNull(schema.debt.closedOn)))
		.orderBy(desc(schema.debt.aprBp))
		.all();

	// One period of Spend is the yardstick the switch is priced against.
	const period = openPeriodOn(locals.userId, today);
	const spendAllocationMinor = period?.spendAllocMinor ?? 0;

	const inputs = debts.map((d) => ({
		id: d.id,
		label: d.label,
		balanceMinor: d.balanceMinor,
		aprBp: d.aprBp,
		minPaymentMinor: d.minPaymentMinor
	}));

	// What you can throw at debt beyond the minimums, per month. The plan is
	// only meaningful against a real figure, so it is a visible input — and it
	// is typed in major units, like every other amount the user enters.
	const extraRaw = url.searchParams.get('extra') ?? '';
	const extraMinor = Math.max(0, parseMoney(extraRaw, settings.minorUnits) ?? 0);

	return {
		ready: true as const,
		today,
		debts,
		spendAllocationMinor,
		extraMinor,
		extraRaw,
		plan: payoffPlan(inputs, extraMinor, spendAllocationMinor),
		payments: db
			.select()
			.from(schema.debtPayment)
			.where(owns(schema.debtPayment))
			.orderBy(desc(schema.debtPayment.paidOn))
			.limit(20)
			.all(),
		closed: db
			.select()
			.from(schema.debt)
			.where(and(owns(schema.debt), isNotNull(schema.debt.closedOn)))
			.orderBy(asc(schema.debt.label))
			.all(),
		currency: {
			code: settings.currencyCode,
			symbol: settings.currencySymbol,
			minorUnits: settings.minorUnits
		}
	};
};

export const actions: Actions = {
	upsert: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const label = String(form.get('label') ?? '').trim();
		const balanceMinor = parseMoney(String(form.get('balance') ?? ''), settings.minorUnits);
		const minPaymentMinor = parseMoney(String(form.get('minPayment') ?? ''), settings.minorUnits);
		const aprPct = Number(form.get('apr'));

		if (!label) return fail(400, { error: 'Name the debt.' });
		if (balanceMinor === null || balanceMinor < 0) {
			return fail(400, { error: 'Enter the balance.' });
		}
		if (minPaymentMinor === null || minPaymentMinor < 0) {
			return fail(400, { error: 'Enter the minimum payment.' });
		}
		if (!Number.isFinite(aprPct) || aprPct < 0 || aprPct > 500) {
			return fail(400, { error: 'Enter the APR as a percentage.' });
		}

		// Basis points, so 18.5% is 1850 and no float ever reaches the database.
		const values = { label, balanceMinor, minPaymentMinor, aprBp: Math.round(aprPct * 100) };
		const id = Number(form.get('id')) || null;

		const { db, owns } = forUser(locals.userId);
		if (id) {
			db.update(schema.debt)
				.set(values)
				.where(and(owns(schema.debt), eq(schema.debt.id, id)))
				.run();
		} else {
			db.insert(schema.debt)
				.values({ ...values, userId: locals.userId })
				.run();
		}
		redirect(303, '/debt');
	},

	payment: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const debtId = Number(form.get('debtId'));
		const amountMinor = parseMoney(String(form.get('amount') ?? ''), settings.minorUnits);
		if (!Number.isInteger(debtId)) return fail(400, { error: 'Unknown debt.' });
		if (amountMinor === null || amountMinor <= 0) {
			return fail(400, { error: 'Enter an amount above zero.' });
		}

		const paidOn = String(form.get('paidOn') || localToday(settings.timezone));

		const { db, owns } = forUser(locals.userId);
		db.transaction((tx) => {
			const d = tx
				.select()
				.from(schema.debt)
				.where(and(owns(schema.debt), eq(schema.debt.id, debtId)))
				.get();
			if (!d) return;

			tx.insert(schema.debtPayment)
				.values({ debtId, paidOn, amountMinor, userId: locals.userId })
				.run();

			const remaining = Math.max(0, d.balanceMinor - amountMinor);
			tx.update(schema.debt)
				.set({ balanceMinor: remaining, closedOn: remaining === 0 ? paidOn : null })
				.where(and(owns(schema.debt), eq(schema.debt.id, debtId)))
				.run();
		});

		redirect(303, '/debt');
	}
};
