import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CATALOGUE } from './catalogue';
import type { EvalCase, Tag } from './laya-eval';

const ALLOWED: Record<Tag, string[]> = {
	'plain-spending': ['log-spending'],
	'new-bill': ['add-bill-subscription'],
	'existing-bill': ['record-payment'],
	transfer: ['transfer-money'],
	refund: ['record-refund'],
	plan: ['create-planned-expense', 'fund-planned-expense'],
	debt: ['add-debt'],
	income: ['record-income'],
	trip: ['add-trip'],
	savings: ['save-for-later', 'move-between-purposes', 'create-planned-expense'],
	ambiguous: ['unclear'],
	setup: ['set-budget', 'add-account', 'update-balance', 'add-edit-rule']
};
const TAGS = Object.keys(ALLOWED) as Tag[];

const cases: EvalCase[] = readFileSync(resolve('eval/laya/corpus.jsonl'), 'utf8')
	.split('\n')
	.map((text, i) => ({ text, line: i + 1 }))
	.filter((l) => l.text.trim())
	.map(({ text, line }) => {
		try {
			return JSON.parse(text) as EvalCase;
		} catch (e) {
			throw new Error(`corpus.jsonl line ${line}: ${(e as Error).message}`);
		}
	});

const normalise = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

describe('Laya corpus', () => {
	it('labels every case with a real action id or unclear', () => {
		const ids = new Set([...CATALOGUE.map((a) => a.id), 'unclear']);
		for (const c of cases) expect(ids.has(c.expected), c.text).toBe(true);
	});
	it('only uses an expected id that its tag allows', () => {
		for (const c of cases) expect(ALLOWED[c.tag]?.includes(c.expected), `${c.text} (${c.tag} -> ${c.expected})`).toBe(true);
	});
	it('only uses names the demo seed can resolve in existing-bill cases', () => {
		const names = ['home wifi', 'wifi', 'internet', 'streaming', 'notion', 'laundry', 'labada'];
		for (const c of cases.filter((c) => c.tag === 'existing-bill')) {
			expect(names.some((n) => c.text.toLowerCase().includes(n)), c.text).toBe(true);
		}
	});
	it('has at least 120 authored cases, 10 per tag and 30 Taglish', () => {
		// Counted across splits: Task 8 may move half of these to the test split.
		const authored = cases.filter((c) => c.source === 'authored');
		expect(authored.length).toBeGreaterThanOrEqual(120);
		for (const t of TAGS) expect(authored.filter((c) => c.tag === t).length, t).toBeGreaterThanOrEqual(10);
		expect(authored.filter((c) => c.lang === 'taglish').length).toBeGreaterThanOrEqual(30);
	});
	it('has no duplicate text (ignoring case, spacing and punctuation) and only known tags, langs, sources and splits', () => {
		const seen = new Map<string, string>();
		for (const c of cases) {
			const k = normalise(c.text);
			expect(seen.has(k), `duplicate: "${c.text}" vs "${seen.get(k)}"`).toBe(false);
			seen.set(k, c.text);
			expect(TAGS).toContain(c.tag);
			expect(['en', 'taglish']).toContain(c.lang);
			expect(['authored', 'owner']).toContain(c.source);
			expect(['dev', 'test']).toContain(c.split);
		}
	});
	it('keeps every authored case in the dev split', () => {
		// Task 8 may move some authored cases to `test`; if it does, it must update this assertion.
		expect(cases.filter((c) => c.source === 'authored').every((c) => c.split === 'dev')).toBe(true);
	});
	it('keeps owner cases in the test split', () => {
		// Only becomes meaningful once owner cases exist.
		expect(cases.filter((c) => c.source === 'owner').every((c) => c.split === 'test')).toBe(true);
	});
});
