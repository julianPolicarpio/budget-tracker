import { CATALOGUE } from './catalogue';

export const CHOICE_LIMIT = 3;
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

export function modelOptions(text: string, _criteria: Criteria = 'labels'): { id: string; description: string }[] {
	const ids = catalogueOrder([...matchingActionIds(text), ...DEFAULT_MODEL_OPTIONS]).slice(0, 7);
	return [
		...ids.map((id) => ({ id, description: CATALOGUE.find((action) => action.id === id)!.label })),
		{ id: 'unclear', description: 'The request does not clearly ask for one of these actions.' }
	];
}

export function routedChoices(modelId: string | null, text: string): string[] {
	const fallback = fallbackChoices(text);
	if (!modelId || modelId === 'unclear') return fallback;
	return catalogueOrder([modelId, ...fallback.filter((id) => id !== modelId).slice(0, 2)]);
}
