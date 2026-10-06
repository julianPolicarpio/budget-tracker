/**
 * Panel forms — the form bodies the owning route and Today's quick form share.
 *
 * Every form here exists on two screens: the page that owns the thing
 * (`/accounts`, `/irregulars`, `/trips`, `/debt`, `/rules`, `/subscriptions`)
 * and the quick-add panel on Today (Spec A6: do not duplicate accounting code
 * across routes). The body — validation, messages, the op call and the catch
 * mapping — lives here once. Each action is a thin wrapper: guard settings,
 * hand the parsed form over, and map the outcome back into the route's own
 * `fail(...)` / `redirect(...)`.
 *
 * A helper returns
 *
 *   { ok: true, data }       — the action's success payload, unchanged
 *   { fail: [status, body] } — the exact arguments for `fail(status, body)`
 *
 * so both entry points report identical results, field for field.
 */
import { fail, redirect } from '@sveltejs/kit';
import { isCategory } from '$lib/categories';
import { parseMoney } from '$lib/money';
import { IouRequired, createAccount, recordTransfer } from '$lib/server/accounts';
import { runActionOnce } from '$lib/server/action-requests';
import { daysBetween, localToday } from '$lib/server/clock';
import { forUser, schema } from '$lib/server/db';
import type { Settings } from '$lib/server/db/schema';
import { createIrregular, materialise } from '$lib/server/irregulars';
import { FundingError, fundPlannedExpense } from '$lib/server/reservations';
import { RULE_CATEGORIES, addWaitItem, upsertRule as recordRule } from '$lib/server/rules';
import { createSubscription } from '$lib/server/subscriptions';
import { TripTooLong, declareTrip } from '$lib/server/trips';
import {
	CADENCES,
	DEFAULT_LEAD_DAYS,
	FINAL_ALERT_DAYS,
	trialAlertDays,
	type Cadence
} from '$lib/subscription-cadence';

/** A helper's outcome: the success payload, or the arguments for `fail(...)`. */
export type PanelResult =
	| { ok: true; data: Record<string, unknown> }
	| { fail: [number, Record<string, unknown>] };

/** The six fixed purposes (schema `account.kind`). Never a seventh. */
const ACCOUNT_KINDS = ['inflow', 'bills', 'spend', 'irregulars', 'buffer', 'grow'] as const;

/**
 * The six irregular cadences, in one place. The owning route's *edit* path
 * validates against this same list — the two screens must never drift.
 */
export const IRREGULAR_CADENCES = [
	'one_off',
	'monthly',
	'quarterly',
	'semiannual',
	'annual',
	'every_n_years'
] as const;

/** YYYY-MM-DD, and a real date — `2027-02-31` parses but does not exist. */
function isDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const d = new Date(value + 'T00:00:00Z');
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Turn a helper's outcome into a route action's return value. The owning page
 * redirects to itself (a SvelteKit action must not fall through); Today's quick
 * panel keeps the caller on Today with no redirect (see `mapPanel`).
 */
export function mapResult(
	result: PanelResult,
	redirectTo: string
): Record<string, unknown> | import('@sveltejs/kit').ActionFailure<Record<string, unknown>> {
	if ('fail' in result) return fail(result.fail[0], result.fail[1]);
	redirect(303, redirectTo);
}

/**
 * Move money between buckets (Spec A2). Rule 3 lives here: money leaving
 * Irregulars, Buffer or Grow needs a one-line note and a repay-by date, and
 * the 422 is not validation theatre — the note is the entire mechanism.
 */
