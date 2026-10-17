import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../../scripts/apply-migrations.js';
import type { EvalCase, EvalRow } from '$lib/actions/laya-eval';
import type { Criteria } from '$lib/actions/routing';

const ENABLED = process.env.LAYA_EVAL === '1';
if (ENABLED) {
	// Before any server import: the db module must never fall back to data/split.db.
	process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-laya-eval-')), 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';
}

describe.skipIf(!ENABLED)('Laya eval (opt-in)', () => {
	let m: {
		intent: typeof import('$lib/actions/intent');
		entry: typeof import('$lib/server/entry');
		today: typeof import('$lib/server/today');
		routing: typeof import('$lib/actions/routing');
		evalLib: typeof import('$lib/actions/laya-eval');
	};
	let userId: number;

	beforeAll(async () => {
		const db = await import('$lib/server/db');
		applyMigrations(db.sqlite, resolve('migrations'));
		const demo = await import('$lib/server/demo');
		userId = demo.createDemoUser(); // the same seeded commitments a demo visitor gets
		m = {
			intent: await import('$lib/actions/intent'),
			entry: await import('$lib/server/entry'),
			today: await import('$lib/server/today'),
			routing: await import('$lib/actions/routing'),
			evalLib: await import('$lib/actions/laya-eval')
		};
	});

	it('runs the corpus through the real router and the real sidecar', async () => {
		const split = (process.env.LAYA_SPLIT ?? 'dev') as 'dev' | 'test';
		const criteria = (process.env.LAYA_CRITERIA ?? 'labels') as Criteria;
		const label = process.env.LAYA_RUN_LABEL ?? `${split}-${criteria}`;
		const base = process.env.LAYA_URL!;
		const minorUnits = m.today.loadSettings(userId)!.minorUnits;
		const cases: EvalCase[] = readFileSync(resolve('eval/laya/corpus.jsonl'), 'utf8')
			.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((c: EvalCase) => c.split === split);
		expect(cases.length).toBeGreaterThan(0);

		const health = await (await fetch(new URL('/health', base))).json();
		expect(health.status).toBe('ready');

		const rows: EvalRow[] = [];
		for (const c of cases) {
			const p = m.intent.resolveProtectedIntent(c.text, m.entry.buildParseContext(userId), minorUnits);
			if (p.kind !== 'choices') {
				const decided = p.kind === 'spending' ? 'log-spending' : p.kind === 'existing' ? 'record-payment' : p.actionId;
				rows.push({ ...c, route: 'parser', decided, probability: null, margin: null, latencyMs: null,
					choices: p.kind === 'action' ? [p.actionId] : m.routing.fallbackChoices(c.text) });
				continue;
			}
			const options = m.routing.modelOptions(c.text, criteria);
			const t0 = performance.now();
			const res = await fetch(new URL('/classify', base), {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: c.text, options })
			});
			const latencyMs = Math.round(performance.now() - t0);
			const body = res.ok ? await res.json() : null;
			const timedOut = latencyMs > m.evalLib.TIMEOUT_MS;
			const decided = body && !timedOut ? (body.id as string) : null;
			rows.push({ ...c, route: decided === null ? 'fallback' : 'model', decided,
				probability: body?.probability ?? null, margin: body?.margin ?? null, latencyMs,
				choices: m.routing.routedChoices(decided, c.text) });
		}

		const summary = m.evalLib.summarise(rows);
		mkdirSync(resolve('eval/laya/runs'), { recursive: true });
		writeFileSync(resolve(`eval/laya/runs/${label}.json`),
			JSON.stringify({ label, criteria, split, startedAt: new Date().toISOString(), rows, summary }, null, 2));
		console.log(JSON.stringify(summary, null, 2));
	}, 600_000);
});
