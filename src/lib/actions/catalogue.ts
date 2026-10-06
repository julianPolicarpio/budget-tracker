/**
 * The action catalogue (Spec A2, A6): "Build one action catalogue containing
 * labels, searchable terms, required context, and the form/operation
 * mapping." Sixteen actions, four groups, in the exact order Spec A2's table
 * gives them. Nothing here is invented or renamed — every `route`/`formAction`
 * pair below was verified against the actual route file before being written
 * (see the per-action comments for the ones that needed a judgment call).
 *
 * Spec A7: "Stable grouping, plain labels, search; no unpredictable
 * reordering." `CATALOGUE` is a flat array in that fixed order, and every
 * lookup here (`searchCatalogue`, `catalogueByGroup`) filters it rather than
 * re-sorting it, so group order and within-group order are structurally
 * impossible to disturb.
 */

import type { ContextKey } from './context';

export type ActionGroup = 'Record money' | 'Set money aside' | 'Create a plan' | 'Set up or adjust';

/**
 * What the panel does when the action is chosen.
 *
 * `dedicated` carries two separate strings on purpose. They were one field,
 * and the result was route paths, backticked identifiers and a quoted spec
 * clause rendered straight at the user in the panel — exactly the
 * "implementation terminology and research explanations" Spec A5 says to keep
 * out of primary UI. `note` is the sentence a person reads; `rationale` is the
 * engineering reason, and nothing renders it.
 */
export type ActionKind =
	| { kind: 'form' } // a quick form, rendered in the panel
	| {
			kind: 'dedicated';
			/**
			 * One short sentence, shown in the panel, saying why this opens a
			 * full page. Plain language only: no route paths, no identifiers, no
			 * spec quotations, no talk of "operations" or "actions".
			 */
			note: string;
			/** Why this is not a quick form. Developer-facing. NEVER rendered. */
			rationale: string;
	  };

export interface CatalogueAction {
	/** Stable key. Never shown to a user. */
	id: string;
	/** Plain language, what a stranger already calls it. Shown. */
	label: string;
	group: ActionGroup;
	/** Extra words a user might search for. Lowercase. Never shown. */
	terms: readonly string[];
	/** The route that owns the operation, e.g. '/irregulars'. */
	route: string;
	/** The named form action on that route, e.g. 'fund'. Null for dedicated workflows that are pure navigation. */
	formAction: string | null;
	/** Which context slices the form needs. See ActionContext in ./context. */
	needs: readonly ContextKey[];
	behaviour: ActionKind;
}

