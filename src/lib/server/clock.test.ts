import { describe, expect, it } from 'vitest';
import { addDays, daysBetweenInclusive, localToday } from './clock';

describe('localToday', () => {
	it('resolves the day in the configured zone, not the server zone', () => {
		// 2026-08-16 17:30 UTC is already 2026-08-17 in Manila (UTC+8).
		const at = new Date('2026-08-16T17:30:00Z');
		expect(localToday('Asia/Manila', at)).toBe('2026-08-17');
		expect(localToday('UTC', at)).toBe('2026-08-16');
		expect(localToday('America/Los_Angeles', at)).toBe('2026-08-16');
	});

	it('survives a DST rollover night', () => {
		// US DST ends 2026-11-01. The 25-hour day is an ordinary date string.
		const before = new Date('2026-11-01T05:30:00Z'); // 22:30 Oct 31 PDT
		const after = new Date('2026-11-01T09:30:00Z'); // 01:30 Nov 1 PST
		expect(localToday('America/Los_Angeles', before)).toBe('2026-10-31');
		expect(localToday('America/Los_Angeles', after)).toBe('2026-11-01');
	});
});

describe('addDays', () => {
	it('crosses month and year boundaries', () => {
		expect(addDays('2026-08-16', 1)).toBe('2026-08-17');
		expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
	});

	it('handles a leap day', () => {
		expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
	});

	it('walks back a 28-cell strip without drift', () => {
		expect(addDays('2026-08-16', -27)).toBe('2026-07-20');
	});
});

describe('daysBetweenInclusive', () => {
	it('counts both endpoints', () => {
		expect(daysBetweenInclusive('2026-08-17', '2026-08-23')).toBe(7);
		expect(daysBetweenInclusive('2026-08-17', '2026-08-17')).toBe(1);
	});

	it('is unaffected by DST inside the range', () => {
		expect(daysBetweenInclusive('2026-10-25', '2026-11-07')).toBe(14);
	});
});
