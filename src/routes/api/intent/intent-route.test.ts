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

	it('keeps a dangerous model answer as choices even at probability 1', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'transfer-money', probability: 1, margin: 1 })));
		const response = await post({ text: 'help me organise this' });
		expect((await response.json()).kind).toBe('choices');
		vi.unstubAllGlobals();
	});

	it('keeps an allowed answer as choices below either threshold', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'add-trip', probability: 0.9, margin: 1 })));
		expect((await (await post({ text: 'help me organise this' })).json()).kind).toBe('choices');
		vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'add-trip', probability: 1, margin: 0.4 })));
		expect((await (await post({ text: 'help me organise this' })).json()).kind).toBe('choices');
		vi.unstubAllGlobals();
	});

	it('opens a reviewed form when an allowed answer clears both thresholds', async () => {
		const { AUTO_OPEN } = await import('$lib/actions/auto-open');
		expect(AUTO_OPEN.allowed.length).toBeGreaterThan(0);
		const id = AUTO_OPEN.allowed[0];
		vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id, probability: 1, margin: 1 })));
		const response = await post({ text: 'help me organise this' });
		expect(await response.json()).toMatchObject({ kind: 'action', actionId: id });
		vi.unstubAllGlobals();
	});

	it('copies the stated amount into the opened draft', async () => {
		const { draftForAction } = await import('$lib/actions/intent');
		const text = 'tokyo in april 5,000';
		const fetchMock = vi.fn(async () => Response.json({ id: 'add-trip', probability: 1, margin: 1 }));
		vi.stubGlobal('fetch', fetchMock);
		const body = await (await post({ text })).json();
		expect(fetchMock).toHaveBeenCalled(); // the text reached the model, not a parser route
		const expected = draftForAction('add-trip', text, 2);
		expect(expected.fields.amount).toBeDefined();
		expect(body).toMatchObject({ kind: 'action', actionId: 'add-trip' });
		expect(body.draft.fields.amount).toEqual(expected.fields.amount);
		vi.unstubAllGlobals();
	});
});

describe('POST /api/intent with a misconfigured allowlist', () => {
	it('never opens a never-auto-open id even if the allowlist lists it', async () => {
		vi.resetModules();
		vi.doMock('$lib/actions/auto-open', async () => {
			const actual = await vi.importActual<typeof import('$lib/actions/auto-open')>('$lib/actions/auto-open');
			const bad = { ...actual.AUTO_OPEN, allowed: [...actual.AUTO_OPEN.allowed, 'transfer-money'] };
			return { AUTO_OPEN: bad, shouldAutoOpen: (choice: never, config = bad) => actual.shouldAutoOpen(choice, config) };
		});
		try {
			const isolated = await import('./+server');
			vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'transfer-money', probability: 1, margin: 1 })));
			const response = await isolated.POST({
				request: new Request('http://localhost/api/intent', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ text: 'help me organise this' })
				}),
				locals: { userId: 1 }
			} as never);
			expect((await response.json()).kind).toBe('choices');
		} finally {
			vi.unstubAllGlobals();
			vi.doUnmock('$lib/actions/auto-open');
			vi.resetModules();
		}
	});
});
