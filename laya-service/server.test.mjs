import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createLayaService, listenHost } from './server.mjs';

const OPTIONS = [
	{ id: 'record-income', description: 'Record money received, such as salary or a refund.' },
	{ id: 'add-bill-subscription', description: 'Add a recurring bill or subscription.' }
];

async function withService(serviceOptions, run) {
	const server = createLayaService(serviceOptions);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const { port } = server.address();

	try {
		await run(`http://127.0.0.1:${port}`);
	} finally {
		server.close();
		await once(server, 'close');
	}
}

async function request(baseUrl, path, body) {
	const response = await fetch(`${baseUrl}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: body === undefined ? undefined : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { status: response.status, body: await response.json() };
}

test('classifies valid text with an injected model and returns only a validated choice', async () => {
	await withService(
		{
			classify: async () => ({ id: 'add-bill-subscription', probability: 0.91, margin: 0.42 }),
			getStatus: () => 'ready'
		},
		async (baseUrl) => {
			const result = await request(baseUrl, '/classify', { text: 'Netflix subscription 549', options: OPTIONS });
			assert.equal(result.status, 200);
			assert.deepEqual(result.body, {
				id: 'add-bill-subscription',
				probability: 0.91,
				margin: 0.42
			});
		}
	);
});

test('rejects an empty, oversized, or wrongly sized option list before classification', async () => {
	let calls = 0;
	await withService(
		{
			classify: async () => {
				calls += 1;
				return { id: 'record-income', probability: 0.9, margin: 0.4 };
			},
			getStatus: () => 'ready'
		},
		async (baseUrl) => {
			for (const body of [
				{ text: '', options: OPTIONS },
				{ text: 'x'.repeat(1001), options: OPTIONS },
				{ text: 'salary', options: [] },
				{ text: 'salary', options: Array.from({ length: 9 }, (_, index) => ({ id: index ? 'record-income' : 'add-bill-subscription', description: 'Income' })) }
			]) {
				const result = await request(baseUrl, '/classify', body);
				assert.equal(result.status, 400);
				assert.equal(typeof result.body.error, 'string');
			}
			assert.equal(calls, 0);
		}
	);
});

test('rejects duplicate and unknown action IDs before classification', async () => {
	let calls = 0;
	await withService(
		{
			classify: async () => {
				calls += 1;
				return { id: 'record-income', probability: 0.9, margin: 0.4 };
			},
			getStatus: () => 'ready'
		},
		async (baseUrl) => {
			for (const options of [
				[OPTIONS[0], OPTIONS[0]],
				[{ id: 'invent-an-action', description: 'Not in Longhand.' }]
			]) {
				const result = await request(baseUrl, '/classify', { text: 'help', options });
				assert.equal(result.status, 400);
			}
			assert.equal(calls, 0);
		}
	);
});

test('rejects malformed model replies and never writes request text to logs', async () => {
	const logs = [];
	const secretText = 'private entry: Maya balance 12345';
	await withService(
		{
			classify: async () => ({ id: 'invent-an-action', probability: Number.NaN, margin: 0.2 }),
			getStatus: () => 'ready',
			logger: { error: (message) => logs.push(message) }
		},
		async (baseUrl) => {
			const result = await request(baseUrl, '/classify', { text: secretText, options: OPTIONS });
			assert.equal(result.status, 502);
			assert.deepEqual(result.body, { error: 'Model returned an invalid choice.' });
			assert.equal(logs.join('\n').includes(secretText), false);
		}
	);
});

test('reports loading, ready, and unavailable without accepting a classification while unavailable', async () => {
	for (const status of ['loading', 'ready', 'unavailable']) {
		await withService(
			{
				classify: async () => ({ id: 'record-income', probability: 0.9, margin: 0.4 }),
				getStatus: () => status
			},
			async (baseUrl) => {
				const health = await request(baseUrl, '/health');
				assert.deepEqual(health.body, { status });
				if (status !== 'ready') {
					const classify = await request(baseUrl, '/classify', { text: 'salary', options: OPTIONS });
					assert.equal(classify.status, 503);
				}
			}
		);
	}
});

test('binds to loopback unless HOST says otherwise', () => {
	assert.equal(listenHost({}), '127.0.0.1');
	assert.equal(listenHost({ HOST: '  ' }), '127.0.0.1');
	assert.equal(listenHost({ HOST: '0.0.0.0' }), '0.0.0.0');
});

test('rejects an option that is not a Split action, naming Split', async () => {
	await withService(
		{ classify: async () => ({ id: 'x', probability: 1, margin: 1 }), getStatus: () => 'ready' },
		async (baseUrl) => {
			const result = await request(baseUrl, '/classify', {
				text: 'hello',
				options: [{ id: 'not-an-action', description: 'x' }]
			});
			assert.equal(result.status, 400);
			assert.equal(result.body.error, 'Option id is not a Split action.');
		}
	);
});
