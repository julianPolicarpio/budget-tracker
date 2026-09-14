/**
 * The `.ics` calendar reminder (Spec §7.2).
 *
 * `notify()` is one `osascript` call: it only reaches a Mac that is awake
 * with a logged-in GUI session, and multi-user kills it outright — a desktop
 * notification on the server means nothing to a user on the other side of
 * the world. The reminder has to leave the app entirely. This builds a
 * single VEVENT with a VALARM, downloaded once from a route and added to the
 * user's own calendar. From then on it fires from their phone: offline, on a
 * dead server, in airplane mode — exactly the failure that nearly cost the
 * owner ₱1,100 this month.
 *
 * No dependency. RFC 5545 is a text format and the rules this needs are a
 * short, well-defined list: CRLF line endings, backslash/comma/semicolon/
 * newline escaping inside TEXT values, and folding any content line over 75
 * octets — not a library's worth of code.
 */

const CRLF = '\r\n';
const FOLD_LIMIT = 75;

/**
 * RFC 5545 §3.3.11 TEXT escaping. Order matters: escaping the backslash
 * FIRST means the backslashes this function itself inserts for the other
 * three cases are never re-escaped a second time.
 */
export function escapeIcsText(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold one logical content line at 75 octets (RFC 5545 §3.1). Every
 * continuation line starts with a single space, and that space counts
 * toward its own 75-octet budget. Splits are byte-safe — done on the UTF-8
 * encoding, backed off so a split never lands inside a multi-byte sequence —
 * because a currency symbol like ₱ is three bytes and a mid-sequence split
 * would hand a parser invalid UTF-8.
 */
function foldLine(content: string): string {
	const bytes = Buffer.from(content, 'utf8');
	if (bytes.length <= FOLD_LIMIT) return content;

	const segments: string[] = [];
	let offset = 0;
	let limit = FOLD_LIMIT;
	while (offset < bytes.length) {
		let end = Math.min(offset + limit, bytes.length);
		// A UTF-8 continuation byte has its top two bits set to '10' (0x80);
		// back off until `end` does not split one off from its leader.
		while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
		segments.push(bytes.subarray(offset, end).toString('utf8'));
		offset = end;
		limit = FOLD_LIMIT - 1; // the leading space on every continuation line
	}
	return segments.join(CRLF + ' ');
}

function property(name: string, value: string): string {
	return foldLine(`${name}:${value}`);
}

/** 'YYYYMMDDTHHMMSSZ', RFC 5545's UTC DATE-TIME form. */
function stampNow(now: Date): string {
	return now
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}Z$/, 'Z');
}

/** 'YYYY-MM-DD' -> 'YYYYMMDD', for a DATE-valued (all-day) DTSTART. */
function stampDate(isoDate: string): string {
	return isoDate.replace(/-/g, '');
}

export interface IcsSubscriptionEvent {
	/** Stable across regenerations of the same subscription's reminder — the
	 * route always builds this the same way from the subscription's own id,
	 * so re-adding it to a calendar updates one event rather than
	 * duplicating it. */
	uid: string;
	label: string;
	/** Already formatted for display (`$lib/money`'s `formatMoney`, run by
	 * the caller) — this module does no currency arithmetic of its own. */
	amountLabel: string;
	/** 'YYYY-MM-DD'. The deadline the event and its alarm are anchored to —
	 * `subscription.cancel_by_on`. */
	cancelByOn: string;
	isTrial: boolean;
	/** Days before `cancelByOn` the VALARM fires. Spec §7.2's default: 2. */
	leadDays?: number;
	now?: Date;
}

/** One VCALENDAR, one VEVENT, one VALARM — the whole reminder (Spec §7.2). */
export function buildSubscriptionIcs(input: IcsSubscriptionEvent): string {
	const leadDays = input.leadDays ?? 2;
	const now = input.now ?? new Date();

	const summary = `${input.label} — ${input.amountLabel}${
		input.isTrial ? ' (free trial ends)' : ' renews'
	}`;
	// Says what happens if the user does nothing, per Spec §7.2 — the whole
	// point of a reminder that fires with no app and no server in reach.
	const description = input.isTrial
		? `If you do nothing, the free trial for ${input.label} ends and it starts billing ${input.amountLabel}. Cancel before ${input.cancelByOn} if you do not want it.`
		: `${input.label} renews for ${input.amountLabel} on ${input.cancelByOn} unless you cancel it first.`;

	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Split//Subscription Reminder//EN',
		'CALSCALE:GREGORIAN',
		'BEGIN:VEVENT',
		property('UID', escapeIcsText(input.uid)),
		property('DTSTAMP', stampNow(now)),
		property('DTSTART;VALUE=DATE', stampDate(input.cancelByOn)),
		property('SUMMARY', escapeIcsText(summary)),
		property('DESCRIPTION', escapeIcsText(description)),
		'BEGIN:VALARM',
		'ACTION:DISPLAY',
		property('DESCRIPTION', escapeIcsText(description)),
		// Duration triggers are valid against a DATE-valued DTSTART as much as
		// a DATE-TIME one (RFC 5545 §3.8.6.3); RELATED defaults to START, so
		// this fires `leadDays` before `cancelByOn`, never after.
		property('TRIGGER', `-P${leadDays}D`),
		'END:VALARM',
		'END:VEVENT',
		'END:VCALENDAR'
	];

	return lines.join(CRLF) + CRLF;
}