export async function transfer(
	userId: number,
	form: FormData,
	settings: Settings
): Promise<PanelResult> {
	const amountMinor = parseMoney(String(form.get('amount') ?? ''), settings.minorUnits);
	if (amountMinor === null || amountMinor <= 0) {
		return { fail: [400, { error: 'Enter an amount above zero.' }] };
	}

	try {
		recordTransfer(userId, {
			fromAccountId: Number(form.get('fromAccountId')),
			toAccountId: Number(form.get('toAccountId')),
			amountMinor,
			movedOn: String(form.get('movedOn') || localToday(settings.timezone)),
			iouReason: String(form.get('iouReason') ?? ''),
			iouRepayBy: String(form.get('iouRepayBy') ?? ''),
			feeMinor: parseMoney(String(form.get('fee') ?? ''), settings.minorUnits) ?? 0,
			clientUuid: String(form.get('clientUuid') ?? '') || null
		});
	} catch (err) {
		if (err instanceof IouRequired) {
			return { fail: [422, { error: err.message, field: 'iouReason' }] };
		}
		return { fail: [400, { error: err instanceof Error ? err.message : 'Transfer failed.' }] };
	}

	return { ok: true, data: { transferred: true } };
}

/**
 * Add money to a planned expense (Spec A3.2, effect matrix op 5).
 *
 * `sourceAccountId` absent or blank is case 2 — assigning money already
 * sitting in the destination bucket, no balance moves. Present is case 1 —
 * a balanced move from that bucket into the destination, then the
 * reservation. Either way `fundPlannedExpense` does the atomic
 * available-to-assign check; this helper only parses input and translates
 * its `FundingError` into a form error the same money can be retried with.
 */
export async function fund(
	userId: number,
	form: FormData,
	settings: Settings
): Promise<PanelResult> {
	const irregularId = Number(form.get('irregularId'));
	const accountId = Number(form.get('accountId'));
	const rawSource = String(form.get('sourceAccountId') ?? '').trim();
	const sourceAccountId = rawSource ? Number(rawSource) : null;
	const rawAmount = String(form.get('amount') ?? '');
	const note = String(form.get('note') ?? '').trim() || null;
	const clientUuid = String(form.get('clientUuid') ?? '') || null;

	const amountMinor = parseMoney(rawAmount, settings.minorUnits);
	if (amountMinor === null || amountMinor <= 0) {
		return { fail: [400, { field: 'amount', error: 'Enter an amount above zero.', rawAmount }] };
	}

	try {
		fundPlannedExpense(userId, {
			irregularId,
			accountId,
			amountMinor,
			sourceAccountId,
			note,
			clientUuid
		});
	} catch (err) {
		if (err instanceof FundingError) {
			return { fail: [409, { field: 'amount', error: err.message, rawAmount }] };
		}
		// A repeat of the same client_uuid is a double-submit, not an error.
		// Checking for BOTH substrings, rather than swallowing every "UNIQUE"
		// message, keeps a genuinely different constraint violation visible
		// instead of silently reporting success for it.
		const message = err instanceof Error ? err.message : '';
		if (!message.includes('UNIQUE') || !message.includes('client_uuid')) throw err;
	}

	return { ok: true, data: { funded: true } };
}

/** Declare an irregular. Padding defaults to 25% and is shown, never hidden. */
export async function createPlanned(
	userId: number,
	form: FormData,
	settings: Settings
): Promise<PanelResult> {
	const label = String(form.get('label') ?? '').trim();
	const cadence = String(form.get('cadence') ?? '');
	const nextDueOn = String(form.get('nextDueOn') ?? '');
	const category = String(form.get('category') ?? '');

	const amountMinor = parseMoney(String(form.get('amount') ?? ''), settings.minorUnits);
	const paddingPct = Number(form.get('paddingPct') ?? 25);
	const cadenceN = Number(form.get('cadenceN')) || null;

	if (!label) return { fail: [400, { error: 'Give it a name you will recognise in a year.' }] };
	if (!(IRREGULAR_CADENCES as readonly string[]).includes(cadence)) {
		return { fail: [400, { error: 'Pick a cadence.' }] };
	}
	if (amountMinor === null || amountMinor <= 0) {
		return { fail: [400, { error: 'Enter an estimate above zero.' }] };
	}
	if (!isDate(nextDueOn)) {
		return { fail: [400, { error: 'Next due date must be a real date.' }] };
	}
	if (!Number.isInteger(paddingPct) || paddingPct < 0 || paddingPct > 200) {
		return { fail: [400, { error: 'Padding must be between 0 and 200 percent.' }] };
	}

	return runActionOnce(userId, 'createPlanned', String(form.get('clientUuid') || '') || null, form, () => {
		createIrregular(userId, {
			label,
			amountMinor,
			cadence: cadence as Parameters<typeof createIrregular>[1]['cadence'],
			cadenceN,
			nextDueOn,
			category: isCategory(category) ? category : null,
			paddingPct,
			isEstimate: true
		});
		materialise(userId, localToday(settings.timezone));
		return { ok: true, data: { created: true } };
	});
}

