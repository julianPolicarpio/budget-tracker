import { createServer } from 'node:http';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const READY_MARKERS = ['.split-laya-ready', '.longhand-laya-ready'];
const MODEL_INSTRUCTION = 'Which Split action is requested?';
const MAX_TEXT_LENGTH = 1_000;
const MAX_OPTIONS = 8;
const MAX_BODY_BYTES = 20_000;
const ACTION_IDS = new Set([
	'log-spending',
	'record-income',
	'transfer-money',
	'record-payment',
	'record-refund',
	'fund-planned-expense',
	'move-between-purposes',
	'add-trip',
	'create-planned-expense',
	'add-bill-subscription',
	'add-debt',
	'save-for-later',
	'add-account',
	'set-budget',
	'update-balance',
	'add-edit-rule',
	'unclear'
]);

/** Loopback by default: on a bare Mac the sidecar must not be reachable from the LAN. */
export function listenHost(env) {
	return env.HOST?.trim() || '127.0.0.1';
}

function sendJson(response, status, body) {
	response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	response.end(JSON.stringify(body));
}

async function readJson(request) {
	let size = 0;
	const chunks = [];
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.');
		chunks.push(chunk);
	}

	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new Error('Request body must be valid JSON.');
	}
}

function validateRequest(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Request body must be an object.';
	if (typeof value.text !== 'string' || value.text.trim().length === 0) return 'Text is required.';
	if (value.text.length > MAX_TEXT_LENGTH) return `Text must be ${MAX_TEXT_LENGTH} characters or fewer.`;
	if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > MAX_OPTIONS) {
		return `Options must contain between 1 and ${MAX_OPTIONS} choices.`;
	}

	const ids = new Set();
	for (const option of value.options) {
		if (!option || typeof option !== 'object' || typeof option.id !== 'string' || typeof option.description !== 'string') {
			return 'Each option needs an id and description.';
		}
		if (!ACTION_IDS.has(option.id)) return 'Option id is not a Split action.';
		if (ids.has(option.id)) return 'Option ids must be unique.';
		if (option.description.trim().length === 0 || option.description.length > 1_000) {
			return 'Option descriptions must contain at most 1000 characters.';
		}
		ids.add(option.id);
	}

	return null;
}

function validateAnswer(answer, options) {
	if (!answer || typeof answer !== 'object') return null;
	if (!options.some((option) => option.id === answer.id)) return null;
	if (!Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) return null;
	if (!Number.isFinite(answer.margin) || answer.margin < 0 || answer.margin > 1) return null;
	return { id: answer.id, probability: answer.probability, margin: answer.margin };
}

/**
 * Creates the HTTP boundary separately from model loading so contract tests do
 * not download model weights. The injected classifier receives only text and
 * fixed action choices; it never sees budget data.
 */
export function createLayaService({ classify, getStatus, logger = console }) {
	return createServer(async (request, response) => {
		if (request.method === 'GET' && request.url === '/health') {
			return sendJson(response, 200, { status: getStatus() });
		}
		if (request.method !== 'POST' || request.url !== '/classify') {
			return sendJson(response, 404, { error: 'Not found.' });
		}
		if (getStatus() !== 'ready') {
			return sendJson(response, 503, { error: 'Model is unavailable.' });
		}

		let input;
		try {
			input = await readJson(request);
		} catch (error) {
			return sendJson(response, 400, { error: error.message });
		}
		const inputError = validateRequest(input);
		if (inputError) return sendJson(response, 400, { error: inputError });

		try {
			const answer = validateAnswer(await classify(input.text, input.options), input.options);
			if (!answer) {
				logger.error('Laya returned an invalid classify response.');
				return sendJson(response, 502, { error: 'Model returned an invalid choice.' });
			}
			return sendJson(response, 200, answer);
		} catch {
			logger.error('Laya classification failed.');
			return sendJson(response, 503, { error: 'Model is unavailable.' });
		}
	});
}

async function loadClassifier() {
	const cacheDir = process.env.LAYA_CACHE ?? '/models';
	if (process.env.LAYA_ALLOW_DOWNLOAD !== '1') {
		const found = await Promise.any(READY_MARKERS.map((m) => access(join(cacheDir, m)))).then(
			() => true,
			() => false
		);
		if (!found) throw new Error('Laya model cache has not been prefetched.');
	}

	const { Laya } = await import('@receptron/laya');
	const laya = await Laya.load({
		revision: '68f27dfe5a27a54fb2b1fefc432f43f972e90868',
		cacheDir,
		executionProviders: ['cpu']
	});
	await writeFile(join(cacheDir, READY_MARKERS[0]), 'Loaded successfully.\n');
	return async (text, options) => {
		const result = await laya.systemOne(
			{ text },
			{
				action: {
					type: 'choice',
					instructions: MODEL_INSTRUCTION,
					criteria: Object.fromEntries(options.map((option) => [option.id, option.description]))
				}
			}
		);
		const choice = result.answers.action;
		const probabilities = Object.values(choice.probabilities).filter(Number.isFinite).sort((a, b) => b - a);
		return {
			id: choice.choice,
			probability: choice.probabilities[choice.choice],
			margin: (probabilities[0] ?? 0) - (probabilities[1] ?? 0)
		};
	};
}

if (import.meta.main) {
	if (process.env.LAYA_PREFETCH_ONLY === '1') {
		loadClassifier()
			.then(() => {
				console.log('Laya model cache is ready.');
				process.exit(0);
			})
			.catch(() => {
				console.error('Laya model cache could not be prepared.');
				process.exit(1);
			});
	} else {
		let status = 'loading';
		let classify = async () => {
			throw new Error('Model is loading.');
		};
		const server = createLayaService({ classify: (...args) => classify(...args), getStatus: () => status });
		server.listen(Number(process.env.PORT ?? 3010), listenHost(process.env));
		loadClassifier()
			.then((loadedClassifier) => {
				classify = loadedClassifier;
				status = 'ready';
				console.log('Laya model is ready.');
			})
			.catch(() => {
				status = 'unavailable';
				console.error('Laya model could not be loaded.');
			});
	}
}
