import { fail, redirect, type Actions } from '@sveltejs/kit';
import { loadSettings } from '$lib/server/today';
import { localToday } from '$lib/server/clock';
import { openPeriodOn } from '$lib/server/rollover';
import { parseMoney } from '$lib/money';
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
		period,
		currency: {
			code: settings.currencyCode,
			symbol: settings.currencySymbol,
			minorUnits: settings.minorUnits
		}
	};
};

export const actions: Actions = {
	assertBalance: async ({ request, locals }) => {
		const settings = loadSettings(locals.userId);
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const accountId = Number(form.get('accountId'));
		const balanceMinor = parseMoney(String(form.get('balance') ?? ''), settings.minorUnits);

		if (!Number.isInteger(accountId)) return fail(400, { error: 'Unknown account.' });
		if (balanceMinor === null) return fail(400, { error: 'Enter the balance as it reads.' });

		assertBalance(locals.userId, accountId, balanceMinor, localToday(settings.timezone));
		redirect(303, '/accounts');
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
		const amountMinor = parseMoney(String(form.get('amount') ?? ''), settings.minorUnits);
		if (amountMinor === null || amountMinor <= 0) {
			return fail(400, { error: 'Enter an amount above zero.' });
		}

		try {
			recordTransfer(locals.userId, {
				fromAccountId: Number(form.get('fromAccountId')),
				toAccountId: Number(form.get('toAccountId')),
				amountMinor,
				movedOn: String(form.get('movedOn') || localToday(settings.timezone)),
				iouReason: String(form.get('iouReason') ?? ''),
				iouRepayBy: String(form.get('iouRepayBy') ?? '')
			});
		} catch (err) {
			if (err instanceof IouRequired) return fail(422, { error: err.message, field: 'iouReason' });
			return fail(400, { error: err instanceof Error ? err.message : 'Transfer failed.' });
		}

		redirect(303, '/accounts');
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
