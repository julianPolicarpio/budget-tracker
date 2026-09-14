import { describe, expect, it } from 'vitest';
import { parseTrialText } from './trial-parser';

/** The shape a real confirmation takes: product name on its own line, the
 * trial length and price on the next, the renewal date on the last. */
const SAMPLE = [
	'Google AI Plus (400 GB)',
	'Free for 7 days, then PHP 549.00 per month',
	'Renews on 19 September 2026'
].join('\n');

describe('money — always through parseMoney, never parseFloat', () => {
	it('parses PHP 549.00, ₱549, and $9.99 into integer minor units', () => {
		expect(parseTrialText('PHP 549.00/month', 2).amountMinor).toBe(54_900);
		expect(parseTrialText('₱549/mo', 2).amountMinor).toBe(54_900);
		expect(parseTrialText('$9.99 a year', 2).amountMinor).toBe(999);
	});

	it('tolerates thousands grouping — the ₱1,100 ChatGPT case this feature exists for', () => {
		expect(parseTrialText('₱1,100/month', 2).amountMinor).toBe(110_000);
	});

	it('is null with no currency marker next to a number', () => {
		expect(parseTrialText('costs 549 somehow', 2).amountMinor).toBeNull();
	});
});

describe('cadence — read independently of the money match', () => {
	it('recognises each cadence word', () => {
		expect(parseTrialText('PHP 549.00/month', 2).cadence).toBe('monthly');
		expect(parseTrialText('$9.99 a year', 2).cadence).toBe('annual');
		expect(parseTrialText('billed weekly', 2).cadence).toBe('weekly');
		expect(parseTrialText('charged fortnightly', 2).cadence).toBe('fortnightly');
		expect(parseTrialText('billed quarterly', 2).cadence).toBe('quarterly');
		expect(parseTrialText('twice a year', 2).cadence).toBe('semiannual');
	});

	it('is null with no cadence word anywhere', () => {
		expect(parseTrialText('Google AI Plus (400 GB)', 2).cadence).toBeNull();
	});
});

describe('trial length — "Free for N days" phrasing', () => {
	it('reads the number of days', () => {
		expect(parseTrialText('Free for 7 days, then billing starts', 2).trialDays).toBe(7);
		expect(parseTrialText('7-day free trial', 2).trialDays).toBe(7);
		expect(parseTrialText('14 day trial', 2).trialDays).toBe(14);
	});

	it('is null with no trial-length phrase', () => {
		expect(parseTrialText('Renews on 2026-09-19', 2).trialDays).toBeNull();
	});
});

describe('dates — ISO, and wordy full or abbreviated month names', () => {
	it('reads an ISO date', () => {
		expect(parseTrialText('Renews on 2026-09-19', 2).nextChargeOn).toBe('2026-09-19');
	});

	it('reads "19 Sept 2026" and "19 September 2026" identically', () => {
		expect(parseTrialText('Renews on 19 Sept 2026', 2).nextChargeOn).toBe('2026-09-19');
		expect(parseTrialText('Renews on 19 September 2026', 2).nextChargeOn).toBe('2026-09-19');
	});

	it('mirrors the same date into cancelByOn — a confirmation only ever names one deadline', () => {
		const parsed = parseTrialText('Renews on 19 September 2026', 2);
		expect(parsed.cancelByOn).toBe(parsed.nextChargeOn);
	});
});

describe('fills what it can read, asks only for what it could not', () => {
	it('fills every field from a full confirmation', () => {
		expect(parseTrialText(SAMPLE, 2)).toEqual({
			label: 'Google AI Plus (400 GB)',
			amountMinor: 54_900,
			cadence: 'monthly',
			nextChargeOn: '2026-09-19',
			trialDays: 7,
			cancelByOn: '2026-09-19'
		});
	});

	it('removing the price from the sample makes exactly that field null', () => {
		const withoutPrice = SAMPLE.replace('PHP 549.00 ', '');
		// The cadence word ("per month") and everything else in the sample
		// survives the price's removal untouched — only the price itself does
		// not, because cadence is read independently of the money match.
		expect(withoutPrice).not.toContain('PHP');
		expect(withoutPrice).toContain('per month');

		const parsed = parseTrialText(withoutPrice, 2);
		expect(parsed.amountMinor).toBeNull();
		expect(parsed.label).toBe('Google AI Plus (400 GB)');
		expect(parsed.cadence).toBe('monthly');
		expect(parsed.trialDays).toBe(7);
		expect(parsed.nextChargeOn).toBe('2026-09-19');
		expect(parsed.cancelByOn).toBe('2026-09-19');
	});

	it('removing the date makes exactly that field (and its mirror) null', () => {
		const withoutDate = SAMPLE.replace('Renews on 19 September 2026', '');
		const parsed = parseTrialText(withoutDate, 2);
		expect(parsed.nextChargeOn).toBeNull();
		expect(parsed.cancelByOn).toBeNull();
		expect(parsed.amountMinor).toBe(54_900);
		expect(parsed.label).toBe('Google AI Plus (400 GB)');
		expect(parsed.cadence).toBe('monthly');
		expect(parsed.trialDays).toBe(7);
	});

	it('returns every field null for text with none of the recognisable shapes', () => {
		const parsed = parseTrialText('thanks for your purchase', 2);
		expect(parsed.amountMinor).toBeNull();
		expect(parsed.cadence).toBeNull();
		expect(parsed.nextChargeOn).toBeNull();
		expect(parsed.trialDays).toBeNull();
		expect(parsed.cancelByOn).toBeNull();
	});
});
