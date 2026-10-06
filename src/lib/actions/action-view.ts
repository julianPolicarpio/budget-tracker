/**
 * What a catalogue action *is* when it is opened from the typing bar.
 *
 * The Actions panel this used to serve is gone (owner request): the bar's
 * action-feature pills are the catalogue's way in now, so the same decision
 * — "what happens when this action is chosen" — is made here, where the bar
 * can read it. Kept as plain, DOM-free TypeScript for the same reason it was
 * split out before: `vite.config.ts`'s only vitest project (`server`) runs
 * `.test.ts` files under `node` and excludes `*.svelte.{test,spec}.ts`
 * outright, so there is no component-rendering project at all — real focus
 * movement and the rendered DOM stay untested by this suite.
 *
 * `resolveSelection()` is unchanged from the panel's day: a `dedicated`
 * action resolves to a navigation target, a `form` action to its own id.
 * `actionViewFor()` says what the bar can render and submit. All quick forms
 * have Today handlers that call the same shared operations as their owning
 * tabs; dedicated actions still navigate to their full-page workflows.
 */

import type { CatalogueAction } from './catalogue';
import { actionById } from './catalogue';

export type SelectionResolution =
	{ type: 'navigate'; target: string } | { type: 'form'; formId: string };

/**
 * What choosing `action` means. `dedicated` actions resolve to a navigation
 * target (`action.route`); `form` actions resolve to a form id — currently
 * just `action.id`, kept as its own field rather than reusing `id` directly
 * so the view's form-id switch reads as intentional rather than incidental.
 */
export function resolveSelection(action: CatalogueAction): SelectionResolution {
	return action.behaviour.kind === 'dedicated'
		? { type: 'navigate', target: action.route }
		: { type: 'form', formId: action.id };
}

/** Form ids the typing bar can render and submit on Today. */
export const WIRED_FORM_IDS = [
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
] as const;

export type WiredFormId = (typeof WIRED_FORM_IDS)[number];

export function isWiredForm(formId: string): formId is WiredFormId {
	return (WIRED_FORM_IDS as readonly string[]).includes(formId);
}

/**
 * Plain-language name of the tab that owns an action's real form, for the
 * "not built here yet, go to X" copy. Keyed by `action.route` except
 * `save-for-later`, which is special-cased: its catalogue `route` is `/`
 * (its `addWait` action lives on Today's own +page.server.ts) but Today has
 * no UI for it, and the Wishlist tab is where a saved-for-later item is
 * actually surfaced and resolved — the honest place to send someone rather
 * than a link back to the page they are already on.
 */
const OWNER_LABEL: Record<string, string> = {
	'/accounts': 'Accounts',
	'/irregulars': 'Big bills',
	'/trips': 'Trips',
	'/subscriptions': 'Subscriptions',
	'/debt': 'Debt',
	'/rules': 'Wishlist',
	'/review': 'Weekly review',
	'/trends': 'Trends'
};

export function placeholderTarget(action: CatalogueAction): { href: string; label: string } {
	if (action.id === 'save-for-later') return { href: '/rules', label: 'Wishlist' };
	return { href: action.route, label: OWNER_LABEL[action.route] ?? action.route };
}

export type ActionViewResolution =
	| { kind: 'form'; action: CatalogueAction; formId: WiredFormId }
	| { kind: 'placeholder'; action: CatalogueAction }
	| { kind: 'navigate'; action: CatalogueAction; target: string };

/** What the typing bar should show for `actionId` — `undefined` for an id
 * that is not in the catalogue at all (a stale pill, a typo). */
export function actionViewFor(actionId: string): ActionViewResolution | undefined {
	const action = actionById(actionId);
	if (!action) return undefined;
	const resolution = resolveSelection(action);
	if (resolution.type === 'navigate') {
		return { kind: 'navigate', action, target: resolution.target };
	}
	return isWiredForm(resolution.formId)
		? { kind: 'form', action, formId: resolution.formId }
		: { kind: 'placeholder', action };
}
