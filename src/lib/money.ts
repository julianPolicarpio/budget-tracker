/**
 * Money. Integer minor units, everywhere, always.
 *
 * This module is the ONLY place in the codebase permitted to convert between
 * a human-typed decimal string and a number. Floats accumulate error silently
 * and you find out a year in (Spec §12). Note there is no `parseFloat` even
 * here — parsing is done on the digit string, which is exact.
 */

/** Parse a user-typed amount into integer minor units. Returns null if unparseable. */
export function parseMoney(raw: string, minorUnits: number): number | null {
	const s = raw.trim().replace(/[\s,_]/g, '');
	if (s === '') return null;

	const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
	if (!m) return null;

	const [, sign, whole, frac = ''] = m;
	if (whole === '' && frac === '') return null;

	// Reject rather than silently round: the user typed precision the currency
	// does not have, and quietly dropping it is how a ¥ entry becomes wrong.
	if (frac.length > minorUnits) return null;

	const padded = (frac + '0'.repeat(minorUnits)).slice(0, minorUnits);
	const digits = (whole === '' ? '0' : whole) + padded;

	const value = Number(digits);
	if (!Number.isSafeInteger(value)) return null;

	return sign === '-' ? -value : value;
}

/** Format integer minor units for display. */
export function formatMoney(
	minor: number,
	opts: { minorUnits: number; symbol?: string; group?: boolean }
): string {
	const { minorUnits, symbol = '', group = true } = opts;
	const negative = minor < 0;
	const abs = Math.abs(minor);

	const divisor = 10 ** minorUnits;
	const whole = Math.trunc(abs / divisor);
	const frac = abs - whole * divisor;

	const wholeStr = group ? whole.toLocaleString('en-US') : String(whole);
	const fracStr = minorUnits > 0 ? '.' + String(frac).padStart(minorUnits, '0') : '';

	return `${negative ? '-' : ''}${symbol}${wholeStr}${fracStr}`;
}

/** Largest multiple of `step` that is ≤ value. */
export function floorTo(value: number, step: number): number {
	if (step <= 1) return Math.floor(value);
	return Math.floor(value / step) * step;
}

/** Smallest multiple of `step` that is ≥ value. */
export function ceilTo(value: number, step: number): number {
	if (step <= 1) return Math.ceil(value);
	return Math.ceil(value / step) * step;
}
