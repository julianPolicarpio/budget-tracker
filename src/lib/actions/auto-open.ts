import type { LayaChoice } from '$lib/server/laya-client';
import { NEVER_AUTO_OPEN } from './laya-eval';

export interface AutoOpenConfig {
	allowed: readonly string[];
	minProbability: number;
	minMargin: number;
}

/**
 * Chosen on the dev split of eval/laya/corpus.jsonl (see
 * eval/laya/results-2026-10-18.md, run dev-labels-v2): zero dangerous false
 * opens and >= 95% precision per allowed class. With every action offered, the
 * model's probabilities saturate near 1.0, so the allowlist (add-trip: 11/11
 * correct opens on the dev split) carries the safety, not the probability
 * threshold. Change only with a new eval run, never by hand to make a case pass.
 */
export const AUTO_OPEN: AutoOpenConfig = {
	allowed: ['add-trip'],
	minProbability: 0.95,
	minMargin: 0.5
};

export function shouldAutoOpen(choice: LayaChoice, config: AutoOpenConfig = AUTO_OPEN): boolean {
	if (NEVER_AUTO_OPEN.has(choice.id)) return false;
	return (
		config.allowed.includes(choice.id) &&
		choice.probability >= config.minProbability &&
		choice.margin >= config.minMargin
	);
}
