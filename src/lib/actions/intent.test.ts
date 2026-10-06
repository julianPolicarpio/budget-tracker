import { describe, expect, it } from 'vitest';
import { SEED_DICT, type KnownCommitment, type ParseContext } from '$lib/entry-parser';
import { acceptModelChoice, resolveProtectedIntent } from './intent';

const empty: ParseContext = { dict: SEED_DICT, learned: {}, commitments: [] };
const withCommitments = (commitments: KnownCommitment[]): ParseContext => ({
	dict: SEED_DICT,
	learned: {},
	commitments
});

const chatgpt: KnownCommitment = {
	id: 1,
	kind: 'subscription',
	label: 'ChatGPT',
	vendor: null
};

type CorpusCase = { text: string; context?: ParseContext; minorUnits?: number; kind: string; actionId?: string };

// This corpus is deliberately fixed. It includes normal spending and familiar
// commitments so an action word cannot accidentally turn either into a form.
const CORPUS: readonly CorpusCase[] = [
	{ text: 'coffee 65', kind: 'spending' },
	{ text: 'kape 65', kind: 'spending' },
	{ text: 'pamasahe 18', kind: 'spending' },
	{ text: 'Jollibee 199', kind: 'spending' },
	{ text: 'grocery 1,250', kind: 'spending' },
	{ text: 'milk tea 95', kind: 'spending' },
	{ text: 'Grab 230', kind: 'spending' },
	{ text: 'gamot 150', kind: 'spending' },
	{ text: 'load 99', kind: 'spending' },
	{ text: 'subscription ChatGPT 1,100', kind: 'action', actionId: 'add-bill-subscription' },
	{ text: 'chatgpt subscription 1100', kind: 'action', actionId: 'add-bill-subscription' },
	{ text: 'Netflix monthly 549', kind: 'action', actionId: 'add-bill-subscription' },
	{ text: 'bayad sa Spotify subscription 149', kind: 'action', actionId: 'add-bill-subscription' },
	{ text: 'add a bill Meralco 2500', kind: 'action', actionId: 'add-bill-subscription' },
	{ text: 'transfer 5000', kind: 'action', actionId: 'transfer-money' },
	{ text: 'ilipat 500 sa savings', kind: 'action', actionId: 'move-between-purposes' },
	{ text: 'move money 250', kind: 'action', actionId: 'move-between-purposes' },
	{ text: 'record income 30000', kind: 'action', actionId: 'record-income' },
	{ text: 'salary 45000', kind: 'action', actionId: 'record-income' },
	{ text: 'sweldo 25,000', kind: 'action', actionId: 'record-income' },
	{ text: 'refund 700', kind: 'action', actionId: 'record-refund' },
	{ text: 'money back 399', kind: 'action', actionId: 'record-refund' },
	{ text: 'fund planned expense 1200', kind: 'action', actionId: 'fund-planned-expense' },
	{ text: 'set aside 500 for car registration', kind: 'action', actionId: 'fund-planned-expense' },
	{ text: 'plan a trip to Tokyo 30000', kind: 'action', actionId: 'add-trip' },
	{ text: 'add trip Cebu', kind: 'action', actionId: 'add-trip' },
	{ text: 'create planned expense laptop 45000', kind: 'action', actionId: 'create-planned-expense' },
	{ text: 'big bill dentist 5000', kind: 'action', actionId: 'create-planned-expense' },
	{ text: 'add debt credit card 15000', kind: 'action', actionId: 'add-debt' },
	{ text: 'loan 10000', kind: 'action', actionId: 'add-debt' },
	{ text: 'save for later headphones 2500', kind: 'action', actionId: 'save-for-later' },
	{ text: 'wishlist shoes 3000', kind: 'action', actionId: 'save-for-later' },
	{ text: 'add account Maya', kind: 'action', actionId: 'add-account' },
	{ text: 'new bank account BPI', kind: 'action', actionId: 'add-account' },
	{ text: 'add rule no food delivery', kind: 'action', actionId: 'add-edit-rule' },
	{ text: 'budget 20000', kind: 'action', actionId: 'set-budget' },
	{ text: 'record payment 1200', kind: 'action', actionId: 'record-payment' },
	{ text: 'what should I do with this?', kind: 'choices' },
	{ text: 'bayad 500', kind: 'choices' },
	{ text: 'travel soon', kind: 'choices' },
	{ text: 'coffee 1200', minorUnits: 0, kind: 'spending' },
	{ text: 'chatgpt subscription 1100', context: withCommitments([chatgpt]), kind: 'existing' },
	{ text: 'existing ChatGPT subscription', context: withCommitments([chatgpt]), kind: 'existing' }
];

describe('resolveProtectedIntent corpus', () => {
	it.each(CORPUS)('$text', ({ text, context = empty, minorUnits = 2, kind, actionId }) => {
		const result = resolveProtectedIntent(text, context, minorUnits);
		expect(result.kind).toBe(kind);
		if (actionId) expect(result).toMatchObject({ actionId });
	});

	it('extracts only explicit bill label and amount, preserving the source text', () => {
		expect(resolveProtectedIntent('subscription ChatGPT 1,100', empty, 2)).toMatchObject({
		kind: 'action',
		actionId: 'add-bill-subscription',
		draft: { sourceText: 'subscription ChatGPT 1,100', fields: { label: 'ChatGPT', amount: '1100' } }
	});
	});

	it('does not invent date, cadence, account, purpose, or debt fields', () => {
		const results = [
			resolveProtectedIntent('ChatGPT subscription 1100', empty, 2),
			resolveProtectedIntent('transfer 5000', empty, 2),
			resolveProtectedIntent('loan 10000', empty, 2)
		];
		for (const result of results) {
			expect(result.kind).toBe('action');
			if (result.kind === 'action') {
				expect(result.draft?.fields).not.toHaveProperty('cadence');
				expect(result.draft?.fields).not.toHaveProperty('nextChargeOn');
				expect(result.draft?.fields).not.toHaveProperty('accountId');
				expect(result.draft?.fields).not.toHaveProperty('purpose');
				expect(result.draft?.fields).not.toHaveProperty('minPayment');
			}
		}
	});

	it('copies an explicitly stated cadence and billing date without mistaking date digits for the amount', () => {
		expect(resolveProtectedIntent('2026-10-31 chatgpt subscription monthly 1100', empty, 2)).toMatchObject({
			kind: 'action',
			draft: { fields: { label: 'ChatGPT', amount: '1100', cadence: 'monthly', nextChargeOn: '2026-10-31' } }
		});
	});
});

describe('acceptModelChoice', () => {
	const allowed = ['add-bill-subscription', 'add-debt'] as const;

	it('accepts only a finite probability and an allowed ID', () => {
		expect(acceptModelChoice({ id: 'add-debt', probability: 0.8 }, allowed)).toBe('add-debt');
	});

	it.each([
		{ id: 'log-spending', probability: 0.9 },
		{ id: 'add-debt', probability: Number.NaN },
		{ id: 'add-debt', probability: Number.POSITIVE_INFINITY },
		{ id: 'add-debt', probability: -0.1 },
		{ id: 'add-debt', probability: 1.1 },
		{ id: 7, probability: 0.9 },
		null
	])('rejects malformed model reply %#', (reply) => {
		expect(acceptModelChoice(reply, allowed)).toBeNull();
	});
});
