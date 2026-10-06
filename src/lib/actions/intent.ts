import { parseEntry, type ParseContext } from '$lib/entry-parser';
import { actionById } from './catalogue';
import { draftForAction, type ActionDraft } from './draft';

export type ProtectedIntent =
	| { kind: 'spending' }
	| { kind: 'existing' }
	| { kind: 'choices' }
	| { kind: 'action'; actionId: string; draft: ActionDraft };

export type ModelChoice = { id: unknown; probability: unknown };

type ExplicitAction = { id: string; pattern: RegExp };

// Ordered from the least ambiguous phrases to single action words. This only
// chooses a form; the draft layer copies no field the text did not state.
const EXPLICIT_ACTIONS: readonly ExplicitAction[] = [
	{ id: 'record-income', pattern: /\b(?:record\s+income|salary|sweldo|paycheck)\b/i },
	{ id: 'record-refund', pattern: /\b(?:record\s+(?:a\s+)?refund|refund|money\s+back)\b/i },
	{ id: 'fund-planned-expense', pattern: /\b(?:fund\s+(?:a\s+)?planned\s+expense|set\s+aside|fund)\b/i },
	{ id: 'move-between-purposes', pattern: /\b(?:move\s+money|move\s+between\s+purposes|ilipat)\b/i },
	{ id: 'transfer-money', pattern: /\b(?:transfer|withdraw|atm)\b/i },
	{ id: 'add-trip', pattern: /\b(?:plan\s+(?:a\s+)?trip|add\s+trip)\b/i },
	{ id: 'create-planned-expense', pattern: /\b(?:create\s+planned\s+expense|planned\s+expense|big\s+bill)\b/i },
	{ id: 'add-bill-subscription', pattern: /\b(?:add\s+(?:a\s+)?bill|subscription|bill|recurring)\b/i },
	{ id: 'add-debt', pattern: /\b(?:add\s+debt|debt|loan|credit\s+card)\b/i },
	{ id: 'save-for-later', pattern: /\b(?:save\s+for\s+later|wishlist)\b/i },
	{ id: 'add-account', pattern: /\b(?:add\s+account|new\s+bank\s+account)\b/i },
	{ id: 'add-edit-rule', pattern: /\b(?:add\s+rule|edit\s+rule)\b/i },
	{ id: 'set-budget', pattern: /\b(?:set\s+budget|change\s+budget|budget)\b/i },
	{ id: 'record-payment', pattern: /\b(?:record\s+(?:a\s+)?payment|payment)\b/i }
];

/**
 * Keep typed ordinary spending and named live commitments on their current
 * routes. Only requests that survive those protections can select a form.
 */
export function resolveProtectedIntent(raw: string, context: ParseContext, minorUnits: number): ProtectedIntent {
	// `entry-parser` accepts a plain decimal amount. Remove grouping commas
	// only for its classification pass; the draft still retains the original
	// source text and `draftForAction` validates its amount separately.
	const parserInput = raw.replace(/(?<=\d),(?=\d{3}\b)/g, '');
	const parsed = parseEntry(parserInput, context, minorUnits);
	if (parsed.kind === 'existing_commitment') return { kind: 'existing' };
	if (parsed.kind === 'transaction') return { kind: 'spending' };
	if (parsed.kind === 'new_commitment') {
		const actionId = 'add-bill-subscription';
		return { kind: 'action', actionId, draft: draftForAction(actionId, raw, minorUnits) };
	}

	const action = EXPLICIT_ACTIONS.find(({ pattern }) => pattern.test(raw));
	if (!action || !actionById(action.id)) return { kind: 'choices' };
	return { kind: 'action', actionId: action.id, draft: draftForAction(action.id, raw, minorUnits) };
}

/**
 * Model output is advisory. A caller must supply its own current shortlist,
 * so stale IDs and malformed confidence values never select a form.
 */
export function acceptModelChoice(reply: unknown, allowedIds: readonly string[]): string | null {
	if (!reply || typeof reply !== 'object') return null;
	const { id, probability } = reply as ModelChoice;
	if (typeof id !== 'string' || !allowedIds.includes(id)) return null;
	if (typeof probability !== 'number' || !Number.isFinite(probability)) return null;
	if (probability < 0 || probability > 1) return null;
	return id;
}

export { draftForAction } from './draft';
