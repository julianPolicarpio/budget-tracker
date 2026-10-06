/**
 * The typed-entry router, pure (Spec §5.6–§5.7, task A4a).
 *
 * `parseEntry()` is DB-free on purpose — the browser calls it directly with a
 * `ParseContext` fetched once, so every keystroke of the live resolution line
 * stays off the network. These tests build that context by hand instead of
 * touching a database.
 */

import { describe, expect, it } from 'vitest';
import {
	classifyWord,
	extractAmountAndWord,
	parseEntry,
	SEED_DICT,
	type KnownCommitment,
	type ParseContext
} from './entry-parser';

const PHP_MINOR_UNITS = 2;

const emptyCtx: ParseContext = { dict: SEED_DICT, learned: {}, commitments: [] };

function ctxWith(commitments: KnownCommitment[], learned: ParseContext['learned'] = {}): ParseContext {
	return { dict: SEED_DICT, learned, commitments };
}

describe('extractAmountAndWord', () => {
	it('finds the amount in either position', () => {
		expect(extractAmountAndWord('kape 65')).toEqual({ amountText: '65', word: 'kape' });
		expect(extractAmountAndWord('65 kape')).toEqual({ amountText: '65', word: 'kape' });
	});

	it('lowercases and collapses whitespace in the remaining word', () => {
		expect(extractAmountAndWord('  Netflix   549   monthly ')).toEqual({
			amountText: '549',
			word: 'netflix monthly'
		});
	});

	it('returns a null amount when there is no number', () => {
		expect(extractAmountAndWord('kape')).toEqual({ amountText: null, word: 'kape' });
	});
});

describe('parseEntry: pre-routing states', () => {
	it('an empty string resolves to empty, not a question', () => {
		expect(parseEntry('', emptyCtx, PHP_MINOR_UNITS)).toEqual({ kind: 'empty' });
		expect(parseEntry('   ', emptyCtx, PHP_MINOR_UNITS)).toEqual({ kind: 'empty' });
	});

	it('an amount with no word asks for the word, not a category', () => {
		expect(parseEntry('150', emptyCtx, PHP_MINOR_UNITS)).toEqual({
			kind: 'need_word',
			amountMinor: 15_000
		});
	});
});