/** Declare a trip (Spec A4). `currencyCode` is upper-cased, never trusted as typed. */
export async function declare(
	userId: number,
	form: FormData,
	settings: Settings
): Promise<PanelResult> {
	const label = String(form.get('label') ?? '').trim();
	const startsOn = String(form.get('startsOn') ?? '');
	const endsOn = String(form.get('endsOn') ?? '');
	const tripTz = String(form.get('tripTz') ?? '').trim();
	const currencyCode = String(form.get('currencyCode') ?? '')
		.trim()
		.toUpperCase();
	const currencySymbol = String(form.get('currencySymbol') ?? '').trim();
	const localMinorUnits = Number(form.get('localMinorUnits'));
	const fxRateToHome = Number(form.get('fxRateToHome'));
	const estimateMinor = parseMoney(String(form.get('estimate') ?? ''), settings.minorUnits);

	if (!label) return { fail: [400, { error: 'Give the trip a name.' }] };
	if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn) || !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) {
		return { fail: [400, { error: 'Both dates are required.' }] };
	}
	if (endsOn < startsOn) return { fail: [400, { error: 'It cannot end before it starts.' }] };
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone: tripTz });
	} catch {
		return { fail: [400, { error: `"${tripTz}" is not a valid IANA timezone.` }] };
	}
	if (!currencyCode || !currencySymbol) {
		return { fail: [400, { error: 'The currency code and symbol are both needed.' }] };
	}
	// Never inherited from settings: JPY/KRW/VND have none, and a wrong
	// value here is a silent 100x entry error on the first purchase abroad.
	if (![0, 2, 3].includes(localMinorUnits)) {
		return { fail: [400, { error: 'Decimal places must be 0, 2 or 3 — check the currency.' }] };
	}
	if (!(fxRateToHome > 0)) return { fail: [400, { error: 'Enter the rate you actually got.' }] };
	if (estimateMinor === null || estimateMinor <= 0) {
		return { fail: [400, { error: 'Enter an estimate above zero.' }] };
	}

	return runActionOnce(userId, 'declareTrip', String(form.get('clientUuid') || '') || null, form, () => {
		try {
			declareTrip(userId, {
				label,
				startsOn,
				endsOn,
				tripTz,
				currencyCode,
				currencySymbol,
				localMinorUnits,
				fxRateToHome,
				estimateMinor
			});
		} catch (err) {
			if (err instanceof TripTooLong) return { fail: [422, { error: err.message }] };
			return {
				fail: [400, { error: err instanceof Error ? err.message : 'Could not declare.' }]
			};
		}
		return { ok: true, data: { declared: true } };
	});
}

/** Record a debt. APR is basis points, rounded — a card at 18.5% is 1850bp. */
export async function addDebt(
	userId: number,
	form: FormData,
	settings: Settings
): Promise<PanelResult> {
	const label = String(form.get('label') ?? '').trim();
	const balanceMinor = parseMoney(String(form.get('balance') ?? ''), settings.minorUnits);
	const minPaymentMinor = parseMoney(String(form.get('minPayment') ?? ''), settings.minorUnits);
	const aprPct = Number(form.get('apr'));

	if (!label) return { fail: [400, { error: 'Name the debt.' }] };
	if (balanceMinor === null || balanceMinor < 0) {
		return { fail: [400, { error: 'Enter the balance.' }] };
	}
	if (minPaymentMinor === null || minPaymentMinor < 0) {
		return { fail: [400, { error: 'Enter the minimum payment.' }] };
	}
	if (!Number.isFinite(aprPct) || aprPct < 0 || aprPct > 500) {
		return { fail: [400, { error: 'Enter the APR as a percentage.' }] };
	}

	const values = {
		label,
		balanceMinor,
		minPaymentMinor,
		aprBp: Math.round(aprPct * 100)
	};

	return runActionOnce(userId, 'addDebt', String(form.get('clientUuid') || '') || null, form, () => {
		const { db } = forUser(userId);
		db.insert(schema.debt)
			.values({ ...values, userId })
			.run();
		return { ok: true, data: { added: true } };
	});
}

