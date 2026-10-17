import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../../scripts/apply-migrations.js';
import { parseEntry } from '$lib/entry-parser';
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
		client: typeof import('$lib/server/laya-client');
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
			evalLib: await import('$lib/actions/laya-eval'),
			client: await import('$lib/server/laya-client')
		};
	});

	it('runs the corpus through the real router and the real sidecar', async () => {
		const split = process.env.LAYA_SPLIT ?? 'dev';
		if (split !== 'dev' && split !== 'test') throw new Error(`LAYA_SPLIT must be dev or test, got "${split}"`);
		const criteria: Criteria = (process.env.LAYA_CRITERIA ?? 'labels') as Criteria;
		if (criteria !== 'labels' && criteria !== 'descriptions') {
			throw new Error(`LAYA_CRITERIA must be labels or descriptions, got "${criteria}"`);
		}
		const base = process.env.LAYA_URL;
		if (!base) throw new Error('LAYA_URL is required, e.g. http://127.0.0.1:3010');
		const host = new URL(base).hostname;
		if (host !== '127.0.0.1' && host !== 'localhost') {
			throw new Error(`LAYA_URL must point at 127.0.0.1 or localhost, got "${host}"`);
		}
		const label = process.env.LAYA_RUN_LABEL ?? `${split}-${criteria}`;
		const minorUnits = m.today.loadSettings(userId)!.minorUnits;
		const cases: EvalCase[] = readFileSync(resolve('eval/laya/corpus.jsonl'), 'utf8')
			.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((c: EvalCase) => c.split === split);
		expect(cases.length).toBeGreaterThan(0);

		const health = await (await fetch(new URL('/health', base))).json();
		expect(health.status).toBe('ready');

		const rows: EvalRow[] = [];
		for (const c of cases) {
			const context = m.entry.buildParseContext(userId);
			const p = m.intent.resolveProtectedIntent(c.text, context, minorUnits);
			// Same comma stripping as resolveProtectedIntent, so the kind matches what it saw.
			const parseKind = parseEntry(m.intent.parserInput(c.text), context, minorUnits).kind;
			if (p.kind !== 'choices') {
				const decided = p.kind === 'spending' ? 'log-spending' : p.kind === 'existing' ? 'record-payment' : p.actionId;
				rows.push({ ...c, route: 'parser', decided, probability: null, margin: null, latencyMs: null,
					choices: p.kind === 'action' ? [p.actionId] : m.routing.fallbackChoices(c.text), parseKind });
				continue;
			}
			// Models the Continue tap. When the parser answers `ask_category` ("coffee 140") the UI
			// shows category chips that log it as spending, and /api/intent is only called if the user
			// taps Continue, meaning "this is not plain spending". So a case whose true intent is
			// log-spending never reaches the model; every other `choices` case does (the user tapped
			// Continue). This deliberately uses the corpus label to stand in for the user's own
			// knowledge of what they meant.
			if (c.expected === 'log-spending' && parseKind === 'ask_category') {
				rows.push({ ...c, route: 'parser', decided: 'log-spending', probability: null, margin: null,
					latencyMs: null, choices: m.routing.fallbackChoices(c.text), parseKind });
				continue;
			}
			const options = m.routing.modelOptions(c.text, criteria);
			const t0 = performance.now();
			let answer: { id: string; probability: number; margin: number } | null = null;
			let completed = false;
			try {
				const res = await fetch(new URL('/classify', base), {
					method: 'POST', headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ text: c.text, options }),
					signal: AbortSignal.timeout(5000)
				});
				if (res.ok) {
					const json = await res.json();
					completed = true;
					answer = m.client.validChoice(json, options.map((o) => o.id));
				} else completed = true;
			} catch {
				// network error, abort or invalid JSON: handled as a fallback below
			}
			const latencyMs = completed ? Math.round(performance.now() - t0) : null;
			const timedOut = latencyMs !== null && latencyMs > m.evalLib.TIMEOUT_MS;
			const body = answer && !timedOut ? answer : null;
			const decided = body ? body.id : null;
			rows.push({ ...c, route: decided === null ? 'fallback' : 'model', decided,
				probability: body?.probability ?? null, margin: body?.margin ?? null, latencyMs,
				choices: m.routing.routedChoices(decided, c.text), parseKind });
		}

		const summary = m.evalLib.summarise(rows);
		mkdirSync(resolve('eval/laya/runs'), { recursive: true });
		writeFileSync(resolve(`eval/laya/runs/${label}.json`),
			JSON.stringify({ label, criteria, split, startedAt: new Date().toISOString(), rows, summary }, null, 2));
		console.log(JSON.stringify(summary, null, 2));
	}, 600_000);
});
