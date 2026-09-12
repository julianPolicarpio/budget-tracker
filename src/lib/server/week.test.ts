import { describe, expect, it } from 'vitest';
import { lastCompleteWeek, weekDays, weekLabel, weekOf } from './week';

const SUN = 0;
const MON = 1;

describe('weekOf', () => {
	it('brackets the week containing a date, on the configured start day', () => {
		// 2026-08-16 is a Sunday.
		expect(weekOf('2026-08-19', SUN)).toMatchObject({
			startsOn: '2026-08-16',
			endsOn: '2026-08-22'
		});
		expect(weekOf('2026-08-19', MON)).toMatchObject({
			startsOn: '2026-08-17',
			endsOn: '2026-08-23'
		});
	});

	it('treats the start day itself as day one, not day seven', () => {
		expect(weekOf('2026-08-16', SUN).startsOn).toBe('2026-08-16');
	});

	it('yields seven consecutive days', () => {
		const days = weekDays(weekOf('2026-08-19', SUN));
		expect(days).toHaveLength(7);
		expect(days[0]).toBe('2026-08-16');
		expect(days[6]).toBe('2026-08-22');
	});
});

describe('lastCompleteWeek', () => {
	it('is the week that just ended, not the one in progress', () => {
		// Reviewing on Sunday 2026-08-16 covers 9–15 August.
		expect(lastCompleteWeek('2026-08-16', SUN)).toMatchObject({
			startsOn: '2026-08-09',
			endsOn: '2026-08-15'
		});
	});

	it('does not move while the current week runs', () => {
		const a = lastCompleteWeek('2026-08-16', SUN);
		const b = lastCompleteWeek('2026-08-20', SUN);
		expect(b).toEqual(a);
	});
});

describe('weekLabel', () => {
	it('numbers weeks from the first week start of the year', () => {
		// 2026-01-04 is the first Sunday of 2026, so it is week 1.
		expect(weekLabel('2026-01-04', SUN)).toBe('2026-W01');
		expect(weekLabel('2026-01-11', SUN)).toBe('2026-W02');
	});

	it('assigns days before that first start to the prior year', () => {
		// 2025-12-28 is a Sunday; 2026-01-01..03 fall inside its week.
		expect(weekLabel('2025-12-28', SUN)).toBe('2025-W52');
		expect(weekOf('2026-01-02', SUN).label).toBe('2025-W52');
	});

	it('produces a 53rd week where the calendar has one', () => {
		// 2023-01-01 was a Sunday, so 2023 holds 53 Sunday-start weeks and the
		// last of them runs into January 2024.
		expect(weekLabel('2023-01-01', SUN)).toBe('2023-W01');
		expect(weekLabel('2023-12-31', SUN)).toBe('2023-W53');
		expect(weekOf('2024-01-03', SUN).label).toBe('2023-W53');
	});

	it('numbers a year contiguously — no gaps, no duplicates', () => {
		const seen: string[] = [];
		for (let d = '2023-01-01'; d < '2023-12-31';) {
			seen.push(weekLabel(d, SUN));
			const t = new Date(d + 'T00:00:00Z').getTime() + 7 * 86_400_000;
			d = new Date(t).toISOString().slice(0, 10);
		}
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen).toEqual(
			Array.from({ length: seen.length }, (_, i) => `2023-W${String(i + 1).padStart(2, '0')}`)
		);
	});

	it('is stable across a leap day', () => {
		expect(weekOf('2028-02-29', SUN).label).toBe(weekOf('2028-02-27', SUN).label);
	});
});
