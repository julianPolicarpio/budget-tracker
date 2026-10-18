import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createLayaService, listenHost, startKeepWarm } from './server.mjs';

const OPTIONS = [
	{ id: 'record-income', description: 'Record money received, such as salary or a refund.' },
	{ id: 'add-bill-subscription', description: 'Add a recurring bill or subscription.' }
];

// Every action id the service knows, 17 in all (16 plus `unclear`).
const ALL_IDS = [
	'log-spending', 'record-income', 'transfer-money', 'record-payment', 'record-refund',
	'fund-planned-expense', 'move-between-purposes', 'add-trip', 'create-planned-expense',
	'add-bill-subscription', 'add-debt', 'save-for-later', 'add-account', 'set-budget',
	'update-balance', 'add-edit-rule', 'unclear'
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
				{ text: 'salary', options: ALL_IDS.slice(0, 17).map((id) => ({ id, description: 'Income' })) }
			]) {
				const result = await request(baseUrl, '/classify', body);
				assert.equal(result.status, 400);
				assert.equal(typeof result.body.error, 'string');
			}
			assert.equal(calls, 0);
		}
	);
});

test('accepts 16 options and rejects 17', async () => {
	await withService(
		{
			classify: async () => ({ id: 'record-income', probability: 0.9, margin: 0.4 }),
			getStatus: () => 'ready'
		},
		async (baseUrl) => {
			const make = (n) => ALL_IDS.slice(0, n).map((id) => ({ id, description: 'An action.' }));
			assert.equal((await request(baseUrl, '/classify', { text: 'salary', options: make(16) })).status, 200);
			assert.equal((await request(baseUrl, '/classify', { text: 'salary', options: make(17) })).status, 400);
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
				[{ id: 'invent-an-action', description: 'Not in Split.' }]
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

function fakeTimers() {
	const state = { callback: null, ms: null, cleared: false, unrefCalled: false };
	const handle = { unref() { state.unrefCalled = true; } };
	state.setIntervalFn = (callback, ms) => {
		state.callback = callback;
		state.ms = ms;
		return handle;
	};
	state.clearIntervalFn = (given) => {
		if (given === handle) state.cleared = true;
	};
	return state;
}

const silentLogger = () => {
	const lines = [];
	return { lines, error: (...args) => lines.push(args.join(' ')), log: (...args) => lines.push(args.join(' ')) };
};

test('keep-warm calls classify with 16 options that exclude log-spending', async () => {
	const timers = fakeTimers();
	const calls = [];
	startKeepWarm({
		classify: async (text, options) => {
			calls.push({ text, options });
			return { id: 'unclear', probability: 1, margin: 1 };
		},
		intervalMs: 1000,
		setIntervalFn: timers.setIntervalFn,
		clearIntervalFn: timers.clearIntervalFn,
		logger: silentLogger()
	});
	assert.equal(timers.ms, 1000);
	assert.equal(timers.unrefCalled, true);
	await timers.callback();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].text, 'keep warm');
	assert.equal(calls[0].options.length, 16);
	const ids = calls[0].options.map((option) => option.id);
	assert.equal(ids.includes('log-spending'), false);
	assert.deepEqual(new Set(ids), new Set(ALL_IDS.filter((id) => id !== 'log-spending')));
	for (const option of calls[0].options) assert.equal(option.description, option.id);
});

test('keep-warm skips a tick while the previous call is pending', async () => {
	const timers = fakeTimers();
	let calls = 0;
	let release;
	startKeepWarm({
		classify: () => {
			calls += 1;
			return new Promise((resolve) => {
				release = resolve;
			});
		},
		intervalMs: 1000,
		setIntervalFn: timers.setIntervalFn,
		clearIntervalFn: timers.clearIntervalFn,
		logger: silentLogger()
	});
	const first = timers.callback();
	await timers.callback();
	assert.equal(calls, 1);
	release({ id: 'unclear', probability: 1, margin: 1 });
	await first;
	const second = timers.callback();
	assert.equal(calls, 2);
	release({ id: 'unclear', probability: 1, margin: 1 });
	await second;
});

test('keep-warm catches and logs a rejecting classify without the text', async () => {
	const timers = fakeTimers();
	const logger = silentLogger();
	startKeepWarm({
		classify: async () => {
			throw new Error('boom keep warm');
		},
		intervalMs: 1000,
		setIntervalFn: timers.setIntervalFn,
		clearIntervalFn: timers.clearIntervalFn,
		logger
	});
	await timers.callback();
	assert.equal(logger.lines.length, 1);
	assert.equal(logger.lines[0].includes('boom'), false);
	assert.equal(logger.lines[0].includes('keep warm'), false);
	await timers.callback();
	assert.equal(logger.lines.length, 2);
});

test('keep-warm is disabled when intervalMs is 0 or less', () => {
	const timers = fakeTimers();
	for (const intervalMs of [0, -5]) {
		const stop = startKeepWarm({
			classify: async () => ({}),
			intervalMs,
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
			logger: silentLogger()
		});
		assert.equal(typeof stop, 'function');
		stop();
	}
	assert.equal(timers.callback, null);
});

test('keep-warm stop clears the timer', () => {
	const timers = fakeTimers();
	const stop = startKeepWarm({
		classify: async () => ({}),
		intervalMs: 1000,
		setIntervalFn: timers.setIntervalFn,
		clearIntervalFn: timers.clearIntervalFn,
		logger: silentLogger()
	});
	assert.equal(timers.cleared, false);
	stop();
	assert.equal(timers.cleared, true);
});
