/**
 * The typed-entry router (Spec §5.6–§5.7).
 *
 * One field. The user types a string; this module resolves what KIND of
 * record it describes before anything saves. The governing rule: guess the
 * category freely, never guess the record kind. A wrong category costs one
 * line in a review; a wrong record kind corrupts the daily band — a bill
 * logged as a transaction is counted twice, once by `commitmentsPerPeriod()`
 * and once in Spend.
 *
 * Pure and DB-free on purpose: `ParseContext` carries everything this needs
 * (dictionary, this user's learned words, this user's live commitments) so
 * the same function can run in the browser, ahead of any network round trip.
 */

import { parseMoney } from '$lib/money';
import type { CategoryKey } from '$lib/categories';

/** A subset of both existing `Cadence` types (subscription.ts and
 * irregulars.ts), assignable to either — see A4's design notes on why those
 * two are never imported under the same name in one file. */
export type RouterCadence = 'weekly' | 'fortnightly' | 'monthly' | 'annual';

/**
 * The four things a typed entry can turn out to be, plus the two questions
 * that block until answered (Spec §5.6). This exact union is the contract
 * A4b's UI switches on — do not rename members without updating that side.
 */
export type RecordKind =
	| 'transaction'
	| 'existing_commitment'
	| 'new_commitment'
	| 'transfer'
	| 'ask_kind'
	| 'ask_category';

export interface KnownCommitment {
	id: number;
	/** subscription = fixed amount, irregular = varying. Action differs by
	 * this even though both share `existing_commitment` as the RecordKind:
	 * a subscription is already reserved and logs nothing; an irregular
	 * settles `actual_minor` against its open instance (Spec §5.6's table). */
	kind: 'subscription' | 'irregular';
	label: string;
	vendor?: string | null;
	essential?: boolean;
}

/** `null` = a known word deliberately left unmapped (ambiguous) — same as the
 * prototype's `merienda: null`. Behaviourally identical to an unrecognised
 * word (both route to `ask_category`), but distinct in the dictionary: this
 * IS a hit, just one with no safe translation. */
export type SeedDictEntry = { english: string; root: CategoryKey } | null;

export interface LearnedEntry {
	english: string;
	root: CategoryKey;
	/** Null until `promote()` (Spec §5.9) creates the leaf and backfills this
	 * user's `label_map` row alongside every past `txn`. */
	leafId: number | null;
}

export interface ParseContext {
	dict: Record<string, SeedDictEntry>;
	/** This user's label_map, keyed by lowercased `typed`. */
	learned: Record<string, LearnedEntry>;
	/** This user's live subscriptions + live irregulars. */
	commitments: KnownCommitment[];
}

export type ParsedEntry =
	// Pre-RecordKind states: not enough typed yet to route at all. The
	// browser's live resolution line needs these to show nothing (or "type an
	// amount") rather than guessing — kept distinct from `RecordKind` because
	// neither is a record the user could ever commit.
	| { kind: 'empty' }
	| { kind: 'need_word'; amountMinor: number | null }
	// From here down, `kind` is exactly a `RecordKind`.
	| { kind: 'transfer'; word: string; amountMinor: number | null }
	| {
			kind: 'existing_commitment';
			word: string;
			amountMinor: number | null;
			commitment: KnownCommitment;
	  }
	| {
			kind: 'new_commitment';
			word: string;
			/** Cadence and bill words already stripped — this string doubles as
			 * the match slug: a later bare "netflix" must find a commitment
			 * created from "netflix 549 monthly", and it matches because the
			 * stored label is this same clean value, not the raw typed text. */
			english: string;
			amountMinor: number | null;
			cadence: RouterCadence;
	  }
	| { kind: 'ask_kind'; word: string; english: string; amountMinor: number | null }
	| { kind: 'ask_category'; word: string; english: string; amountMinor: number | null }
	| {
			kind: 'transaction';
			word: string;
			english: string;
			root: CategoryKey;
			/** Set only once this label has been promoted to a leaf (Spec
			 * §5.9) — carried through from `label_map.leaf_id` so a promoted
			 * word's future transactions attach to the leaf immediately,
			 * with no extra lookup. */
			leafId: number | null;
			amountMinor: number | null;
	  };

