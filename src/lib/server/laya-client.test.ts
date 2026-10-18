import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyWithLaya } from './laya-client';

const OPTIONS = [
	{ id: 'record-income', description: 'Record income.' },
	{ id: 'add-bill-subscription', description: 'Add a bill or subscription.' }
];

afterEach(() => {
	delete process.env.LAYA_URL;
	vi.unstubAllGlobals();
});

describe('classifyWithLaya', () => {
	it('accepts only a finite in-shortlist choice with a finite margin', async () => {
		process.env.LAYA_URL = 'http://127.0.0.1:3010';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(JSON.stringify({ id: 'add-bill-subscription', probability: 0.91, margin: 0.42 }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)
		);

		expect(await classifyWithLaya('Netflix 549', OPTIONS)).toEqual({
			id: 'add-bill-subscription',
			probability: 0.91,
			margin: 0.42
		});
	});

	it.each([
		{ id: 'invent-an-action', probability: 0.9, margin: 0.5 },
		{ id: 'record-income', probability: Number.NaN, margin: 0.5 },
		{ id: 'record-income', probability: 0.9, margin: Number.POSITIVE_INFINITY },
		{ id: 'record-income', probability: 0.9, margin: -0.1 }
	])('rejects an invalid model reply %#', async (reply) => {
		process.env.LAYA_URL = 'http://127.0.0.1:3010';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(JSON.stringify(reply), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)
		);

		expect(await classifyWithLaya('private text', OPTIONS)).toBeNull();
	});

	it('treats a timeout or missing configuration as unavailable', async () => {
		expect(await classifyWithLaya('private text', OPTIONS)).toBeNull();

		process.env.LAYA_URL = 'http://127.0.0.1:3010';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new DOMException('Timed out', 'AbortError');
			})
		);
		expect(await classifyWithLaya('private text', OPTIONS)).toBeNull();
	});

	it('sends 16 options but refuses 17 without calling fetch', async () => {
		process.env.LAYA_URL = 'http://127.0.0.1:3010';
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ id: 'a0', probability: 0.9, margin: 0.5 }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const make = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, description: `Action ${i}.` }));

		expect(await classifyWithLaya('some text', make(16))).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		fetchMock.mockClear();
		expect(await classifyWithLaya('some text', make(17))).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reaches the host sidecar by host.docker.internal but refuses an external host', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ id: 'record-income', probability: 0.9, margin: 0.5 }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		process.env.LAYA_URL = 'http://host.docker.internal:3010';
		expect(await classifyWithLaya('some text', OPTIONS)).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String((fetchMock.mock.calls as unknown[][])[0][0])).toContain('host.docker.internal:3010');

		fetchMock.mockClear();
		process.env.LAYA_URL = 'http://example.com:3010';
		expect(await classifyWithLaya('some text', OPTIONS)).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('never follows a redirect, so typed text cannot be resent to another host', async () => {
		process.env.LAYA_URL = 'http://127.0.0.1:3010';
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ id: 'record-income', probability: 0.9, margin: 0.5 }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		await classifyWithLaya('some text', OPTIONS);
		expect((fetchMock.mock.calls as unknown[][])[0][1]).toMatchObject({ redirect: 'error' });
	});
});
