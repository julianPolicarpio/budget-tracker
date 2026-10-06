import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../../scripts/apply-migrations.js';

// This has to precede every server import: db/index.ts refuses to fall back to
// the live database under Vitest.
process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-intent-route-')), 'split.db');
process.env.SPLIT_DISABLE_JOBS = '1';
process.env.LAYA_URL = 'http://127.0.0.1:3010';

type Route = typeof import('./+server');
let route: Route;

beforeAll(async () => {
	const db = await import('$lib/server/db');
	applyMigrations(db.sqlite, resolve('migrations'));
	db.sqlite.exec(
		`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
		   period_kind, week_starts_on, haircut_pct, band_pct, phase, timezone,
		   weekly_take_home_minor, created_at, user_id)
		 VALUES (1, 'PHP', '₱', 2, 100, 'weekly', 1, 15, 10, 0, 'Asia/Manila', 500000, 'x', 1)`
	);
	route = await import('./+server');
});

async function post(body: unknown, userId: number | null = 1) {
	return route.POST({
		request: new Request('http://localhost/api/intent', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		locals: userId === null ? {} : { userId }
	} as never);
}

describe('POST /api/intent', () => {
	it('rejects a caller without an authenticated user', async () => {
		const response = await post({ text: 'subscription ChatGPT 1100' }, null);
		expect(response.status).toBe(401);
	});

	it('rejects text above the sidecar input limit before routing it', async () => {
		const response = await post({ text: 'x'.repeat(1001) });
		expect(response.status).toBe(413);
	});

	it('returns a deterministic subscription draft without calling the sidecar', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const response = await post({ text: 'subscription ChatGPT 1,100' });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			kind: 'action',
			actionId: 'add-bill-subscription',
			draft: { fields: { label: 'ChatGPT', amount: '1100' } }
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('falls back to catalogue choices when the sidecar times out', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new DOMException('Timed out', 'AbortError');
			})
		);
		const response = await post({ text: 'help me organise this' });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			kind: 'choices',
			actionIds: ['add-bill-subscription', 'add-debt', 'save-for-later']
		});
		vi.unstubAllGlobals();
	});

	it('does not expose a malformed model choice as an action', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(JSON.stringify({ id: 'invent-an-action', probability: Number.NaN, margin: 0.5 }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)
		);
		const response = await post({ text: 'help me organise this' });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			kind: 'choices',
			actionIds: ['add-bill-subscription', 'add-debt', 'save-for-later']
		});
		vi.unstubAllGlobals();
	});

	it('keeps a valid model suggestion as a review choice', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'record-refund', probability: 0.91, margin: 0.4 }), { status: 200 })));
		const response = await post({ text: 'help me organise this' });
		expect(await response.json()).toEqual({ kind: 'choices', actionIds: ['record-refund', 'add-bill-subscription', 'add-debt'] });
		vi.unstubAllGlobals();
	});
});
