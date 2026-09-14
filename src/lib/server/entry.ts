/**
 * The typed-entry router's server side (Spec §5.6–§5.9): builds the context
 * `parseEntry()` reads, resolves a typed string end to end, and carries out
 * the action each resolved kind implies once the caller commits it.
 *
 * `entry-parser.ts` stays pure and DB-free so it can run in the browser ahead
 * of a network round trip; everything here is the DB half that feeds it and
 * acts on what it decides. A4b (the UI) is the only caller of `resolveEntry`
 * and `commitResolvedEntry` — this file does not import or reference any UI
 * component, per A4a's scope.
 */

import { forUser, schema } from './db';
import { accountByKind } from './accounts';
import { loadSettings, closeLogDay, openPeriodOn } from './today';
import {
	listSubscriptions,
	createSubscription,
	type Cadence as SubscriptionCadence
} from './subscriptions';
import {
	listLiveIrregulars,
	createIrregular,
	currentInstanceFor,
	settleInstance,
	materialise,
	DEFAULT_PADDING_PCT,
	type Cadence as IrregularCadence
} from './irregulars';
import type { CategoryKey } from '$lib/categories';
import type { KnownCommitment, LearnedEntry, ParseContext, ParsedEntry, RouterCadence } from '$lib/entry-parser';
import { SEED_DICT, parseEntry } from '$lib/entry-parser';

/** `txn.source` (Spec §5.4) — never a balance, never shown on Today, surfaced
 * only in the weekly review. */
export type TxnSource = 'cash' | 'ewallet' | 'card' | 'bank' | 'unknown';

/** This user's label_map, keyed by `typed`. */
export function loadLabelMap(userId: number): Record<string, LearnedEntry> {
	const { db, owns } = forUser(userId);
	const rows = db.select().from(schema.labelMap).where(owns(schema.labelMap)).all();
	const out: Record<string, LearnedEntry> = {};
	for (const r of rows) {
		out[r.typed] = { english: r.english, root: r.root as CategoryKey, leafId: r.leafId };
	}
	return out;
}

/** This user's live subscriptions and live irregulars, combined into the
 * router's own shape. */
export function routerCommitments(userId: number): KnownCommitment[] {
	const subs: KnownCommitment[] = listSubscriptions(userId).map((s) => ({
		id: s.id,
		kind: 'subscription',
		label: s.label,
		vendor: s.vendor,
		essential: s.isEssential === 1
	}));
	const irrs: KnownCommitment[] = listLiveIrregulars(userId).map((i) => ({
		id: i.id,
		kind: 'irregular',
		label: i.label,
		vendor: null
	}));
	return [...subs, ...irrs];
}

export function buildParseContext(userId: number): ParseContext {
	return {
		dict: SEED_DICT,
		learned: loadLabelMap(userId),
		commitments: routerCommitments(userId)
	};
}

/**
 * Resolve one typed string for this user: load their `label_map` and live
 * commitments, then run the pure router against it.
 *
 * This is the server-side convenience for the one-shot case (e.g. the form
 * submit that actually saves). The live-as-you-type resolution line in the
 * browser does NOT call this — it fetches a `ParseContext` once and calls
 * `parseEntry()` locally, per `entry-parser.ts`'s own module comment, so
 * every keystroke stays off the network.
 */
export function resolveEntry(userId: number, raw: string): ParsedEntry {
	const settings = loadSettings(userId);
	// A settings-less user (mid-signup) still needs an answer rather than a
	// throw — 2 is the same fallback minorUnits used nowhere else because
	// every other path already requires settings to exist first.
	const minorUnits = settings?.minorUnits ?? 2;
	return parseEntry(raw, buildParseContext(userId), minorUnits);
}

/**
 * Writes label_map once. A race or a repeat answer is silently ignored — a
 * word answered once is never asked again, and this is where that holds.
 */
export function answerWord(userId: number, typed: string, english: string, root: CategoryKey): void {
	const { db } = forUser(userId);
	db.insert(schema.labelMap)
		.values({ userId, typed, english, root })
		.onConflictDoNothing({ target: [schema.labelMap.userId, schema.labelMap.typed] })
		.run();
}

