/**
 * Pure-logic tests for what the typing bar shows when an action-feature pill
 * is tapped.
 *
 * `ActionView.svelte` itself is not exercised here: `vite.config.ts` defines
 * exactly one vitest project (`server`, environment `node`) and it explicitly
 * excludes `src/**\/*.svelte.{test,spec}.ts` — there is no component-rendering
 * / DOM project configured at all. So focus movement, the back button, and
 * anything else that needs a rendered DOM remain untested by this suite.
 *
 * What IS covered is every piece of logic the component delegates to
 * `$lib/actions/action-view.ts`, which is plain, DOM-free TypeScript:
 * `resolveSelection()` (unchanged from the retired panel), the wired-form
 * set, the placeholder's owner labels, and `actionViewFor()` — the mapping
 * from a pill's action id to the view the bar renders.
 */

import { describe, expect, it } from 'vitest';
import { isDemoHidden } from '../nav/demo';
import { CATALOGUE, actionById } from '../actions/catalogue';
import {
	WIRED_FORM_IDS,
	actionViewFor,
	demoVisibleActionIds,
	isWiredForm,
	placeholderTarget,
	resolveSelection
} from '../actions/action-view';

describe('resolveSelection', () => {
	it('resolves a dedicated action to its route as a navigation target', () => {
		const action = actionById('update-balance');
		expect(action).toBeDefined();
		expect(resolveSelection(action!)).toEqual({ type: 'navigate', target: '/accounts' });
	});

	it('resolves a form action to its own id as the form id', () => {
		const action = actionById('record-income');
		expect(action).toBeDefined();
		expect(resolveSelection(action!)).toEqual({ type: 'form', formId: 'record-income' });
	});

	it('agrees with the catalogue on kind for every one of the sixteen actions', () => {
		for (const action of CATALOGUE) {
			const resolution = resolveSelection(action);
			if (action.behaviour.kind === 'dedicated') {
				expect(resolution).toEqual({ type: 'navigate', target: action.route });
			} else {
				expect(resolution).toEqual({ type: 'form', formId: action.id });
			}
		}
	});
});

describe('isWiredForm', () => {
	it('accepts every quick form that Today can submit', () => {
		expect(WIRED_FORM_IDS).toEqual([
			'record-income',
			'record-refund',
			'transfer-money',
			'fund-planned-expense',
			'move-between-purposes',
			'add-trip',
			'create-planned-expense',
			'add-bill-subscription',
			'add-debt',
			'save-for-later',
			'add-account',
			'add-edit-rule'
		]);
		expect(isWiredForm('record-income')).toBe(true);
		expect(isWiredForm('record-refund')).toBe(true);
	});

	it('wires all ten actions that previously showed placeholders', () => {
		for (const id of ['transfer-money', 'fund-planned-expense', 'move-between-purposes',
			'add-trip', 'create-planned-expense', 'add-bill-subscription', 'add-debt',
			'save-for-later', 'add-account', 'add-edit-rule']) {
			expect(isWiredForm(id)).toBe(true);
		}
	});

	it('rejects ids that are not catalogue actions at all', () => {
		expect(isWiredForm('')).toBe(false);
		expect(isWiredForm('log-spending')).toBe(false);
	});
});

describe('placeholderTarget', () => {
	it('names the owning tab for a route-keyed action', () => {
		expect(placeholderTarget(actionById('transfer-money')!)).toEqual({
			href: '/accounts',
			label: 'Accounts'
		});
		expect(placeholderTarget(actionById('add-bill-subscription')!)).toEqual({
			href: '/subscriptions',
			label: 'Subscriptions'
		});
	});

	it('sends save-for-later to Wishlist rather than back to Today', () => {
		// Its catalogue route is `/` — the page the reader is already on — so
		// the special case is the only honest answer.
		const action = actionById('save-for-later')!;
		expect(action.route).toBe('/');
		expect(placeholderTarget(action)).toEqual({ href: '/rules', label: 'Wishlist' });
	});

	it('falls back to the raw route for a tab with no plain-language name', () => {
		const action = { ...actionById('add-account')!, route: '/nowhere' };
		expect(placeholderTarget(action)).toEqual({ href: '/nowhere', label: '/nowhere' });
	});
});

describe('actionViewFor', () => {
	it('renders a form for the two actions Today can submit', () => {
		expect(actionViewFor('record-income')).toMatchObject({
			kind: 'form',
			formId: 'record-income'
		});
		expect(actionViewFor('record-refund')).toMatchObject({
			kind: 'form',
			formId: 'record-refund'
		});
	});

	it('navigates for a dedicated action instead of rendering anything', () => {
		expect(actionViewFor('record-payment')).toMatchObject({
			kind: 'navigate',
			target: '/debt'
		});
	});

	it('shows the inline form for a transfer', () => {
		expect(actionViewFor('transfer-money')).toMatchObject({
			kind: 'form',
			action: { id: 'transfer-money' }
		});
	});

	it('returns undefined for an id that is not in the catalogue', () => {
		expect(actionViewFor('not-a-real-action')).toBeUndefined();
	});

	it('never returns a form for an action outside the wired set', () => {
		// The invariant the bar depends on: a rendered form is always one the
		// current page can actually submit.
		for (const action of CATALOGUE) {
			const view = actionViewFor(action.id);
			if (view?.kind === 'form') expect(isWiredForm(view.formId)).toBe(true);
		}
	});
});

describe('demoVisibleActionIds', () => {
	const allIds = CATALOGUE.map((a) => a.id);

	it('changes nothing outside demo', () => {
		expect(demoVisibleActionIds(allIds, false)).toEqual(allIds);
	});

	it('drops dedicated actions that navigate to a hidden route', () => {
		const kept = demoVisibleActionIds(allIds, true);
		for (const action of CATALOGUE) {
			if (action.behaviour.kind === 'dedicated' && isDemoHidden(action.route)) {
				expect(kept).not.toContain(action.id);
			}
		}
	});

	it('keeps inline forms, even ones that post to a hidden route', () => {
		const kept = demoVisibleActionIds(allIds, true);
		expect(kept).toContain('add-trip');
		expect(kept).toContain('transfer-money');
	});

	it('leaves only inline forms or visible-route navigations', () => {
		for (const id of demoVisibleActionIds(allIds, true)) {
			const view = actionViewFor(id)!;
			expect(['form', 'navigate']).toContain(view.kind);
			if (view.kind === 'navigate') expect(isDemoHidden(view.target)).toBe(false);
		}
	});

	it('drops unknown ids', () => {
		expect(demoVisibleActionIds(['nope'], true)).toEqual([]);
	});
});