export const CATALOGUE: readonly CatalogueAction[] = [
	// ---- Record money ----------------------------------------------------
	{
		id: 'log-spending',
		label: 'Log spending',
		group: 'Record money',
		terms: ['spend', 'expense', 'purchase', 'buy', 'bought', 'log'],
		route: '/',
		// Today's typed-entry router (Spec §5.6), already directly on Today.
		// Spec A2: "Ordinary spending entry must not gain an extra step" — the
		// panel entry for this action is a shortcut back to that existing
		// direct form, never a second copy of it.
		formAction: 'logEntry',
		needs: [],
		behaviour: { kind: 'form' }
	},
	{
		id: 'record-income',
		label: 'Record income',
		group: 'Record money',
		terms: ['income', 'salary', 'arrival', 'deposit', 'paycheck', 'pay'],
		route: '/',
		formAction: 'landMoney',
		needs: ['accounts'],
		behaviour: { kind: 'form' }
	},
	{
		id: 'transfer-money',
		label: 'Transfer money',
		group: 'Record money',
		terms: ['move', 'send', 'bank', 'e-wallet', 'gcash'],
		route: '/accounts',
		formAction: 'transfer',
		needs: ['accounts'],
		behaviour: { kind: 'form' }
	},
	{
		id: 'record-payment',
		label: 'Record a payment',
		group: 'Record money',
		terms: ['pay', 'payment', 'bill', 'debt', 'obligation', 'settle'],
		// No single existing route action records a bill, debt, or
		// planned-expense payment uniformly (verified against every actions
		// object in src/routes/*/+page.server.ts):
		//  - /debt has `payment`, with an explicit source account — debt only.
		//  - /subscriptions has no payment action at all: `used` only stamps
		//    `lastUsedOn`, and `cancel`/`keep` are post-alert decisions, not a
		//    recorded charge.
		//  - /irregulars has no `pay` action either; its `reconcile` action
		//    with choice 'paid' is op 11 (settle an irregular instance), a
		//    different existing operation from op 6 "Pay planned expense" in
		//    docs/effect-matrix.md, which the matrix itself marks NEW/not yet
		//    built (reservations do not exist for planned expenses yet).
		// Spec A2: "Payment forms must distinguish a bill, debt, or other
		// supported obligation rather than using an ambiguous subtraction" —
		// that distinguishing form does not exist yet. Per this task's
		// instructions this is marked dedicated rather than wired to a
		// single-obligation action that would misrepresent the other two.
		// `/debt` is named as the destination only because it is the closest
		// existing "record a payment" workflow today; Task 2c/3 must decide
		// the real entry point (and whether bills/planned-expenses need their
		// own payment operations first).
		route: '/debt',
		formAction: null,
		needs: [],
		behaviour: {
			kind: 'dedicated',
			note: 'Bills, debts and planned expenses each record a payment differently, so this opens the right tab for what you are paying.',
			rationale:
				'No single operation records a bill, debt, or planned-expense payment today: /debt has payment (debt only), /subscriptions has no payment action, and /irregulars conflates payment with settlement (effect-matrix op 11 is settle, not op 6 pay). A2 requires payment forms to distinguish the obligation, so this needs a designed operation, not an improvised one.'
		}
	},
	{
		id: 'record-refund',
		label: 'Record a refund',
		group: 'Record money',
		terms: ['refund', 'money back', 'reimbursement', 'returned'],
		route: '/',
		formAction: 'refundMoney',
		needs: ['refundable', 'accounts'],
		behaviour: { kind: 'form' }
	},

	// ---- Set money aside ---------------------------------------------------
	{
		id: 'fund-planned-expense',
		label: 'Fund a planned expense',
		group: 'Set money aside',
		terms: ['add money', 'set aside', 'allocate', 'reserve', 'fund'],
		route: '/irregulars',
		formAction: 'fund',
		needs: ['plannedExpenses', 'accounts'],
		behaviour: { kind: 'form' }
	},
	{
		id: 'move-between-purposes',
		label: 'Move money between purposes',
		group: 'Set money aside',
		terms: ['move', 'reallocate', 'purpose', 'bucket', 'shift'],
		// Same route/action as "Transfer money" above. In the current schema
		// there is no separate "bank/e-wallet account" table distinct from the
		// purpose buckets — `account.kind` IS the six purposes (inflow, bills,
		// spend, irregulars, buffer, grow; src/lib/server/db/schema.ts) — so a
		// bucket-to-bucket move and a bank/e-wallet move are the same
		// `recordTransfer()` operation today. Kept as a separate catalogue
		// entry (distinct id, distinct search terms/label) because Spec A2
		// lists them as separate actions for the user, even though they share
		// one implementation until the schema distinguishes physical location
		// from purpose.
		route: '/accounts',
		formAction: 'transfer',
		needs: ['accounts'],
		behaviour: { kind: 'form' }
	},

	// ---- Create a plan ------------------------------------------------------
	{
		id: 'add-trip',
		label: 'Add a trip',
		group: 'Create a plan',
		terms: ['trip', 'travel', 'vacation', 'abroad'],
		route: '/trips',
		formAction: 'declare',
		needs: [],
		behaviour: { kind: 'form' }
	},
	{
		id: 'create-planned-expense',
		label: 'Create a planned expense',
		group: 'Create a plan',
		terms: ['irregular', 'big bill', 'planned', 'upcoming expense'],
		route: '/irregulars',
		formAction: 'upsert',
		needs: [],
		behaviour: { kind: 'form' }
	},
	{
		id: 'add-bill-subscription',
		label: 'Add a bill or subscription',
		group: 'Create a plan',
		terms: ['subscription', 'bill', 'recurring', 'streaming'],
		// `quickAdd`, not `add`: Spec A2's "Minimum required fields first" for
		// a panel quick form. `add` is the fuller form the Subscriptions tab
		// itself uses.
		route: '/subscriptions',
		formAction: 'quickAdd',
		needs: [],
		behaviour: { kind: 'form' }
	},
	{
		id: 'add-debt',
		label: 'Add a debt',
		group: 'Create a plan',
		terms: ['debt', 'loan', 'credit card', 'owe'],
		route: '/debt',
		formAction: 'upsert',
		needs: [],
		behaviour: { kind: 'form' }
	},
	{
		id: 'save-for-later',
		label: 'Save a purchase for later',
		group: 'Create a plan',
		terms: ['wishlist', 'wait', 'wanted', 'waiting period'],
		route: '/',
		formAction: 'addWait',
		needs: [],
		behaviour: { kind: 'form' }
	},

	// ---- Set up or adjust ----------------------------------------------------
	{
		id: 'add-account',
		label: 'Add an account',
		group: 'Set up or adjust',
		terms: ['bank', 'e-wallet', 'new account'],
		route: '/accounts',
		formAction: 'addAccount',
		needs: [],
		behaviour: { kind: 'form' }
	},
	{
		id: 'set-budget',
		label: 'Set or change the spending budget',
		group: 'Set up or adjust',
		terms: ['budget', 'allowance', 'spending limit', 'period'],
		// Owner decision (first-run-setup-and-settings prompt, 2026-09-22): the
		// budget lives in Settings, not the weekly-review wizard. /settings now
		// has its own standalone setBudget form (src/routes/settings/+page.server.ts),
		// which is the sole caller of supersedePeriod() outside /review's own
		// wizard step — so this entry points there instead.
		route: '/settings',
		formAction: null,
		needs: [],
		behaviour: {
			kind: 'dedicated',
			note: 'Changing the budget closes the period you are in and opens a new one at the new amount, so it lives on its own page rather than a quick form here.',
			rationale:
				'Kept dedicated rather than a Today quick form on purpose, not just for lack of a wired endpoint: a budget you can raise from the daily screen the instant you feel over it is not a constraint, it is an escape hatch. The withholding layer (invariant 1, Spec §8.1) only works if raising the number costs more than two taps in a panel form. /settings owns supersedePeriod() through its own setBudget action and shows the resulting window and band, which a compact panel form has no room for.'
		}
	},
	{
		id: 'update-balance',
		label: 'Update a recorded balance',
		group: 'Set up or adjust',
		terms: ['balance', 'reconcile', 'correction', 'actual balance'],
		route: '/accounts',
		formAction: 'assertBalance',
		needs: ['accounts'],
		behaviour: {
			kind: 'dedicated',
			note: 'Checking a balance belongs on the Accounts page, where you can see the account you are correcting.',
			rationale:
				'Spec A2: "Detailed balance reconciliation opens Accounts. Update a recorded balance from Today opens that dedicated workspace with the account preselected." Keeping it off Today is also what keeps invariant 1 intact — a correction form has to show the current figure to be usable, and that figure must never appear on Today.'
		}
	},
	{
		id: 'add-edit-rule',
		label: 'Add or edit a personal rule',
		group: 'Set up or adjust',
		terms: ['rule', 'if then', 'habit', 'trigger'],
		route: '/rules',
		formAction: 'upsert',
		needs: [],
		behaviour: { kind: 'form' }
	}
];

