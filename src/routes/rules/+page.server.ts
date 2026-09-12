import { fail, redirect, type Actions } from '@sveltejs/kit';
import { loadSettings } from '$lib/server/today';
import { parseMoney } from '$lib/money';
import {
	RULE_CATEGORIES,
	addWaitItem,
	dropRateBp,
	fireRule,
	listRules,
	resolveWaitItem,
	resolvedItems,
	ripeItems,
	setRuleActive,
	upsertRule,
	waitingItems
} from '$lib/server/rules';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const settings = loadSettings();
	if (!settings) return { ready: false as const };

	const rules = listRules();
	return {
		ready: true as const,
		categories: RULE_CATEGORIES.map((c) => ({
			...c,
			rules: rules.filter((r) => r.category === c.key)
		})),
		waiting: waitingItems(),
		ripe: ripeItems(),
		resolved: resolvedItems(),
		dropRateBp: dropRateBp(),
		currency: {
			code: settings.currencyCode,
			symbol: settings.currencySymbol,
			minorUnits: settings.minorUnits
		}
	};
};

export const actions: Actions = {
	/** The count feeds the quarterly audit: which rules fired, which never did. */
	fired: async ({ request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown rule.' });
		fireRule(id);
		redirect(303, '/rules');
	},

	toggle: async ({ request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown rule.' });
		setRuleActive(id, form.get('active') === '1');
		redirect(303, '/rules');
	},

	upsert: async ({ request }) => {
		const form = await request.formData();
		const cue = String(form.get('cue') ?? '').trim();
		const action = String(form.get('action') ?? '').trim();
		const category = String(form.get('category') ?? '');

		if (!cue || !action) {
			return fail(400, {
				error: 'Both halves are required. A cue with no action is a wish, not a plan.'
			});
		}
		if (!RULE_CATEGORIES.some((c) => c.key === category)) {
			return fail(400, { error: 'Pick a category.' });
		}

		upsertRule({
			id: Number(form.get('id')) || undefined,
			cue,
			action,
			category: category as (typeof RULE_CATEGORIES)[number]['key']
		});
		redirect(303, '/rules');
	},

	addWait: async ({ request }) => {
		const settings = loadSettings();
		if (!settings) return fail(409, { error: 'Split is not initialised yet.' });

		const form = await request.formData();
		const label = String(form.get('label') ?? '').trim();
		if (!label) return fail(400, { error: 'Name the thing you want.' });

		const raw = String(form.get('amount') ?? '').trim();
		addWaitItem(label, raw ? parseMoney(raw, settings.minorUnits) : null);
		redirect(303, '/rules');
	},

	resolve: async ({ request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		const outcome = String(form.get('outcome') ?? '');
		if (!Number.isInteger(id)) return fail(400, { error: 'Unknown item.' });
		if (outcome !== 'bought' && outcome !== 'dropped') {
			return fail(400, { error: 'Bought or dropped.' });
		}
		resolveWaitItem(id, outcome);
		redirect(303, '/rules');
	}
};
