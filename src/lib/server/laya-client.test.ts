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
});
