import { describe, expect, it } from 'vitest';
import { shouldAutoOpen, AUTO_OPEN } from './auto-open';
import { NEVER_AUTO_OPEN } from './laya-eval';

const cfg = { allowed: ['add-bill-subscription'], minProbability: 0.8, minMargin: 0.3 };

describe('shouldAutoOpen', () => {
	it('opens at exactly the thresholds', () => {
		expect(shouldAutoOpen({ id: 'add-bill-subscription', probability: 0.8, margin: 0.3 }, cfg)).toBe(true);
	});
	it('does not open just under either threshold', () => {
		expect(shouldAutoOpen({ id: 'add-bill-subscription', probability: 0.7999, margin: 0.3 }, cfg)).toBe(false);
		expect(shouldAutoOpen({ id: 'add-bill-subscription', probability: 0.8, margin: 0.2999 }, cfg)).toBe(false);
	});
	it('does not open an id outside the allowlist at probability 1', () => {
		expect(shouldAutoOpen({ id: 'record-refund', probability: 1, margin: 1 }, cfg)).toBe(false);
	});
	it('never opens a never-auto-open id even if a config lists it', () => {
		const bad = { ...cfg, allowed: ['transfer-money', 'add-debt'] };
		expect(shouldAutoOpen({ id: 'transfer-money', probability: 1, margin: 1 }, bad)).toBe(false);
		expect(shouldAutoOpen({ id: 'add-debt', probability: 1, margin: 1 }, bad)).toBe(false);
	});
	it('ships an allowlist with no never-auto-open id in it', () => {
		for (const id of AUTO_OPEN.allowed) expect(NEVER_AUTO_OPEN.has(id)).toBe(false);
	});
});