/**
 * The seed dictionary — Filipino and Taglish spend words plus brand names,
 * ported from the reference prototype's `DICT`. Shared across every user;
 * what a user teaches beyond this lives in their own `label_map` (Spec §5.7).
 */
export const SEED_DICT: Record<string, SeedDictEntry> = {
	kape: { english: 'Coffee', root: 'food_out' },
	coffee: { english: 'Coffee', root: 'food_out' },
	merienda: null,
	tinapay: { english: 'Bread', root: 'food_in' },
	kanin: { english: 'Rice', root: 'food_in' },
	ulam: { english: 'Meal', root: 'food_in' },
	gatas: { english: 'Milk', root: 'food_in' },
	itlog: { english: 'Eggs', root: 'food_in' },
	tubig: { english: 'Water', root: 'food_in' },
	palengke: { english: 'Market', root: 'food_in' },
	grocery: { english: 'Groceries', root: 'food_in' },
	groceries: { english: 'Groceries', root: 'food_in' },
	jeep: { english: 'Jeepney', root: 'transport' },
	jeepney: { english: 'Jeepney', root: 'transport' },
	tricycle: { english: 'Tricycle', root: 'transport' },
	trike: { english: 'Tricycle', root: 'transport' },
	pamasahe: { english: 'Fare', root: 'transport' },
	grab: { english: 'Grab', root: 'transport' },
	gas: { english: 'Fuel', root: 'transport' },
	gamot: { english: 'Medicine', root: 'health' },
	meds: { english: 'Medicine', root: 'health' },
	load: { english: 'Phone load', root: 'other' },
	sabon: { english: 'Soap', root: 'stuff' },
	jollibee: { english: 'Jollibee', root: 'food_out' },
	'milk tea': { english: 'Milk tea', root: 'food_out' },
	milktea: { english: 'Milk tea', root: 'food_out' },
	inom: { english: 'Drinks', root: 'social' },
	beer: { english: 'Beer', root: 'social' }
};

const TRANSFER_WORD = /\b(withdraw|atm|transfer|moved)\b/i;
const CADENCE_WORD = /\b(fortnightly|weekly|monthly|a month|per month|\/mo|yearly|annually|a year|\/yr)\b/i;
const BILL_WORD = /\b(bill|subscription|renews|plan)\b/i;

const AMOUNT_RE = /\d+(?:[.,]\d{1,2})?/;

/**
 * Extract the first amount substring and the remaining lowercased word,
 * amount stripped, whitespace collapsed. No numeric conversion here — that
 * always goes through `parseMoney` (invariant 5, no `parseFloat` outside
 * `$lib/money`).
 */
export function extractAmountAndWord(raw: string): { amountText: string | null; word: string } {
	const m = AMOUNT_RE.exec(raw);
	const amountText = m ? m[0] : null;
	const word = raw
		.replace(AMOUNT_RE, ' ')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ');
	return { amountText, word };
}

function titleCase(s: string): string {
	if (s.length === 0) return s;
	return s[0].toUpperCase() + s.slice(1);
}

/** Tokens of a commitment's label, lowercased, 3+ chars — avoids noise matches
 * on short filler words ("a", "of", ...). See A4 design decision 6. */
function labelTokens(label: string): string[] {
	return label
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length >= 3);
}

/** Generic words every commitment label may share ("chatgpt subscription",
 * "udemy subscription", "internet bill"). They can never be the reason two
 * entries are the same commitment — if they were, "udemy subscription"
 * would match the chatgpt bill, because `word.includes("subscription")`
 * is true for both. Only distinctive tokens (vendor, brand, item) match. */
