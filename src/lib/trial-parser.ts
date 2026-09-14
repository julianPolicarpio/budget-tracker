/**
 * The trial confirmation parser (Spec §7.1).
 *
 * `split-combined-spec.md` already forbids OCR outright: "No receipt
 * scanning, OCR, or photo attachments. Adds friction to the one ritual that
 * must stay under 60 seconds." Both phone platforms already do on-device OCR
 * better than anything this app could bundle — iOS Live Text, Android
 * screenshot text selection. The user copies the confirmation text and
 * pastes it here; this module's whole job is turning that paste into as much
 * of a subscription row as the text actually contains.
 *
 * Pure and DB-free on purpose, same reasoning as `entry-parser.ts`: it runs
 * in the browser, ahead of any network round trip, so the paste UI can show
 * what it found (and what it could not) before anything saves. The rule that
 * matters is the owner's own: fill what you can read, ask only for what you
 * could not. `isEssential` is never one of the fields this asks about — a
 * trial signed up for in order to cancel is never essential (Spec §7.1) — so
 * it is not part of `ParsedTrial` at all.
 *
 * Money never goes through anything but `parseMoney` (invariant 5): the
 * digit string is extracted here, the conversion to minor units happens in
 * `$lib/money`, and there is no `parseFloat` in this file.
 */

import { parseMoney } from './money';
import type { Cadence } from './subscription-cadence';

export interface ParsedTrial {
	label: string | null;
	amountMinor: number | null;
	cadence: Cadence | null;
	/** 'YYYY-MM-DD'. The date the confirmation names as the renewal / trial
	 * end — the same date `cancelByOn` below carries, because a trial
	 * confirmation only ever names one date and the app's own convention
	 * (see `subscriptions/+page.server.ts`) is that the cancel-by deadline
	 * defaults to the charge date unless a vendor demands earlier notice. */
	nextChargeOn: string | null;
	/** A trial LENGTH in days, read straight off text like "Free for 7
	 * days" — not derived from `nextChargeOn` and "today", because this
	 * module has no clock and none of its callers need one to fill this
	 * field. A caller with a clock (the paste-to-subscription action) is
	 * free to derive the same number from `nextChargeOn` when this is null
	 * but a date was found. */
	trialDays: number | null;
	cancelByOn: string | null;
}

/** A currency marker immediately (optionally with a space) before a number.
 * The marker's identity is not used for anything — Spec §1 rules out an FX
 * service, so every subscription amount is recorded at what it actually
 * costs in the home currency, whatever symbol the vendor's page happened to
 * show the user. */
const MONEY_RE = /(?:₱|PHP|\$|USD|€|EUR|£|GBP)\s*(\d[\d,]*(?:\.\d{1,2})?)/i;

/** Searched independently of `MONEY_RE`, deliberately: a confirmation often
 * reads "PHP 549.00 per month", and the cadence word must survive even when
 * the price substring is edited or missing. */
const CADENCE_WORDS: ReadonlyArray<readonly [RegExp, Cadence]> = [
	[/\bfortnightly\b|\bfortnight\b|\bevery\s+(?:two|2)\s+weeks?\b/i, 'fortnightly'],
	[/\bweekly\b|\ba\s+week\b|\/\s*wk\b/i, 'weekly'],
	[/\bquarterly\b|\bevery\s+(?:three|3)\s+months?\b/i, 'quarterly'],
	[/\bsemi-?annual(?:ly)?\b|\bevery\s+(?:six|6)\s+months?\b|\btwice\s+a\s+year\b/i, 'semiannual'],
	[/\bannually\b|\byearly\b|\ba\s+year\b|\bper\s+year\b|\/\s*yr\b|\bannual\b/i, 'annual'],
	[/\bmonthly\b|\ba\s+month\b|\bper\s+month\b|\/\s*mo\b|\/\s*month\b/i, 'monthly']
];

/** "Free for 7 days" / "7-day free trial" / "7 day trial". */
const TRIAL_DAYS_RE = /(\d+)[\s-]*day(?:s)?\s*(?:free\s*)?trial|free\s*(?:for\s*)?(\d+)\s*day/i;

const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
/** "19 September 2026", "19 Sept 2026", "19th Sept. 2026". */
const WORDY_DATE_RE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/;

const MONTHS: Record<string, number> = {
	jan: 1,
	january: 1,
	feb: 2,
	february: 2,
	mar: 3,
	march: 3,
	apr: 4,
	april: 4,
	may: 5,
	jun: 6,
	june: 6,
	jul: 7,
	july: 7,
	aug: 8,
	august: 8,
	sep: 9,
	sept: 9,
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12
};

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

function extractDate(text: string): string | null {
	const iso = ISO_DATE_RE.exec(text);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

	const wordy = WORDY_DATE_RE.exec(text);
	if (wordy) {
		const [, day, monthRaw, year] = wordy;
		const month = MONTHS[monthRaw.toLowerCase()];
		if (month) return `${year}-${pad2(month)}-${pad2(Number(day))}`;
	}
	return null;
}

/**
 * The first line that is not itself a price or a date/trial phrase — real
 * confirmations put the product name on its own line ("Google AI Plus (400
 * GB)", "ChatGPT Plus"). Not exported: this is a heuristic, not a contract
 * another module should depend on.
 */
function extractLabel(text: string): string | null {
	for (const rawLine of text.split(/\r?\n/)) {
		const candidate = rawLine.trim();
		if (!candidate) continue;
		if (MONEY_RE.test(candidate)) continue;
		if (TRIAL_DAYS_RE.test(candidate)) continue;
		if (/renews?\s+on/i.test(candidate)) continue;
		return candidate.replace(/[.:,]+$/, '');
	}
	return null;
}

/** Parse a pasted trial confirmation. `minorUnits` is the home currency's —
 * see `$lib/money` — never the vendor's, per the module doc above. */
export function parseTrialText(raw: string, minorUnits: number): ParsedTrial {
	const text = raw ?? '';

	const moneyMatch = MONEY_RE.exec(text);
	const amountMinor = moneyMatch ? parseMoney(moneyMatch[1], minorUnits) : null;

	let cadence: Cadence | null = null;
	for (const [re, c] of CADENCE_WORDS) {
		if (re.test(text)) {
			cadence = c;
			break;
		}
	}

	const trialMatch = TRIAL_DAYS_RE.exec(text);
	const trialDays = trialMatch ? Number(trialMatch[1] ?? trialMatch[2]) : null;

	const date = extractDate(text);

	return {
		label: extractLabel(text),
		amountMinor,
		cadence,
		nextChargeOn: date,
		trialDays,
		cancelByOn: date
	};
}
