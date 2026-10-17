export type Tag = 'plain-spending' | 'new-bill' | 'existing-bill' | 'transfer' | 'refund' | 'plan' | 'debt' | 'income' | 'trip' | 'savings' | 'ambiguous';
export interface EvalCase { text: string; expected: string; tag: Tag; lang: 'en' | 'taglish'; source: 'authored' | 'owner'; split: 'dev' | 'test'; }
export type Route = 'parser' | 'model' | 'fallback';
export interface EvalRow extends EvalCase {
	route: Route; // parser decided / model answered / model unavailable or timed out (> 750 ms)
	decided: string | null; // parser's id, or the model's id (incl. 'unclear'); null on fallback
	probability: number | null;
	margin: number | null;
	latencyMs: number | null;
	choices: string[]; // what /api/intent would offer
}
export interface Thresholds { probability: number; margin: number; allowed: string[]; }

export const TIMEOUT_MS = 750;
export const NEVER_AUTO_OPEN: ReadonlySet<string> = new Set(['record-payment', 'add-debt', 'update-balance', 'transfer-money', 'unclear', 'log-spending']);
export const AUTO_OPEN_CANDIDATES = ['add-bill-subscription', 'record-refund', 'create-planned-expense', 'add-trip', 'record-income', 'save-for-later'] as const;
const MONEY_MOVING = new Set(['log-spending', 'record-income', 'transfer-money', 'record-payment', 'record-refund', 'fund-planned-expense', 'move-between-purposes', 'add-debt', 'update-balance']);

export function isDangerousOpen(expected: string, opened: string): boolean {
	if (expected === opened) return false;
	return expected === 'unclear' || MONEY_MOVING.has(expected) || MONEY_MOVING.has(opened);
}

export interface Tally { n: number; top1: number; offered: number; }
export interface Summary {
	overall: Tally;
	byTag: Record<string, Tally>;
	byLang: Record<string, Tally>;
	modelOnly: { n: number; top1: number };
	confusions: { expected: string; decided: string; count: number }[];
	latency: { p50: number | null; p95: number | null; max: number | null; overTimeout: number };
}
export interface ClassStats { opens: number; correct: number; wrong: number; dangerous: number; }

function tally(rows: EvalRow[]): Tally {
	return {
		n: rows.length,
		top1: rows.filter((r) => r.decided === r.expected).length,
		offered: rows.filter((r) => r.decided === r.expected || r.choices.includes(r.expected)).length
	};
}

function groupBy(rows: EvalRow[], key: (r: EvalRow) => string): Record<string, Tally> {
	const out: Record<string, EvalRow[]> = {};
	for (const r of rows) (out[key(r)] ??= []).push(r);
	return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, tally(v)]));
}

function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function summarise(rows: EvalRow[]): Summary {
	const model = rows.filter((r) => r.route === 'model');
	const lat = rows.map((r) => r.latencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
	const conf = new Map<string, number>();
	for (const r of rows) {
		if (r.decided === null || r.decided === r.expected) continue;
		const k = `${r.expected}\u0000${r.decided}`;
		conf.set(k, (conf.get(k) ?? 0) + 1);
	}
	return {
		overall: tally(rows),
		byTag: groupBy(rows, (r) => r.tag),
		byLang: groupBy(rows, (r) => r.lang),
		modelOnly: { n: model.length, top1: model.filter((r) => r.decided === r.expected).length },
		confusions: [...conf].map(([k, count]) => {
			const [expected, decided] = k.split('\u0000');
			return { expected, decided, count };
		}).sort((a, b) => b.count - a.count),
		latency: { p50: percentile(lat, 50), p95: percentile(lat, 95), max: lat.at(-1) ?? null, overTimeout: lat.filter((x) => x > TIMEOUT_MS).length }
	};
}

const P_GRID = Array.from({ length: 14 }, (_, i) => +(0.3 + i * 0.05).toFixed(2)); // 0.30..0.95
const M_GRID = Array.from({ length: 11 }, (_, i) => +(i * 0.05).toFixed(2)); // 0.00..0.50

function statsAt(rows: EvalRow[], id: string, p: number, m: number): ClassStats {
	// A null probability or margin must never count as an open (null >= 0 is true in JS).
	const opens = rows.filter(
		(r) => r.route === 'model' && r.decided === id && r.probability !== null && r.margin !== null && r.probability >= p && r.margin >= m
	);
	const correct = opens.filter((r) => r.expected === id).length;
	return { opens: opens.length, correct, wrong: opens.length - correct, dangerous: opens.filter((r) => isDangerousOpen(r.expected, id)).length };
}

/**
 * One global (probability, margin) pair plus a per-class allowlist. A class
 * qualifies at a grid point with >= minSupport opens, zero dangerous opens and
 * >= 95% precision. The pair maximising correct auto-opens wins; ties go to the
 * higher (more conservative) pair.
 */
export function chooseThresholds(rows: EvalRow[], minSupport = 3): Thresholds & { perClass: Record<string, ClassStats> } {
	let best: Thresholds & { perClass: Record<string, ClassStats> } = { probability: 1, margin: 1, allowed: [], perClass: {} };
	let bestScore = 0;
	for (const p of P_GRID) for (const m of M_GRID) {
		const perClass: Record<string, ClassStats> = {};
		const allowed: string[] = [];
		let score = 0;
		for (const id of AUTO_OPEN_CANDIDATES) {
			if (NEVER_AUTO_OPEN.has(id)) continue;
			const s = statsAt(rows, id, p, m);
			perClass[id] = s;
			if (s.opens >= minSupport && s.dangerous === 0 && s.correct / s.opens >= 0.95) {
				allowed.push(id);
				score += s.correct;
			}
		}
		if (score > bestScore || (score === bestScore && score > 0 && (p > best.probability || (p === best.probability && m > best.margin)))) {
			best = { probability: p, margin: m, allowed, perClass };
			bestScore = score;
		}
	}
	return best;
}
