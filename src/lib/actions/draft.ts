import { parseMoney } from '$lib/money';

/**
 * Text copied from a typed request into a reviewed form. Fields are strings
 * because the form remains the authority that validates and saves them.
 */
export interface ActionDraft {
	actionId: string;
	sourceText: string;
	fields: Record<string, string>;
}

const AMOUNT = /(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const CADENCE = /\b(?:weekly|fortnightly|biweekly|monthly|quarterly|semiannual|semi-annually|annually|annual|yearly)\b/i;

function explicitDate(raw: string): string | undefined {
	const date = ISO_DATE.exec(raw)?.[0];
	if (!date) return undefined;
	const parsed = new Date(`${date}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : undefined;
}

function explicitCadence(raw: string): string | undefined {
	const word = CADENCE.exec(raw)?.[0].toLowerCase();
	if (!word) return undefined;
	if (word === 'biweekly') return 'fortnightly';
	if (word === 'yearly' || word === 'annually') return 'annual';
	if (word === 'semi-annually') return 'semiannual';
	return word;
}

function explicitAmount(raw: string, minorUnits: number): string | null {
	const match = AMOUNT.exec(raw.replace(ISO_DATE, ' '));
	if (!match) return null;
	const minor = parseMoney(match[0], minorUnits);
	if (minor === null || minor < 0) return null;
	return match[0].replace(/,/g, '');
}

function labelAfterRemoving(raw: string, action: RegExp): string | undefined {
	const label = raw
		.replace(ISO_DATE, ' ')
		.replace(action, ' ')
		.replace(AMOUNT, ' ')
		.replace(CADENCE, ' ')
		.replace(/\b(?:on|due|billing\s+date)\b/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!label) return undefined;
	if (/^chatgpt$/i.test(label)) return 'ChatGPT';
	return label[0].toUpperCase() + label.slice(1);
}

/**
 * Create the smallest draft the typed text explicitly supports. No date,
 * cadence, account, category, purpose, or debt repayment details are ever
 * inferred here.
 */
export function draftForAction(actionId: string, raw: string, minorUnits: number): ActionDraft {
	const amount = explicitAmount(raw, minorUnits);
	const fields: Record<string, string> = {};
	const addAmount = (allowed: boolean) => {
		if (allowed && amount !== null) fields.amount = amount;
	};
	const addLabel = (action: RegExp) => {
		const label = labelAfterRemoving(raw, action);
		if (label !== undefined) fields.label = label;
	};

	switch (actionId) {
		case 'add-bill-subscription':
			addLabel(/\b(?:add\s+(?:a\s+)?bill|subscription|bill)\b/gi);
			addAmount(true);
			if (explicitCadence(raw)) fields.cadence = explicitCadence(raw)!;
			if (explicitDate(raw)) fields.nextChargeOn = explicitDate(raw)!;
			break;
		case 'create-planned-expense':
			addLabel(/\b(?:create\s+planned\s+expense|planned\s+expense|big\s+bill)\b/gi);
			addAmount(true);
			break;
		case 'save-for-later':
			addLabel(/\b(?:save\s+for\s+later|wishlist)\b/gi);
			addAmount(true);
			break;
		case 'add-trip':
			addLabel(/\b(?:plan\s+(?:a\s+)?trip(?:\s+to)?|add\s+trip|trip)\b/gi);
			addAmount(true);
			break;
		case 'add-account':
			addLabel(/\b(?:new\s+bank\s+account|add\s+account|account)\b/gi);
			break;
		case 'record-income':
		case 'record-refund':
		case 'transfer-money':
		case 'move-between-purposes':
		case 'fund-planned-expense':
			addAmount(true);
			break;
		// These forms require further details. Copying a label or amount would
		// make the draft look more complete than the request actually is.
		default:
			break;
	}

	return { actionId, sourceText: raw, fields };
}
