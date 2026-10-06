/**
 * The shared Actions-panel context (Spec A2, A6).
 *
 * "Names-only action context can supply selectors without exposing balances
 * on Today" and "The no-balances rule applies to Today-hosted forms too:
 * account selectors show names, not balance lists." (Spec A2.) This module is
 * the one place that assembles that context, so every quick form on Today —
 * and every equivalent entry point on an owning tab — reads the same
 * names-only slices rather than each page inventing its own query.
 *
 * `Selectable` is deliberately narrow: `id`, `name`, an optional `hint`, and
 * NOTHING else. That is invariant 1 enforced by type rather than
 * by review — the same guarantee the spec asks of `todayView()`. A balance, a
 * funded amount, a remaining-to-fund amount, or any other money figure must
 * never be added here, and the interface must never be widened with an index
 * signature that would let one slip in unnoticed.
 *
 * `hint` rules (also pinned by `catalogue.test.ts`'s Invariant-1 test):
 *  - A bucket's purpose ("Spending", "Bills") — allowed.
 *  - A due date — allowed.
 *  - A balance, a funded amount, a remaining-to-fund amount, or any money
 *    figure — never allowed.
 *
 * `refundable` is the one sanctioned exception to "no money in a
 * Selectable's visible text", and only in `name`, never `hint`. Today's
 * existing refund picker already shows the original expense's amount, and
 * Spec A2 permits exactly this: "Show entered amounts, plan costs/dates, and
 * operation effects without leaking precise available-to-spend totals." An
 * expense's already-recorded amount is a past entered amount the user is
 * identifying among several candidates, not a live balance or a remaining
 * figure — so it belongs in `name` for this slice only.
 */

import { and, desc, isNull, sql } from 'drizzle-orm';
import { forUser, schema } from '$lib/server/db';
import { loadSettings } from '$lib/server/today';
import { listAccounts } from '$lib/server/accounts';
import { listLiveIrregulars } from '$lib/server/irregulars';
import { listSubscriptions } from '$lib/server/subscriptions';
import { listTrips } from '$lib/server/trips';
import { localToday, addDays } from '$lib/server/clock';
import { categoryLabel, isCategory } from '$lib/categories';
import { formatMoney } from '$lib/money';

export type ContextKey =
	| 'accounts'
	| 'plannedExpenses'
	| 'bills'
	| 'debts'
	| 'trips'
	| 'refundable';

/** Every valid `ContextKey`, for validating catalogue entries against. */
export const CONTEXT_KEYS: readonly ContextKey[] = [
	'accounts',
	'plannedExpenses',
	'bills',
	'debts',
	'trips',
	'refundable'
];

/**
 * One selectable thing: an id and what to call it. Nothing else — see the
 * module doc above. `hint` is a neutral qualifier only; never an amount.
 */
export interface Selectable {
	id: number;
	name: string;
	/** A neutral qualifier — a bucket's purpose, a due date. NEVER an amount. */
	hint?: string;
}

export interface ActionContext {
	accounts: readonly Selectable[];
	plannedExpenses: readonly Selectable[];
	bills: readonly Selectable[];
	debts: readonly Selectable[];
	trips: readonly Selectable[];
	refundable: readonly Selectable[];
}

const EMPTY_CONTEXT: ActionContext = {
	accounts: [],
	plannedExpenses: [],
	bills: [],
	debts: [],
	trips: [],
	refundable: []
};

/**
 * The six bucket kinds' plain-language purpose, exactly as `provisionUser()`
 * names the starter accounts (src/lib/server/auth.ts). A user can add more
 * than one account of the same kind (e.g. a second `spend` account for a
 * travel card), so this is shown as `hint` alongside each account's own
 * `name` rather than assumed from the name itself.
 */
const BUCKET_PURPOSE: Record<string, string> = {
	inflow: 'Income',
	bills: 'Bills',
	spend: 'Spending',
	irregulars: 'Big bills',
	buffer: 'Emergency fund',
	grow: 'Savings'
};

/**
 * Build the names-only Actions-panel context for one user.
 *
 * Handles two "nothing to show yet" cases without throwing, both of which a
 * root layout load genuinely hits:
 *  - No `locals.userId` at all — the root layout runs even for public paths
 *    (`/signin`) reached with no session, where `locals.userId` is never set.
 *  - A `userId` but no settings row yet — a signed-in user who has not
 *    finished `/setup`.
 */
export function buildActionContext(userId: number | undefined | null): ActionContext {
	if (!Number.isInteger(userId) || (userId as number) < 1) return EMPTY_CONTEXT;
	const uid = userId as number;

	const settings = loadSettings(uid);
	if (!settings) return EMPTY_CONTEXT;

	const { db, owns } = forUser(uid);
	const today = localToday(settings.timezone);

	const accounts: Selectable[] = listAccounts(uid).map((a) => ({
		id: a.id,
		name: a.name,
		hint: BUCKET_PURPOSE[a.kind]
	}));

	const plannedExpenses: Selectable[] = listLiveIrregulars(uid).map((i) => ({
		id: i.id,
		name: i.label,
		hint: i.nextDueOn
	}));

	const bills: Selectable[] = listSubscriptions(uid).map((s) => ({
		id: s.id,
		name: s.label,
		hint: s.nextChargeOn
	}));

	const debtRows = db
		.select({ id: schema.debt.id, label: schema.debt.label })
		.from(schema.debt)
		.where(and(owns(schema.debt), isNull(schema.debt.closedOn)))
		.orderBy(desc(schema.debt.aprBp))
		.all();
	const debts: Selectable[] = debtRows.map((d) => ({ id: d.id, name: d.label }));

	const trips: Selectable[] = listTrips(uid).map((t) => ({
		id: t.id,
		name: t.label,
		hint: t.status
	}));

	// Same candidate set Today's own refund picker already queries
	// (src/routes/+page.server.ts): recent expenses that are not themselves a
	// refund, newest first, capped at 30. Kept here so the shared Actions
	// panel and Today read one definition rather than two.
	const weekAgo = addDays(today, -7);
	const refundRows = db
		.select({
			id: schema.txn.id,
			amountMinor: schema.txn.amountMinor,
			category: schema.txn.category,
			spentOn: schema.txn.spentOn,
			note: schema.txn.note
		})
		.from(schema.txn)
		.where(
			and(
				owns(schema.txn),
				sql`${schema.txn.spentOn} >= ${weekAgo}`,
				sql`${schema.txn.refundOf} IS NULL`
			)
		)
		.orderBy(sql`${schema.txn.spentOn} DESC, ${schema.txn.id} DESC`)
		.limit(30)
		.all();
	const refundable: Selectable[] = refundRows.map((t) => {
		const label = isCategory(t.category) ? categoryLabel(t.category) : t.category;
		const noted = t.note ? `${label} (${t.note})` : label;
		const amount = formatMoney(t.amountMinor, {
			minorUnits: settings.minorUnits,
			symbol: settings.currencySymbol
		});
		return { id: t.id, name: `${t.spentOn} · ${noted} · ${amount}` };
	});

	return { accounts, plannedExpenses, bills, debts, trips, refundable };
}