/**
 * A withdrawal is not spending, and it is not a transfer either.
 *
 * Spec §5.4 originally said it "moves the user's own money between their own
 * pockets, and the transfer table already models exactly that." It does not.
 * `transfer` was built by migration 0003 for inter-bucket moves under Rule 3,
 * and carries `CHECK (from_account_id <> to_account_id)`. A withdrawal is a
 * same-account move, because this app models BUCKETS, not the physical form
 * money is in — there is no cash-on-hand bucket to move to.
 *
 * The first attempt widened that CHECK to let a spend→spend row through. That
 * was the wrong trade: weakening a sanity constraint on a financial table to
 * store a row with no consumer, one that never touches a balance and appears
 * on no screen.
 *
 * So this records nothing, and says so. Withdrawing cash genuinely does not
 * move money between buckets, so a bucket-shaped model has nothing to write.
 * The information the owner actually wanted — where the money came from — is
 * `txn.source`: the coffee bought with that cash is logged as `source =
 * 'cash'`. That is the fact that carries meaning. The withdrawal is a no-op,
 * and the honest thing is to tell the user so rather than write a row to look
 * busy.
 *
 * Kept as a named function rather than inlined so the router has one obvious
 * place to land, and so this reasoning sits where the next person looks.
 */
export function recordCashMove(): { ok: true; wrote: 'none' } {
	return { ok: true, wrote: 'none' };
}

/**
 * Records `actual_minor` against this irregular's earliest open instance.
 * Never touches Spend or writes a `txn` row — an existing varying commitment
 * settles, it does not spend (Spec §5.6).
 */
export function recordVaryingSettlement(
	userId: number,
	irregularId: number,
	actualMinor: number,
	today: string
): { ok: true } | { ok: false; error: string } {
	const inst = currentInstanceFor(userId, irregularId);
	if (!inst) return { ok: false, error: 'No open instance for this commitment.' };
	settleInstance(userId, inst.id, actualMinor, today);
	return { ok: true };
}

export interface NewCommitmentInput {
	english: string;
	root: CategoryKey | null;
	amountMinor: number;
	cadence: RouterCadence;
	mode: 'same' | 'same_essential' | 'varies';
	today: string;
}

/**
 * Writes a new commitment (Spec §5.6's three-way "same / same and
 * non-negotiable / varies" question). Never writes a `txn` row — a new
 * commitment reserves per period via `commitmentsPerPeriod()` /
 * `requiredAccrualPerPeriod()`, it does not spend today.
 */
export function recordNewCommitment(userId: number, input: NewCommitmentInput): void {
	if (input.mode === 'varies') {
		const cadence = input.cadence as IrregularCadence;
		const paddingPct = DEFAULT_PADDING_PCT[cadence];
		createIrregular(userId, {
			label: input.english,
			amountMinor: input.amountMinor,
			cadence,
			nextDueOn: input.today,
			category: input.root ?? undefined,
			paddingPct,
			isEstimate: true
		});
		materialise(userId, input.today);
		return;
	}

	createSubscription(userId, {
		label: input.english,
		amountMinor: input.amountMinor,
		cadence: input.cadence as SubscriptionCadence,
		nextChargeOn: input.today,
		category: input.root ?? undefined,
		isEssential: input.mode === 'same_essential'
	});
}

export interface CommitOptions {
	/** Local date this is being logged against (Today's date, in the user's
	 * timezone) — every committable kind needs it, even a transfer or a
	 * settlement, neither of which touches `txn`. */
	today: string;
	now?: Date;
	/** `transaction` only — the action row's P/U choice (Spec §5.6's table).
	 * Required for that kind; ignored for every other. */
	planned?: boolean;
	source?: TxnSource;
	note?: string | null;
	clientUuid?: string | null;
	/** `new_commitment` only — the three-way question's answer and an
	 * optional root category for the weekly review's grouping. */
	commitmentMode?: 'same' | 'same_essential' | 'varies';
	commitmentRoot?: CategoryKey | null;
}

export type CommitResult =
	| { ok: true; wrote: 'transaction' | 'settlement' | 'commitment' | 'none' }
	| { ok: false; error: string };