/** Save an if-then plan (F8). Both halves or it is a wish, not an intention. */
export async function upsertRule(
	userId: number,
	form: FormData,
	settings: Settings
): Promise<PanelResult> {
	const cue = String(form.get('cue') ?? '').trim();
	const action = String(form.get('action') ?? '').trim();
	const category = String(form.get('category') ?? '');

	if (!cue || !action) {
		return {
			fail: [
				400,
				{ error: 'Both halves are required. A cue with no action is a wish, not a plan.' }
			]
		};
	}
	if (!RULE_CATEGORIES.some((c) => c.key === category)) {
		return { fail: [400, { error: 'Pick a category.' }] };
	}

	return runActionOnce(userId, 'upsertRule', String(form.get('clientUuid') || '') || null, form, () => {
		recordRule(userId, {
			cue,
			action,
			category: category as (typeof RULE_CATEGORIES)[number]['key']
		});
		return { ok: true, data: { saved: true } };
	});
}

/** Save a wanted purchase once, shared by Today and Wishlist. */
export async function addWait(
	userId: number,
	form: FormData,
	settings: Settings
): Promise<PanelResult> {
	const label = String(form.get('label') ?? '').trim();
	if (!label) return { fail: [400, { error: 'Name the thing you want.' }] };
	const raw = String(form.get('amount') ?? '').trim();
	const amountMinor = raw ? parseMoney(raw, settings.minorUnits) : null;
	if (raw && (amountMinor === null || amountMinor < 0)) {
		return { fail: [400, { field: 'amount', error: 'Enter an amount, or leave it blank.' }] };
	}
	return runActionOnce(userId, 'addWait', String(form.get('clientUuid') || '') || null, form, () => {
		addWaitItem(userId, label, amountMinor);
		return { ok: true, data: { waiting: true } };
	});
}

/**
 * Quick add — the fast path.
 *
 * Four fields, because a commitment you cannot be bothered to record is a
 * commitment that gets paid out of Spend forever. Dates are inferred: the
 * next charge is one cadence out, and an essential cost gets no cancel-by
 * deadline at all, because there is no decision pending on your own wifi.
 */
