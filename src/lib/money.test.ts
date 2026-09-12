import { describe, expect, it } from 'vitest';
import { ceilTo, floorTo, formatMoney, parseMoney } from './money';

describe('parseMoney', () => {
	it('parses whole and decimal amounts into minor units', () => {
		expect(parseMoney('4200', 2)).toBe(420000);
		expect(parseMoney('42.50', 2)).toBe(4250);
		expect(parseMoney('42.5', 2)).toBe(4250);
		expect(parseMoney('.5', 2)).toBe(50);
		expect(parseMoney('0.01', 2)).toBe(1);
	});

	it('tolerates grouping and whitespace', () => {
		expect(parseMoney(' 1,234.56 ', 2)).toBe(123456);
	});

	it('is exact where a float would not be', () => {
		// 0.1 + 0.2 territory: 8.70 must be 870, never 869.
		expect(parseMoney('8.70', 2)).toBe(870);
		expect(parseMoney('1234567.89', 2)).toBe(123456789);
	});

	it('handles zero-decimal currencies without a 100x fat-finger', () => {
		// JPY/KRW/VND. ¥1000 is 1000 minor units, not 100000 (Spec §12).
		expect(parseMoney('1000', 0)).toBe(1000);
		expect(parseMoney('1000.5', 0)).toBeNull();
	});

	it('rejects precision the currency does not have rather than rounding it away', () => {
		expect(parseMoney('42.555', 2)).toBeNull();
	});

	it('rejects junk', () => {
		expect(parseMoney('', 2)).toBeNull();
		expect(parseMoney('abc', 2)).toBeNull();
		expect(parseMoney('4.2.1', 2)).toBeNull();
		expect(parseMoney('.', 2)).toBeNull();
	});
});

describe('formatMoney', () => {
	it('round-trips through parseMoney', () => {
		for (const raw of ['0.00', '0.07', '42.50', '1234.56', '1000000.00']) {
			const minor = parseMoney(raw, 2)!;
			expect(formatMoney(minor, { minorUnits: 2, group: false })).toBe(raw);
		}
	});

	it('omits the decimal point for zero-decimal currencies', () => {
		expect(formatMoney(38200, { minorUnits: 0, symbol: '¥' })).toBe('¥38,200');
	});

	it('groups thousands and keeps the sign outside the symbol', () => {
		expect(formatMoney(123456, { minorUnits: 2, symbol: '₱' })).toBe('₱1,234.56');
		expect(formatMoney(-500, { minorUnits: 2, symbol: '₱' })).toBe('-₱5.00');
	});
});

describe('rounding helpers', () => {
	it('floors and ceils to a step', () => {
		expect(floorTo(45900, 1000)).toBe(45000);
		expect(ceilTo(45100, 1000)).toBe(46000);
		expect(floorTo(46000, 1000)).toBe(46000);
		expect(ceilTo(46000, 1000)).toBe(46000);
	});
});
