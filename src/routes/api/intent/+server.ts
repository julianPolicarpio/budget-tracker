import { json } from '@sveltejs/kit';
import { CATALOGUE } from '$lib/actions/catalogue';
import { resolveProtectedIntent } from '$lib/actions/intent';
import { buildParseContext } from '$lib/server/entry';
import { classifyWithLaya } from '$lib/server/laya-client';
import { loadSettings } from '$lib/server/today';
import type { RequestHandler } from './$types';

const MAX_TEXT_LENGTH = 1_000;
const CHOICE_LIMIT = 3;
const DEFAULT_CHOICES = ['add-bill-subscription', 'add-debt', 'save-for-later'];
const DEFAULT_MODEL_OPTIONS = [
	'transfer-money',
	'record-refund',
	'add-trip',
	'create-planned-expense',
	'add-bill-subscription',
	'add-debt',
	'save-for-later'
];

function catalogueOrder(ids: readonly string[]): string[] {
	const wanted = new Set(ids);
	return CATALOGUE.filter((action) => wanted.has(action.id)).map((action) => action.id);
}

function matchingActionIds(text: string): string[] {
	const words = text.toLowerCase().match(/[a-z]{3,}/g) ?? [];
	return CATALOGUE.filter(
		(action) =>
			action.behaviour.kind === 'form' &&
			action.id !== 'log-spending' &&
			words.some((word) =>
				[action.label, ...action.terms].some((phrase) => phrase.toLowerCase().includes(word))
			)
	).map((action) => action.id);
}

function fallbackChoices(text: string): string[] {
	return catalogueOrder([...matchingActionIds(text), ...DEFAULT_CHOICES]).slice(0, CHOICE_LIMIT);
}

function modelOptions(text: string): { id: string; description: string }[] {
	const ids = catalogueOrder([...matchingActionIds(text), ...DEFAULT_MODEL_OPTIONS]).slice(0, 7);
	return [
		...ids.map((id) => ({ id, description: CATALOGUE.find((action) => action.id === id)!.label })),
		{ id: 'unclear', description: 'The request does not clearly ask for one of these actions.' }
	];
}

function choicesResponse(actionIds: string[]) {
	return json({ kind: 'choices' as const, actionIds });
}

async function requestText(request: Request): Promise<string | null> {
	try {
		const body: unknown = await request.json();
		if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
		const { text } = body as { text?: unknown };
		return typeof text === 'string' && text.trim() !== '' ? text : null;
	} catch {
		return null;
	}
}

/**
 * Proposes a reviewed form, never performs a financial write. The parser's
 * protected spending and existing-commitment routes deliberately stay choices
 * at this boundary, where the UI keeps their established manual flow.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!Number.isInteger(locals.userId) || locals.userId < 1) {
		return json({ error: 'Authentication is required.' }, { status: 401 });
	}

	const text = await requestText(request);
	if (text === null) return json({ error: 'Text is required.' }, { status: 400 });
	if (text.length > MAX_TEXT_LENGTH) return json({ error: 'Text is too long.' }, { status: 413 });

	const settings = loadSettings(locals.userId);
	if (!settings) return json({ error: 'Split is not initialised yet.' }, { status: 409 });

	const protectedIntent = resolveProtectedIntent(text, buildParseContext(locals.userId), settings.minorUnits);
	if (protectedIntent.kind === 'action') {
		return json({ kind: 'action' as const, actionId: protectedIntent.actionId, draft: protectedIntent.draft });
	}

	if (protectedIntent.kind !== 'choices') return choicesResponse(fallbackChoices(text));

	const fallback = fallbackChoices(text);
	const proposal = await classifyWithLaya(text, modelOptions(text));

	// A model-only suggestion stays a choice until Longhand-specific accuracy
	// has been measured. Its result can affect which three forms are offered,
	// but catalogue order remains stable and no form opens automatically.
	if (proposal && proposal.id !== 'unclear') {
		return choicesResponse(catalogueOrder([proposal.id, ...fallback.filter((id) => id !== proposal.id).slice(0, 2)]));
	}
	return choicesResponse(fallback);
};
