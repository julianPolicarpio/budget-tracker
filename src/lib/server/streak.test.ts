import { describe, expect, it } from 'vitest';
import { computeStreak } from './streak';

const days = (...d: string[]) => new Set(d);

describe('computeStreak', () => {
	it('counts consecutive logged days ending today', () => {
		const s = computeStreak(days('2026-08-14', '2026-08-15', '2026-08-16'), '2026-08-16');
		expect(s.current).toBe(3);
		expect(s.loggedToday).toBe(true);
	});

	it('does not read zero all day before tonight is filed', () => {
		// Today is unlogged at 09:00. The streak is still alive.
		const s = computeStreak(days('2026-08-14', '2026-08-15'), '2026-08-16');
		expect(s.current).toBe(2);
		expect(s.loggedToday).toBe(false);
	});

	it('breaks on two consecutive missed days', () => {
		const s = computeStreak(days('2026-08-10', '2026-08-11', '2026-08-12'), '2026-08-16');
		expect(s.current).toBe(0);
		expect(s.catchUpDate).toBeNull();
	});

	it('offers a catch-up for exactly one missed day', () => {
		// 15 Aug missing, 14 Aug present: a live streak with one gap.
		const s = computeStreak(days('2026-08-13', '2026-08-14', '2026-08-16'), '2026-08-16');
		expect(s.catchUpDate).toBe('2026-08-15');
	});

	it('withdraws the catch-up once the gap is two days wide', () => {
		const s = computeStreak(days('2026-08-13', '2026-08-16'), '2026-08-16');
		expect(s.catchUpDate).toBeNull();
	});

	it('restores the run once the catch-up is filed', () => {
		const before = computeStreak(days('2026-08-13', '2026-08-14', '2026-08-16'), '2026-08-16');
		expect(before.current).toBe(1);

		const after = computeStreak(
			days('2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'),
			'2026-08-16'
		);
		expect(after.current).toBe(4);
	});

	it('reports the longest run ever, not just the live one', () => {
		const s = computeStreak(
			days(
				'2026-07-01',
				'2026-07-02',
				'2026-07-03',
				'2026-07-04',
				'2026-07-05',
				'2026-08-15',
				'2026-08-16'
			),
			'2026-08-16'
		);
		expect(s.current).toBe(2);
		expect(s.longest).toBe(5);
	});

	it('handles an empty history', () => {
		const s = computeStreak(days(), '2026-08-16');
		expect(s).toEqual({ current: 0, longest: 0, loggedToday: false, catchUpDate: null });
	});

	it('counts a zero-spend day as a full day — that is intended, not a loophole', () => {
		// Spec §11: a metric that cannot be gamed is not measuring adherence.
		const s = computeStreak(days('2026-08-15', '2026-08-16'), '2026-08-16');
		expect(s.current).toBe(2);
	});
});