describe('parseEntry: routing order, most specific first (Spec §5.6)', () => {
	it('1. withdraw / atm / transfer / moved -> transfer, before anything else can claim it', () => {
		for (const word of ['withdraw 2000', 'atm 2000', 'transfer 2000', 'moved 2000']) {
			const r = parseEntry(word, emptyCtx, PHP_MINOR_UNITS);
			expect(r.kind).toBe('transfer');
		}
	});

	it('a transfer word wins even if the rest of the text also contains a bill word', () => {
		// "withdraw" must never be shadowed by a coincidental bill/cadence word.
		const r = parseEntry('withdraw for the bill 2000', emptyCtx, PHP_MINOR_UNITS);
		expect(r.kind).toBe('transfer');
	});

	it('2. matches a live subscription label -> existing_commitment (subscription)', () => {
		const wifi: KnownCommitment = { id: 1, kind: 'subscription', label: 'Home wifi', vendor: null };
		const ctx = ctxWith([wifi]);
		const r = parseEntry('wifi bill 750', ctx, PHP_MINOR_UNITS);
		expect(r).toMatchObject({ kind: 'existing_commitment', amountMinor: 75_000, commitment: wifi });
	});

	it('2. matches a live irregular label -> existing_commitment (irregular)', () => {
		const laundry: KnownCommitment = { id: 2, kind: 'irregular', label: 'Laundry', vendor: null };
		const ctx = ctxWith([laundry]);
		const r = parseEntry('laundry 200', ctx, PHP_MINOR_UNITS);
		expect(r).toMatchObject({ kind: 'existing_commitment', amountMinor: 20_000, commitment: laundry });
	});

	it('2. matches by vendor when the label itself is not typed', () => {
		const plan: KnownCommitment = { id: 3, kind: 'subscription', label: 'Phone plan', vendor: 'Globe' };
		const ctx = ctxWith([plan]);
		const r = parseEntry('globe 999', ctx, PHP_MINOR_UNITS);
		expect(r).toMatchObject({ kind: 'existing_commitment', commitment: plan });
	});

	it("2. a DIFFERENT subscription shares only the generic word 'subscription' -> not a match, routes to new-commitment/ask flow", () => {
		// Regression: 'udemy subscription' used to match the existing
		// 'chatgpt subscription' because label words like 'subscription'
		// matched any typed text that contained them (word.includes(tok)).
		const chatgpt: KnownCommitment = {
			id: 4,
			kind: 'subscription',
			label: 'chatgpt subscription',
			vendor: null
		};
		const ctx = ctxWith([chatgpt]);
		const r = parseEntry('udemy subscription 1000', ctx, PHP_MINOR_UNITS);
		expect(r.kind).toBe('ask_kind'); // routed to ask, NOT the chatgpt commitment
		expect(r).not.toHaveProperty('commitment');
	});

	it('3. a cadence word -> new_commitment, cadence read off which word matched', () => {
		const cases: [string, 'weekly' | 'fortnightly' | 'monthly' | 'annual'][] = [
			['netflix 549 monthly', 'monthly'],
			['gym 500 a year', 'annual'],
			['laundry 200 weekly', 'weekly'],
			['storage 100 fortnightly', 'fortnightly']
		];
		for (const [text, cadence] of cases) {
			const r = parseEntry(text, emptyCtx, PHP_MINOR_UNITS);
			expect(r.kind).toBe('new_commitment');
			if (r.kind === 'new_commitment') expect(r.cadence).toBe(cadence);
		}
	});

	it('strips both the cadence word and any bill word from the derived name', () => {
		const r = parseEntry('netflix 549 monthly', emptyCtx, PHP_MINOR_UNITS);
		expect(r).toMatchObject({ kind: 'new_commitment', english: 'Netflix', amountMinor: 54_900 });
	});

	it('a commitment created from "netflix 549 monthly" is matched by a later bare "netflix"', () => {
		// The clean `english` this test just asserted above becomes the STORED
		// commitment's label (entry.ts's recordNewCommitment: label: input.english).
		// A later bare mention must find it via that same clean string, not the
		// raw "netflix monthly" text — this is the "slug for matching" the task
		// calls out explicitly.
		const created = parseEntry('netflix 549 monthly', emptyCtx, PHP_MINOR_UNITS);
		expect(created.kind).toBe('new_commitment');
		const label = created.kind === 'new_commitment' ? created.english : '';

		const nowLive: KnownCommitment = { id: 9, kind: 'subscription', label, vendor: null };
		const r = parseEntry('netflix 600', ctxWith([nowLive]), PHP_MINOR_UNITS);
		expect(r).toMatchObject({ kind: 'existing_commitment', commitment: nowLive });
	});

	it('4. bill / subscription / renews / plan with no cadence word -> ask_kind, never assumed', () => {
		for (const text of ['insurance bill 500', 'gym subscription 500', 'domain renews 500', 'data plan 500']) {
			const r = parseEntry(text, emptyCtx, PHP_MINOR_UNITS);
			expect(r.kind, text).toBe('ask_kind');
		}
	});

	it('5. a known dictionary word -> transaction, category guessed freely', () => {
		const r = parseEntry('kape 65', emptyCtx, PHP_MINOR_UNITS);
		expect(r).toEqual({
			kind: 'transaction',
			word: 'kape',
			english: 'Coffee',
			root: 'food_out',
			leafId: null,
			amountMinor: 6_500
		});
	});

	it('5. amount parses in either position for a transaction', () => {
		const a = parseEntry('kape 65', emptyCtx, PHP_MINOR_UNITS);
		const b = parseEntry('65 kape', emptyCtx, PHP_MINOR_UNITS);
		expect(a).toEqual(b);
	});

	it('5. an unrecognised word -> ask_category, never guessed as a transaction', () => {
		const r = parseEntry('laundry 200', emptyCtx, PHP_MINOR_UNITS);
		expect(r).toEqual({ kind: 'ask_category', word: 'laundry', english: 'Laundry', amountMinor: 20_000 });
	});

	it('a dictionary hit that maps to null (deliberately ambiguous) also asks, not guesses', () => {
		const r = parseEntry('merienda 80', emptyCtx, PHP_MINOR_UNITS);
		expect(r.kind).toBe('ask_category');
	});

	it('a learned correction overrides the seed dictionary and carries its leafId', () => {
		const ctx = ctxWith([], { laundry: { english: 'Laundry', root: 'stuff', leafId: 7 } });
		const r = parseEntry('laundry 200', ctx, PHP_MINOR_UNITS);
		expect(r).toEqual({
			kind: 'transaction',
			word: 'laundry',
			english: 'Laundry',
			root: 'stuff',
			leafId: 7,
			amountMinor: 20_000
		});
	});
});

describe('classifyWord', () => {
	it('is exported so a later phase can classify a bare word without re-running the router', () => {
		expect(classifyWord('kape', emptyCtx)).toEqual({ kind: 'transaction', english: 'Coffee', root: 'food_out', leafId: null });
		expect(classifyWord('laundry', emptyCtx)).toEqual({ kind: 'ask_category', english: 'Laundry' });
	});
});
