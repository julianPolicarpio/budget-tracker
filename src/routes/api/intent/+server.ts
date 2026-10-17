import { json } from '@sveltejs/kit';
import { shouldAutoOpen } from '$lib/actions/auto-open';
import { draftForAction, resolveProtectedIntent } from '$lib/actions/intent';
import { fallbackChoices, modelOptions, routedChoices } from '$lib/actions/routing';
import { buildParseContext } from '$lib/server/entry';
import { classifyWithLaya } from '$lib/server/laya-client';
import { loadSettings } from '$lib/server/today';
import type { RequestHandler } from './$types';

const MAX_TEXT_LENGTH = 1_000;
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

	const proposal = await classifyWithLaya(text, modelOptions(text));

	// A model answer opens a reviewed form only through shouldAutoOpen (measured
	// allowlist and thresholds). Anything else only affects which three forms are
	// offered. Nothing is written without a submit.
	if (proposal && shouldAutoOpen(proposal)) {
		return json({ kind: 'action' as const, actionId: proposal.id, draft: draftForAction(proposal.id, text, settings.minorUnits) });
	}

	return choicesResponse(routedChoices(proposal?.id ?? null, text));
};