/**
 * Commit a resolved record (Spec §5.6's action table). Dispatches on
 * `resolved.kind` so the caller never has to re-derive which write is safe —
 * that is the one decision this whole module exists to get right:
 *
 *   transaction           -> one `txn` row, spends against today's band
 *   transfer               -> one `transfer` row, band untouched
 *   existing_commitment    -> subscription: nothing to log, already reserved
 *                              irregular:   `actual_minor` on its open instance
 *   new_commitment          -> a `subscription` or `irregular` row, never `txn`
 *   ask_kind / ask_category -> refused: an open question never becomes a
 *                              silent default (Spec §5.6's table, last row)
 *
 * Every successful branch closes the log day (Spec §4.6) — typing a bill, a
 * transfer, or a settlement is still "showed up and logged" even though none
 * of them write a `txn` row, and `closeLogDay()` is idempotent so calling it
 * again after an earlier transaction the same day is harmless.
 */
export function commitResolvedEntry(
	userId: number,
	resolved: ParsedEntry,
	opts: CommitOptions
): CommitResult {
	const now = opts.now ?? new Date();

	switch (resolved.kind) {
		case 'transaction': {
			if (resolved.amountMinor === null || resolved.amountMinor <= 0) {
				return { ok: false, error: 'Enter an amount above zero.' };
			}
			if (opts.planned !== true && opts.planned !== false) {
				return { ok: false, error: 'Mark it planned or unplanned.' };
			}
			const { db } = forUser(userId);
			db.insert(schema.txn)
				.values({
					spentOn: opts.today,
					amountMinor: resolved.amountMinor,
					category: resolved.root,
					planned: opts.planned ? 1 : 0,
					note: opts.note ?? null,
					periodId: openPeriodOn(userId, opts.today)?.id ?? null,
					enteredAt: now.toISOString(),
					clientUuid: opts.clientUuid ?? null,
					label: resolved.english,
					source: opts.source ?? 'unknown',
					leafId: resolved.leafId,
					userId
				})
				.run();
			closeLogDay(userId, opts.today, now);
			return { ok: true, wrote: 'transaction' };
		}

		case 'transfer': {
			if (resolved.amountMinor === null || resolved.amountMinor <= 0) {
				return { ok: false, error: 'Enter an amount above zero.' };
			}
			recordCashMove();
			// The day still closes: the user opened the app and accounted for
			// their money, which is what the streak measures (Spec §4.6).
			closeLogDay(userId, opts.today, now);
			return { ok: true, wrote: 'none' };
		}

		case 'existing_commitment': {
			if (resolved.commitment.kind === 'subscription') {
				// "Already covered. Reserved every period, nothing to log."
				// No txn, no transfer, no settlement — this branch is the whole
				// reason this module exists (Spec §5.6's governing rule).
				closeLogDay(userId, opts.today, now);
				return { ok: true, wrote: 'none' };
			}
			if (resolved.amountMinor === null || resolved.amountMinor <= 0) {
				return { ok: false, error: 'Enter an amount above zero.' };
			}
			const r = recordVaryingSettlement(userId, resolved.commitment.id, resolved.amountMinor, opts.today);
			if (!r.ok) return r;
			closeLogDay(userId, opts.today, now);
			return { ok: true, wrote: 'settlement' };
		}

		case 'new_commitment': {
			if (resolved.amountMinor === null || resolved.amountMinor <= 0) {
				return { ok: false, error: 'Enter an amount above zero.' };
			}
			if (!opts.commitmentMode) {
				return { ok: false, error: 'Choose same, same and non-negotiable, or varies.' };
			}
			recordNewCommitment(userId, {
				english: resolved.english,
				root: opts.commitmentRoot ?? null,
				amountMinor: resolved.amountMinor,
				cadence: resolved.cadence,
				mode: opts.commitmentMode,
				today: opts.today
			});
			closeLogDay(userId, opts.today, now);
			return { ok: true, wrote: 'commitment' };
		}

		case 'ask_kind':
		case 'ask_category':
		case 'empty':
		case 'need_word':
			// An open question never becomes a silent default.
			return { ok: false, error: 'Answer the question before saving.' };
	}
}
