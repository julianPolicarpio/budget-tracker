import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CATALOGUE } from './catalogue';
import type { EvalCase } from './laya-eval';

const TAGS = ['plain-spending', 'new-bill', 'existing-bill', 'transfer', 'refund', 'plan', 'debt', 'income', 'trip', 'savings', 'ambiguous'];
const cases: EvalCase[] = readFileSync(resolve('eval/laya/corpus.jsonl'), 'utf8')
	.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

describe('Laya corpus', () => {
	it('labels every case with a real action id or unclear', () => {
		const ids = new Set([...CATALOGUE.map((a) => a.id), 'unclear']);
		for (const c of cases) expect(ids.has(c.expected), c.text).toBe(true);
	});
	it('has at least 120 authored cases, 10 per tag and 30 Taglish', () => {
		// Counted across splits: Task 8 may move half of these to the test split.
		const authored = cases.filter((c) => c.source === 'authored');
		expect(authored.length).toBeGreaterThanOrEqual(120);
		for (const t of TAGS) expect(authored.filter((c) => c.tag === t).length, t).toBeGreaterThanOrEqual(10);
		expect(authored.filter((c) => c.lang === 'taglish').length).toBeGreaterThanOrEqual(30);
	});
	it('has no duplicate text and only known tags, langs, sources and splits', () => {
		expect(new Set(cases.map((c) => c.text.toLowerCase())).size).toBe(cases.length);
		for (const c of cases) {
			expect(TAGS).toContain(c.tag);
			expect(['en', 'taglish']).toContain(c.lang);
			expect(['authored', 'owner']).toContain(c.source);
			expect(['dev', 'test']).toContain(c.split);
		}
	});
	it('keeps owner cases in the test split', () => {
		expect(cases.filter((c) => c.source === 'owner').every((c) => c.split === 'test')).toBe(true);
	});
});