const GENERIC_LABEL_TOKENS = new Set([
	'subscription',
	'subscriptions',
	'bill',
	'bills',
	'monthly',
	'weekly',
	'yearly',
	'annual',
	'annually',
	'fortnightly',
	'plan',
	'renewal',
	'renews',
	'payment'
]);

function labelTokensDistinct(label: string): string[] {
	return labelTokens(label).filter((t) => !GENERIC_LABEL_TOKENS.has(t));
}

function matchesCommitment(word: string, c: KnownCommitment): boolean {
	// Distinctive label tokens only — see GENERIC_LABEL_TOKENS above.
	if (labelTokensDistinct(c.label).some((tok) => word.includes(tok))) return true;
	if (c.vendor && word.includes(c.vendor.toLowerCase())) return true;
	return false;
}

/**
 * Look up a word against this user's learned corrections first, then the
 * seed dictionary. A dictionary hit that maps to `null` (a known-but-
 * ambiguous word) and an outright miss both resolve to `ask_category` — the
 * distinction is preserved in the TYPES (`SeedDictEntry`), not in behaviour.
 *
 * Exported so the later UI phase can reuse the same classification once the
 * user answers a question, without re-running the whole router.
 */
export function classifyWord(
	word: string,
	ctx: ParseContext
): { kind: 'transaction' | 'ask_category'; english: string; root?: CategoryKey; leafId?: number | null } {
	const learned = ctx.learned[word];
	if (learned) {
		return { kind: 'transaction', english: learned.english, root: learned.root, leafId: learned.leafId };
	}

	const dictHit = ctx.dict[word];
	if (dictHit) return { kind: 'transaction', english: dictHit.english, root: dictHit.root, leafId: null };

	return { kind: 'ask_category', english: titleCase(word) };
}

/** Routing order, most specific first (Spec §5.6). */
export function parseEntry(raw: string, ctx: ParseContext, minorUnits: number): ParsedEntry {
	const { amountText, word } = extractAmountAndWord(raw);
	const amountMinor = amountText ? parseMoney(amountText, minorUnits) : null;

	if (raw.trim() === '') return { kind: 'empty' };
	if (word === '') return { kind: 'need_word', amountMinor };

	// 1. withdraw / atm / transfer / moved -> transfer, touches nothing else.
	if (TRANSFER_WORD.test(word)) {
		return { kind: 'transfer', word, amountMinor };
	}

	// 2. Matches a live subscription or irregular's label or vendor. One
	// RecordKind either way — which action it implies (nothing to log versus
	// settle actual_minor) is decided later, by `commitment.kind`, not here.
	const commitment = ctx.commitments.find((c) => matchesCommitment(word, c));
	if (commitment) {
		return { kind: 'existing_commitment', word, amountMinor, commitment };
	}

	// 3. A cadence word -> new commitment, cadence read off which word matched.
	if (CADENCE_WORD.test(word)) {
		const cadence: RouterCadence = /fortnightly/i.test(word)
			? 'fortnightly'
			: /year|annually|\/yr/i.test(word)
				? 'annual'
				: /week/i.test(word)
					? 'weekly'
					: 'monthly';
		const english = titleCase(
			word
				.replace(CADENCE_WORD, ' ')
				.replace(BILL_WORD, ' ')
				.trim()
				.replace(/\s+/g, ' ')
		);
		return { kind: 'new_commitment', word, english, amountMinor, cadence };
	}

	// 4. bill / subscription / renews / plan -> ask, never assume.
	if (BILL_WORD.test(word)) {
		const english = titleCase(word.replace(BILL_WORD, ' ').trim().replace(/\s+/g, ' '));
		return { kind: 'ask_kind', word, english, amountMinor };
	}

	// 5. Otherwise, a transaction (category guessed freely) or a question.
	const classified = classifyWord(word, ctx);
	if (classified.kind === 'transaction') {
		return {
			kind: 'transaction',
			word,
			english: classified.english,
			root: classified.root!,
			leafId: classified.leafId ?? null,
			amountMinor
		};
	}
	return { kind: 'ask_category', word, english: classified.english, amountMinor };
}
