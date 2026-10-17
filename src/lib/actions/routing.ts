import { CATALOGUE } from './catalogue';

export const CHOICE_LIMIT = 3;
const DEFAULT_CHOICES = ['add-bill-subscription', 'add-debt', 'save-for-later'];

export type Criteria = 'labels' | 'descriptions';

export function catalogueOrder(ids: readonly string[]): string[] {
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

export function fallbackChoices(text: string): string[] {
	return catalogueOrder([...matchingActionIds(text), ...DEFAULT_CHOICES]).slice(0, CHOICE_LIMIT);
}

function describe(id: string, criteria: Criteria): string {
	const action = CATALOGUE.find((a) => a.id === id)!;
	return criteria === 'descriptions' ? (action.modelDescription ?? action.label) : action.label;
}

/**
 * What the model chooses between: every catalogue action except `log-spending`
 * (ordinary spending never reaches the model), in catalogue order, then
 * `unclear`. This is deliberately not a keyword shortlist: measured on the dev
 * corpus, a shortlist hid the right action in a third of cases (55 of 163), so
 * the model now sees them all and the options limit is 16. `text` is unused
 * and kept so callers do not change.
 */
export function modelOptions(_text: string, criteria: Criteria = 'labels'): { id: string; description: string }[] {
	const ids = CATALOGUE.filter((action) => action.id !== 'log-spending').map((action) => action.id);
	return [
		...ids.map((id) => ({ id, description: describe(id, criteria) })),
		{ id: 'unclear', description: 'The request does not clearly ask for one of these actions.' }
	];
}

export function routedChoices(modelId: string | null, text: string): string[] {
	const fallback = fallbackChoices(text);
	if (!modelId || modelId === 'unclear') return fallback;
	return catalogueOrder([modelId, ...fallback.filter((id) => id !== modelId).slice(0, 2)]);
}
