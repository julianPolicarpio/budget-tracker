import { describe, expect, it } from 'vitest';
import { chooseThresholds, isDangerousOpen, summarise, type EvalRow } from './laya-eval';

function row(p: Partial<EvalRow>): EvalRow {
	return {
		text: 't', expected: 'add-bill-subscription', tag: 'new-bill', lang: 'en', source: 'authored', split: 'dev',
		route: 'model', decided: 'add-bill-subscription', probability: 0.9, margin: 0.5, latencyMs: 100,
		choices: ['add-bill-subscription'], ...p
	};
}

describe('isDangerousOpen', () => {
	it('is never dangerous when the opened form is the expected one', () => {
		expect(isDangerousOpen('record-refund', 'record-refund')).toBe(false);
	});
	it('is dangerous over spending, unclear, or any money-moving action on either side', () => {
		expect(isDangerousOpen('log-spending', 'add-bill-subscription')).toBe(true);
		expect(isDangerousOpen('unclear', 'add-trip')).toBe(true);
		expect(isDangerousOpen('transfer-money', 'save-for-later')).toBe(true);
		expect(isDangerousOpen('add-trip', 'record-refund')).toBe(true);
	});
	it('is a plain error, not dangerous, between two planning forms', () => {
		expect(isDangerousOpen('add-trip', 'create-planned-expense')).toBe(false);
	});
});

describe('summarise', () => {
	it('counts top-1 and offered-in-3 per tag and language, and latency over the timeout', () => {
		const s = summarise([
			row({}),
			row({ decided: 'add-debt', choices: ['add-bill-subscription', 'add-debt'] }),
			row({ lang: 'taglish', route: 'fallback', decided: null, latencyMs: 900, choices: ['save-for-later'] })
		]);
		expect(s.overall).toEqual({ n: 3, top1: 1, offered: 2 });
		expect(s.byLang.taglish).toEqual({ n: 1, top1: 0, offered: 0 });
		expect(s.modelOnly).toEqual({ n: 2, top1: 1 });
		expect(s.latency.overTimeout).toBe(1);
	});
});

describe('chooseThresholds', () => {
	it('allows a class only with zero dangerous opens, >= 95% precision and enough support', () => {
		const good = Array.from({ length: 5 }, () => row({ probability: 0.8, margin: 0.4 }));
		const badRefund = [
			...Array.from({ length: 4 }, () => row({ expected: 'record-refund', decided: 'record-refund', tag: 'refund' })),
			row({ expected: 'log-spending', decided: 'record-refund', tag: 'plain-spending', probability: 0.99, margin: 0.9 })
		];
		const t = chooseThresholds([...good, ...badRefund], 3);
		expect(t.allowed).toEqual(['add-bill-subscription']);
		expect(t.probability).toBeLessThanOrEqual(0.8);
		expect(t.margin).toBeLessThanOrEqual(0.4);
	});
	it('never allows a never-auto-open id however confident', () => {
		const rows = Array.from({ length: 6 }, () => row({ expected: 'add-debt', decided: 'add-debt', tag: 'debt', probability: 1, margin: 1 }));
		expect(chooseThresholds(rows, 3).allowed).toEqual([]);
	});
	it('returns an empty allowlist when nothing qualifies', () => {
		expect(chooseThresholds([row({})], 3).allowed).toEqual([]);
	});
});
