const HOUR_MS = 3_600_000;

/** In-process, by design: one process serves the demo, and Spec §12 rules out Redis. */
export function createDemoLimiter(opts: { perIpPerHour: number; maxLive: number; now?: () => number }) {
	const now = opts.now ?? Date.now;
	const hits = new Map<string, number[]>();
	return {
		check(ip: string, liveCount: number): 'ok' | 'too-many' | 'busy' {
			if (liveCount >= opts.maxLive) return 'busy';
			const t = now();
			const recent = (hits.get(ip) ?? []).filter((h) => t - h < HOUR_MS);
			if (recent.length >= opts.perIpPerHour) { hits.set(ip, recent); return 'too-many'; }
			recent.push(t);
			hits.set(ip, recent);
			return 'ok';
		}
	};
}

export const demoLimiter = createDemoLimiter({ perIpPerHour: 5, maxLive: 200 });