export async function quickAddBill(
	userId: number,
	form: FormData,
	settings: Settings
): Promise<PanelResult> {
	const label = String(form.get('label') ?? '').trim();
	if (!label) return { fail: [400, { field: 'quickLabel', error: 'Name it.' }] };

	const amountMinor = parseMoney(String(form.get('amount') ?? ''), settings.minorUnits);
	if (amountMinor === null || amountMinor <= 0) {
		return { fail: [400, { field: 'quickAmount', error: 'Enter the charge, like 750.' }] };
	}

	const cadence = String(form.get('cadence') ?? '') as Cadence;
	if (!CADENCES.includes(cadence)) {
		return { fail: [400, { field: 'cadence', error: 'Pick how often it bills.' }] };
	}
	const nextChargeOn = String(form.get('nextChargeOn') ?? '').trim();
	if (!isDate(nextChargeOn)) {
		return { fail: [400, { field: 'nextChargeOn', error: 'Give the billing date.' }] };
	}

	const isEssential = form.get('isEssential') === '1';
	const today = localToday(settings.timezone);

	/*
	 * "Free until" is the whole entry for a trial, and trials are the common
	 * case — a free AI offer is free today and priced later, so the only
	 * date that matters is the one where that flips. Without this the quick
	 * path records a trial as though it were already billing, which reserves
	 * real money in Bills against a charge of ₱0.
	 */
	const rawFreeUntil = String(form.get('freeUntil') ?? '').trim();
	if (rawFreeUntil && !isDate(rawFreeUntil)) {
		return { fail: [400, { field: 'freeUntil', error: 'Give a real date, or leave it blank.' }] };
	}
	if (rawFreeUntil && rawFreeUntil > nextChargeOn) {
		return {
			fail: [400, { field: 'freeUntil', error: 'The trial must end on or before the billing date.' }]
		};
	}

	// Spec §7.3: a trial used to force a flat 30-day lead regardless of how
	// long the trial itself ran, so a 7-day trial's first warning fired the
	// moment it was recorded and its second warning fired the very next
	// sweep — both alerts inside 48 hours, then silence until the charge
	// landed. The lead is now a fraction of the trial's own length, read
	// off how far the deadline is *today* (`daysBetween`), not the fixed
	// cadence default that assumes a bill's usual gap between charges. A
	// non-trial quick-add keeps exactly the prior behaviour.
	const { leadDays, finalLeadDays } = rawFreeUntil
		? trialAlertDays(daysBetween(today, rawFreeUntil))
		: { leadDays: DEFAULT_LEAD_DAYS[cadence], finalLeadDays: FINAL_ALERT_DAYS };

	return runActionOnce(userId, 'quickAddBill', String(form.get('clientUuid') || '') || null, form, () => {
		createSubscription(userId, {
			label,
			amountMinor,
			cadence,
			nextChargeOn,
			trialEndsOn: rawFreeUntil || null,
			// Non-negotiable: nothing to decide, so no deadline and no alerts.
			// Discretionary: the renewal IS the decision point (Spec §374).
			cancelByOn: isEssential ? null : nextChargeOn,
			leadDays,
			finalLeadDays,
			isEssential
		});
		return { ok: true, data: { added: true } };
	});
}

/** Open a bucket (A6, op 1). Six kinds exist; a seventh is a data error. */
export async function openAccount(
	userId: number,
	form: FormData,
	settings: Settings
): Promise<PanelResult> {
	const rawName = String(form.get('name') ?? '');
	const name = rawName.trim();
	const kind = String(form.get('kind') ?? '');
	const rawInstitution = String(form.get('institution') ?? '');
	const institution = rawInstitution.trim() || null;
	const hasCard = form.get('hasCard') === '1';
	const isCommitted = form.get('isCommitted') === '1';
	const rawBalance = String(form.get('balance') ?? '');

	const echo = { rawName, kind, rawInstitution, hasCard, isCommitted, rawBalance };

	if (!name) {
		return { fail: [400, { field: 'name', error: 'Name it something you will recognise.', ...echo }] };
	}
	if (!(ACCOUNT_KINDS as readonly string[]).includes(kind)) {
		return {
			fail: [400, { field: 'kind', error: 'Pick which of the six purposes this is.', ...echo }]
		};
	}

	// Blank means "no opening balance yet", not an error — parseMoney('')
	// returns null, which would otherwise read as unparseable input.
	const balanceMinor = rawBalance.trim() ? parseMoney(rawBalance, settings.minorUnits) : 0;
	if (balanceMinor === null || balanceMinor < 0) {
		return {
			fail: [
				400,
				{
					field: 'balance',
					error: 'Enter the opening balance as it reads, or leave it blank for zero.',
					...echo
				}
			]
		};
	}

	return runActionOnce(userId, 'openAccount', String(form.get('clientUuid') || '') || null, form, () => {
		try {
			createAccount(
				userId,
				{
					name,
					kind: kind as (typeof ACCOUNT_KINDS)[number],
					institution,
					hasCard,
					isCommitted,
					balanceMinor
				},
				localToday(settings.timezone, new Date())
			);
		} catch (err) {
			const catchErr = err instanceof Error ? err.message : 'Could not add the account.';
			return { fail: [400, { field: 'name', error: catchErr, ...echo }] };
		}
		return { ok: true, data: { added: true } };
	});
}
