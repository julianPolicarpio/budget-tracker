const HOUR_MS = 3_600_000;
const SWEEP_EVERY = 100;

/**
 * The key one visitor's budget is spent under. IPv4 (and IPv4-mapped IPv6) by
 * address; IPv6 by its /64, because one subscriber is handed a whole /64 and
 * could otherwise mint from billions of addresses.
 */
export function limiterKey(ip: string): string {
	let a = ip.trim().toLowerCase().split('%')[0];
	const mapped = /^(?:0{0,4}:){2,5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a) ?? /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
	if (mapped) return mapped[1];
	if (!a.includes(':')) return a;
	const [head, tail] = a.split('::');
	const h = head ? head.split(':') : [];
	const t = a.includes('::') && tail ? tail.split(':') : [];
	const fill = a.includes('::') ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
	const groups = [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16).toString(16));
	return groups.slice(0, 4).join(':');
}

/** CF-Connecting-IP is trusted only in demo mode (the tunnel is the only way in). */
export function clientIp(o: { authKind: string; cfHeader: string | null | undefined; fallback: string }): string {
	if (o.authKind === 'demo') {
		const h = o.cfHeader?.trim();
		if (h) return h;
	}
	return o.fallback;
}

/** In-process, by design: one process serves the demo, and Spec §12 rules out Redis. */
export function createDemoLimiter(opts: { perIpPerHour: number; maxLive: number; now?: () => number }) {
	const now = opts.now ?? Date.now;
	const hits = new Map<string, number[]>();
	let calls = 0;
	return {
		check(ip: string, liveCount: number): 'ok' | 'too-many' | 'busy' {
			const t = now();
			if (++calls % SWEEP_EVERY === 0) {
				for (const [k, v] of hits) if (v.every((h) => t - h >= HOUR_MS)) hits.delete(k);
			}
			if (liveCount >= opts.maxLive) return 'busy';
			const key = limiterKey(ip);
			const recent = (hits.get(key) ?? []).filter((h) => t - h < HOUR_MS);
			if (recent.length >= opts.perIpPerHour) { hits.set(key, recent); return 'too-many'; }
			recent.push(t);
			hits.set(key, recent);
			return 'ok';
		},
		size(): number {
			return hits.size;
		}
	};
}

export const demoLimiter = createDemoLimiter({ perIpPerHour: 5, maxLive: 200 });
