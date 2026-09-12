import { describe, expect, it } from 'vitest';
import { dailyAllowance, displayBand } from './allowance';

describe('dailyAllowance', () => {
	it('applies the haircut to the frozen allocation', () => {
		// ₱4,200 over 7 days, 15% haircut → ₱510/day.
		expect(dailyAllowance({ spendAllocMinor: 420_000, days: 7 }, 15)).toBe(51_000);
	});

	it('is invariant to how far into the period you are', () => {
		// The regression guard from Spec §12: if anyone ever reintroduces
		// `remaining ÷ days_remaining`, this is what catches it. The function
		// takes no notion of "today" at all, and that is the assertion.
		const period = { spendAllocMinor: 420_000, days: 7 };
		const results = new Set<number>();
		for (let dayOfPeriod = 1; dayOfPeriod <= period.days; dayOfPeriod++) {
			results.add(dailyAllowance(period, 15));
		}
		expect(results.size).toBe(1);
	});

	it('does not accept a daysRemaining argument', () => {
		// Structural, not behavioural: dailyAllowance(period, haircut) — two
		// parameters, neither of which can carry days-remaining.
		expect(dailyAllowance.length).toBe(2);
	});

	it('rounds once, at the end', () => {
		expect(dailyAllowance({ spendAllocMinor: 100_000, days: 3 }, 15)).toBe(28_333);
	});

	it('refuses a zero-day period rather than dividing by zero', () => {
		expect(() => dailyAllowance({ spendAllocMinor: 100, days: 0 }, 15)).toThrow();
	});
});

describe('displayBand', () => {
	it('brackets the allowance and rounds outward to the step', () => {
		expect(displayBand(51_000, { bandPct: 10, roundingStep: 1_000 })).toEqual({
			low: 45_000,
			high: 57_000
		});
	});

	it('never collapses into a single precise figure', () => {
		// A collapsed band IS a precise figure, which is the thing F5 says
		// gets spent to and then past.
		for (const allowance of [0, 1, 50, 500, 4_999]) {
			const band = displayBand(allowance, { bandPct: 10, roundingStep: 1_000 });
			expect(band.high).toBeGreaterThan(band.low);
		}
	});

	it('never shows a negative floor', () => {
		expect(displayBand(0, { bandPct: 10, roundingStep: 1_000 }).low).toBe(0);
	});
});
