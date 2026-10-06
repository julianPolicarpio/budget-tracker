import { fail, redirect, type Actions } from '@sveltejs/kit';
import { loadSettings } from '$lib/server/today';
import { localToday } from '$lib/server/clock';
import { openPeriodOn } from '$lib/server/rollover';
import {
	CADENCES,
	addIncomeSource,
	archiveIncomeSource,
	expectedIncome,
	listIncomeSources
} from '$lib/server/income';
import { parseMoney } from '$lib/money';
import * as panels from '$lib/server/panel-forms';
import { mapResult } from '$lib/server/panel-forms';
import {
	IouRequired,
	assertBalance,
	listAccounts,
	listGoals,
	openIous,
	recordTransfer,
	repayIou,
	upsertGoal
} from '$lib/server/accounts';
import { checklist, ensureAllocations, executeAllocation } from '$lib/server/allocations';
import { PHASES, acceptProposal, declineProposal, phaseStatus, setPhase } from '$lib/server/phases';
import type { PageServerLoad } from './$types';

/** The six fixed purposes (schema `account.kind`). Never a seventh. */
const ACCOUNT_KINDS = ['inflow', 'bills', 'spend', 'irregulars', 'buffer', 'grow'] as const;

export const load: PageServerLoad = ({ locals }) => {
	const settings = loadSettings(locals.userId);
	if (!settings) return { ready: false as const };

	const today = localToday(settings.timezone);
	const period = openPeriodOn(locals.userId, today);
	if (period) ensureAllocations(locals.userId, period, today);

	return {
		ready: true as const,
		today,
		phases: PHASES,
		phase: phaseStatus(locals.userId, settings, today),
		accounts: listAccounts(locals.userId),
		goals: listGoals(locals.userId),
		ious: openIous(locals.userId, today),
		checklist: period ? checklist(locals.userId, period, today) : [],
		incomeSources: listIncomeSources(locals.userId),
		expectedThisPeriod: period
			? expectedIncome(locals.userId, period.startsOn, period.endsOn)
			: null,
		period,
		currency: {
			code: settings.currencyCode,
			symbol: settings.currencySymbol,
			minorUnits: settings.minorUnits
		}
	};
};

export const actions: Actions = {
	/**
	 * Add an income source (invariant 7).
	 *
	 * `cadence` is validated against the same six the schema allows, and the
	 * two that are constantly conflated — biweekly and semimonthly — are
	 * separate options with different consequences, never one "twice a month"
	 * choice. See `income.ts` for why that is worth a whole column.
	 */
	addIncome: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const label = String(form.get('label') ?? '').trim();
		const cadence = String(form.get('cadence') ?? '');
		const anchorOn = String(form.get('anchorOn') ?? '').trim() || null;
		const secondDayRaw = String(form.get('secondDay') ?? '').trim();
		const amountMinor = parseMoney(String(form.get('amount') ?? ''), settings.minorUnits);

		if (!label) return fail(400, { error: 'Give it a name.' });
		if (!CADENCES.includes(cadence)) return fail(400, { error: 'Unknown cadence.' });
		if (amountMinor === null || amountMinor < 0) {
			return fail(400, { error: 'Enter an amount like 2500.' });
		}
		if (cadence !== 'irregular' && !anchorOn) {
			return fail(400, { error: 'A scheduled source needs a date it last arrived.' });
		}
		const secondDay = cadence === 'semimonthly' ? Number(secondDayRaw) : null;
		if (cadence === 'semimonthly' && !(secondDay !== null && secondDay >= 1 && secondDay <= 31)) {
			return fail(400, { error: 'Semi-monthly needs a second day of the month.' });
		}

		addIncomeSource(locals.userId, {
			label,
			amountMinor,
			cadence,
			anchorOn,
			secondDay,
			// Irregular income budgets to the LOWEST of three months, never a
			// guess and never the mean, so it starts with no baseline and
			// contributes nothing until one exists (Rule 1).
			baselineMinor: null
		});
		return { savedIncome: true };
	},

	archiveIncome: async ({ request, locals }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown source.' });
		archiveIncomeSource(locals.userId, id);
		return { archivedIncome: true };
	},

	assertBalance: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const accountId = Number(form.get('accountId'));
		const balanceMinor = parseMoney(String(form.get('balance') ?? ''), settings.minorUnits);

		if (!Number.isInteger(accountId)) return fail(400, { error: 'Unknown account.' });
		if (balanceMinor === null) return fail(400, { error: 'Enter the balance as it reads.' });

		try {
			assertBalance(locals.userId, accountId, balanceMinor, localToday(settings.timezone));
		} catch (err) {
			// The reservation guard (A3.2) speaks plainly; pass its words on.
			return fail(409, { error: err instanceof Error ? err.message : 'Could not save the balance.', accountId });
		}
		redirect(303, '/accounts');
	},

	/**
	 * Add an account (Spec A2). `kind` is one of the six fixed purposes, never
	 * a new one the user types — the buckets are the method, not a category
	 * list. Validation failures echo every entered field back so re-rendering
	 * the form loses nothing (Spec A2: "validation errors retain entered
	 * values").
	 */
	addAccount: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		return mapResult(await panels.openAccount(locals.userId, form, settings), '/accounts');
	},

	/**
	 * Rule 3 lives here: money leaving Irregulars, Buffer or Grow needs a
	 * one-line note. The 422 is not validation theatre — the note is the entire
	 * mechanism.
	 */
	transfer: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		return mapResult(await panels.transfer(locals.userId, form, settings), '/accounts');
	},

	repayIou: async ({ request, locals }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown IOU.' });
		repayIou(locals.userId, id);
		redirect(303, '/accounts');
	},

	executeMove: async ({ request, locals }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown move.' });
		executeAllocation(locals.userId, id);
		redirect(303, '/accounts');
	},

	upsertGoal: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const label = String(form.get('label') ?? '').trim();
		if (!label) {
			return fail(400, {
				error: 'Name it concretely — "Rent if I lose my job" saves more than "Buffer".'
			});
		}

		const target = String(form.get('target') ?? '').trim();
		const saved = String(form.get('saved') ?? '').trim();

		upsertGoal(locals.userId, {
			id: Number(form.get('id')) || undefined,
			accountId: Number(form.get('accountId')),
			label,
			targetMinor: target ? parseMoney(target, settings.minorUnits) : null,
			savedMinor: saved ? (parseMoney(saved, settings.minorUnits) ?? 0) : 0,
			targetDate: String(form.get('targetDate') ?? '') || null
		});
		redirect(303, '/accounts');
	},

	acceptPhase: async ({ request, locals }) => {
		const form = await request.formData();
		acceptProposal(locals.userId, Number(form.get('id')));
		redirect(303, '/accounts');
	},

	declinePhase: async ({ request, locals }) => {
		const form = await request.formData();
		declineProposal(locals.userId, Number(form.get('id')));
		redirect(303, '/accounts');
	},

	/** Move phase by hand. A downgrade is a normal event, not a failure. */
	setPhase: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const phase = Number(form.get('phase'));
		if (!Number.isInteger(phase)) return fail(400, { error: 'Unknown phase.' });

		setPhase(locals.userId, phase, localToday(settings.timezone));
		redirect(303, '/accounts');
	}
};
