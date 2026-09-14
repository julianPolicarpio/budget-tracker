import { describe, expect, it } from 'vitest';
import { buildSubscriptionIcs, escapeIcsText } from './ics';

/** Rebuild the logical (unfolded) content lines from raw `.ics` text — RFC
 * 5545 folding says "CRLF followed by a single linear whitespace" is a
 * continuation marker, not a line break. This is the minimal amount of
 * parsing needed to assert on property values without a dependency. */
function unfold(ics: string): string[] {
	const physical = ics.split('\r\n');
	const logical: string[] = [];
	for (const raw of physical) {
		if ((raw.startsWith(' ') || raw.startsWith('\t')) && logical.length > 0) {
			logical[logical.length - 1] += raw.slice(1);
		} else if (raw !== '') {
			logical.push(raw);
		}
	}
	return logical;
}

function property(ics: string, name: string): string | undefined {
	const found = unfold(ics).find((l) => l.startsWith(name + ':') || l.startsWith(name + ';'));
	if (!found) return undefined;
	return found.slice(found.indexOf(':') + 1);
}

describe('buildSubscriptionIcs', () => {
	const base = {
		uid: 'split-subscription-1@split.local',
		label: 'ChatGPT Plus',
		amountLabel: '₱1,100.00',
		cancelByOn: '2026-09-24',
		isTrial: true,
		now: new Date('2026-09-14T00:00:00.000Z')
	};

	it('uses CRLF line endings throughout — no bare LF', () => {
		const ics = buildSubscriptionIcs(base);
		expect(ics).toContain('\r\n');
		// A lone '\n' not preceded by '\r' would mean a line break slipped in
		// without its required CR.
		expect(/(?<!\r)\n/.test(ics)).toBe(false);
	});

	it('parses into the expected VCALENDAR/VEVENT/VALARM structure', () => {
		const ics = buildSubscriptionIcs(base);
		const logical = unfold(ics);
		expect(logical[0]).toBe('BEGIN:VCALENDAR');
		expect(logical).toContain('BEGIN:VEVENT');
		expect(logical).toContain('BEGIN:VALARM');
		expect(logical).toContain('END:VALARM');
		expect(logical).toContain('END:VEVENT');
		expect(logical[logical.length - 1]).toBe('END:VCALENDAR');
	});

	it('defaults the VALARM to TRIGGER:-P2D, two days before cancelByOn', () => {
		const ics = buildSubscriptionIcs(base);
		expect(property(ics, 'TRIGGER')).toBe('-P2D');
	});

	it('carries a UID and a DTSTAMP', () => {
		const ics = buildSubscriptionIcs(base);
		expect(property(ics, 'UID')).toBe(base.uid);
		expect(property(ics, 'DTSTAMP')).toMatch(/^\d{8}T\d{6}Z$/);
	});

	it('anchors DTSTART on cancelByOn as an all-day DATE value', () => {
		const ics = buildSubscriptionIcs(base);
		expect(property(ics, 'DTSTART;VALUE=DATE')).toBe('20260924');
	});

	it('SUMMARY names the thing and the amount', () => {
		const ics = buildSubscriptionIcs(base);
		// The raw property is TEXT-escaped (the amount's comma becomes '\,'),
		// so check the content ignoring the RFC 5545 escaping, not the exact
		// bytes — `escapeIcsText` itself is covered separately below.
		const summary = property(ics, 'SUMMARY')!.replace(/\\,/g, ',');
		expect(summary).toContain('ChatGPT Plus');
		expect(summary).toContain('₱1,100.00');
	});

	it('DESCRIPTION says what happens if the user does nothing', () => {
		const ics = buildSubscriptionIcs(base);
		expect(property(ics, 'DESCRIPTION')).toMatch(/if you do nothing/i);

		const nonTrial = buildSubscriptionIcs({ ...base, isTrial: false });
		expect(property(nonTrial, 'DESCRIPTION')).toMatch(/renews for/i);
	});

	it('escapes a label containing a comma and a semicolon', () => {
		const ics = buildSubscriptionIcs({ ...base, label: 'Netflix, Standard; with ads' });
		// The RAW text must carry the backslash-escaped forms — an
		// unescaped ',' or ';' in a TEXT value is a malformed calendar file.
		expect(ics).toContain('Netflix\\, Standard\\; with ads');
		// And unescaping the parsed SUMMARY must round-trip to the original.
		const summary = property(ics, 'SUMMARY')!;
		const unescaped = summary
			.replace(/\\n/g, '\n')
			.replace(/\\,/g, ',')
			.replace(/\\;/g, ';')
			.replace(/\\\\/g, '\\');
		expect(unescaped).toContain('Netflix, Standard; with ads');
	});

	it('folds a content line longer than 75 octets, and unfolding reconstructs it exactly', () => {
		const longLabel = 'A Very Long Subscription Name That Goes On For Quite A While Indeed Limited';
		const ics = buildSubscriptionIcs({ ...base, label: longLabel });

		// Every physical line — the raw SUMMARY property included — must
		// actually have been split at 75 octets or fewer.
		for (const physicalLine of ics.split('\r\n')) {
			expect(Buffer.byteLength(physicalLine, 'utf8')).toBeLessThanOrEqual(75);
		}

		const summary = property(ics, 'SUMMARY')!;
		expect(summary).toContain(longLabel);
	});

	it('folds byte-safely around a multi-byte currency symbol with no corruption', () => {
		const ics = buildSubscriptionIcs({
			...base,
			amountLabel: '1,100.00', // no ₱ here — isolates the count below to the label
			label: '₱'.repeat(40) + ' Long Label Padding To Force A Fold Right Around Here'
		});
		for (const physicalLine of ics.split('\r\n')) {
			expect(Buffer.byteLength(physicalLine, 'utf8')).toBeLessThanOrEqual(75);
		}
		// Every peso sign must have survived the fold intact — a corrupted
		// split would break the UTF-8 sequence and change the character count.
		const summary = property(ics, 'SUMMARY')!;
		expect((summary.match(/₱/g) ?? []).length).toBe(40);
	});

	it('honours an explicit leadDays override', () => {
		const ics = buildSubscriptionIcs({ ...base, leadDays: 5 });
		expect(property(ics, 'TRIGGER')).toBe('-P5D');
	});
});

describe('escapeIcsText', () => {
	it('escapes backslash first so its own insertions are not double-escaped', () => {
		expect(escapeIcsText('a\\b,c;d\ne')).toBe('a\\\\b\\,c\\;d\\ne');
	});
});