const GROUP_ORDER: readonly ActionGroup[] = [
	'Record money',
	'Set money aside',
	'Create a plan',
	'Set up or adjust'
];

/**
 * Search rules (Spec A7 — "no unpredictable reordering"):
 *  - An empty/whitespace query returns everything, in catalogue order.
 *  - Case-insensitive, matches a substring of `label` OR any entry in `terms`.
 *  - Group order and within-group order are always preserved — a `.filter()`
 *    over `CATALOGUE`, never a re-sort or a relevance ranking.
 */
export function searchCatalogue(query: string): readonly CatalogueAction[] {
	const q = query.trim().toLowerCase();
	if (q === '') return CATALOGUE;
	return CATALOGUE.filter(
		(a) =>
			a.label.toLowerCase().includes(q) || a.terms.some((term) => term.toLowerCase().includes(q))
	);
}

export function actionById(id: string): CatalogueAction | undefined {
	return CATALOGUE.find((a) => a.id === id);
}

export function catalogueByGroup(): readonly {
	group: ActionGroup;
	actions: readonly CatalogueAction[];
}[] {
	return GROUP_ORDER.map((group) => ({
		group,
		actions: CATALOGUE.filter((a) => a.group === group)
	}));
}

/** The two groups whose actions are money movements you record from the bar. */
const MONEY_GROUPS: readonly ActionGroup[] = ['Record money', 'Set money aside'];

/** One pill per operation: catalogue entries sharing a `route` + `formAction` are
 *  one operation (Transfer money / Move money between purposes are the same
 *  `recordTransfer()` today — see that entry above), so the first one wins and
 *  two pills never open the same form. */
function dedupeByOperation(actions: readonly CatalogueAction[]): CatalogueAction[] {
	const seen = new Set<string>();
	return actions.filter((action) => {
		const operation = `${action.route}|${action.formAction ?? ''}`;
		if (seen.has(operation)) return false;
		seen.add(operation);
		return true;
	});
}

/**
 * The action features surfaced as pills on the typing bar (user request):
 * opening the shortcut should show what else the app can do besides logging
 * spending, so this row is the catalogue's money operations rather than the
 * user's usual commitments.
 *
 * Derived from `CATALOGUE`, never re-declared, so a pill can never drift from
 * the palette entry it opens:
 *  - the two money groups only — `Create a plan` / `Set up or adjust` are setup
 *    work, not something you record from the typing bar;
 *  - `log-spending` is dropped because this bar already is logging;
 *  - one pill per operation (see `dedupeByOperation`).
 * `catalogue.test.ts` pins the ids that have to survive all three rules.
 */
export const ACTION_PILLS: readonly CatalogueAction[] = dedupeByOperation(
	CATALOGUE.filter((action) => MONEY_GROUPS.includes(action.group) && action.id !== 'log-spending')
);
