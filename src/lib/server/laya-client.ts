/** The local model is optional; callers get null for every unavailable state. */
export interface LayaOption {
	id: string;
	description: string;
}

export interface LayaChoice {
	id: string;
	probability: number;
	margin: number;
}

const TIMEOUT_MS = 750;
const INTERNAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'laya', 'host.docker.internal']);

function configuredUrl(): URL | null {
	const raw = process.env.LAYA_URL?.trim();
	if (!raw) return null;
	try {
		const url = new URL(raw);
		if (url.protocol !== 'http:' || !INTERNAL_HOSTS.has(url.hostname)) return null;
		return url;
	} catch {
		return null;
	}
}

export function validChoice(value: unknown, allowedIds: readonly string[]): LayaChoice | null {
	if (!value || typeof value !== 'object') return null;
	const { id, probability, margin } = value as Record<string, unknown>;
	if (typeof id !== 'string' || !allowedIds.includes(id)) return null;
	if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
		return null;
	}
	if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0 || margin > 1) return null;
	return { id, probability, margin };
}

/**
 * Ask the optional internal classifier for one of the supplied catalogue IDs.
 * It deliberately swallows service failures: routing remains usable without
 * the sidecar and callers fall back to their stable choices.
 */
export async function classifyWithLaya(text: string, options: readonly LayaOption[]): Promise<LayaChoice | null> {
	const base = configuredUrl();
	if (!base || options.length === 0 || options.length > 16) return null;

	const ids = options.map((option) => option.id);
	if (new Set(ids).size !== ids.length) return null;

	try {
		const response = await fetch(new URL('/classify', base), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text, options }),
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (!response.ok) return null;
		return validChoice(await response.json(), ids);
	} catch {
		return null;
	}
}
