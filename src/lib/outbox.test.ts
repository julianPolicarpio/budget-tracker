/**
 * The offline outbox's pure logic (Spec §6, task A5).
 *
 * IndexedDB does not exist in Vitest's `node` environment (vite.config.ts's
 * one test project), and `fake-indexeddb` is not a dependency of this
 * project (checked `package.json` before writing this — task A5 says not to
 * add one if it is missing). So this exercises `outbox.ts` through the same
 * `OutboxStore` seam the real IndexedDB adapter implements, injected here as
 * a small in-memory adapter via `setStore()`. That seam is the module's own
 * design, not a test-only shortcut: `service-worker.ts` and the log form
 * both talk to `outbox.ts`'s exported functions, never to a store directly.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { clear, count, enqueue, flush, list, remove, setStore, type QueuedEntry } from './outbox';

/** A store, not a mock — real add/list/remove/clear semantics, just backed
 * by an array instead of IndexedDB. */
function memoryStore() {
	let rows: QueuedEntry[] = [];
	let nextId = 1;
	return {
		add: async (entry: Omit<QueuedEntry, 'id' | 'queuedAt'>) => {
			const row: QueuedEntry = { ...entry, id: nextId++, queuedAt: new Date().toISOString() };
			rows.push(row);
			return row;
		},
		list: async (userId: number) => rows.filter((r) => r.userId === userId),
		remove: async (id: number) => {
			rows = rows.filter((r) => r.id !== id);
		},
		clear: async (userId?: number) => {
			rows = userId === undefined ? [] : rows.filter((r) => r.userId !== userId);
		}
	};
}

let store: ReturnType<typeof memoryStore>;

beforeEach(() => {
	store = memoryStore();
	setStore(store);
});

const USER_A = 1;
const USER_B = 2;

function newEntry(userId: number, text: string, clientUuid: string) {
	return { userId, text, planned: '1' as const, clientUuid };
}

describe('enqueue / list / remove: the four required operations', () => {
	it('enqueue assigns an id and a queuedAt, and returns the shape Spec §6 wants', async () => {
		const row = await enqueue(newEntry(USER_A, 'kape 65', 'uuid-1'));
		expect(row).toMatchObject({
			userId: USER_A,
			text: 'kape 65',
			planned: '1',
			clientUuid: 'uuid-1'
		});
		expect(typeof row.id).toBe('number');
		expect(typeof row.queuedAt).toBe('string');
	});

	it('list only ever returns rows for the requested user', async () => {
		await enqueue(newEntry(USER_A, 'kape 65', 'uuid-1'));
		await enqueue(newEntry(USER_B, 'jeep 15', 'uuid-2'));

		expect(await list(USER_A)).toHaveLength(1);
		expect((await list(USER_A))[0].text).toBe('kape 65');
		expect(await list(USER_B)).toHaveLength(1);
	});

	it('remove deletes exactly the row asked for', async () => {
		const a = await enqueue(newEntry(USER_A, 'kape 65', 'uuid-1'));
		const b = await enqueue(newEntry(USER_A, 'jeep 15', 'uuid-2'));

		await remove(a.id);

		const remaining = await list(USER_A);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe(b.id);
	});
});

describe('flush: queued after a failed POST, gone after a successful one', () => {
	it('a failed POST leaves the entry queued', async () => {
		await enqueue(newEntry(USER_A, 'kape 65', 'uuid-1'));

		const result = await flush(USER_A, async () => false);

		expect(result).toEqual({ sent: 0, failed: 1 });
		expect(await list(USER_A)).toHaveLength(1);
	});

	it('a thrown POST (no network at all) also leaves the entry queued', async () => {
		await enqueue(newEntry(USER_A, 'kape 65', 'uuid-1'));

		const result = await flush(USER_A, async () => {
			throw new TypeError('Failed to fetch');
		});

		expect(result).toEqual({ sent: 0, failed: 1 });
		expect(await list(USER_A)).toHaveLength(1);
	});

	it('a successful POST removes the entry', async () => {
		await enqueue(newEntry(USER_A, 'kape 65', 'uuid-1'));

		const result = await flush(USER_A, async () => true);

		expect(result).toEqual({ sent: 1, failed: 0 });
		expect(await list(USER_A)).toHaveLength(0);
	});

	it('flushes oldest first and stops removing at the first failure point only for that row', async () => {
		await enqueue(newEntry(USER_A, 'first', 'uuid-1'));
		await enqueue(newEntry(USER_A, 'second', 'uuid-2'));
		await enqueue(newEntry(USER_A, 'third', 'uuid-3'));

		const seen: string[] = [];
		const result = await flush(USER_A, async (row) => {
			seen.push(row.text);
			return row.text !== 'second'; // the middle one fails, the others succeed
		});

		expect(seen).toEqual(['first', 'second', 'third']);
		expect(result).toEqual({ sent: 2, failed: 1 });
		const remaining = await list(USER_A);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].text).toBe('second');
	});

	it('replaying the same client_uuid fifty times through flush yields one delivered row — one-way replay, not sync', async () => {
		// Mirrors what a flaky reconnect actually does: the same queued row
		// gets POSTed more than once before a definitive success is seen. The
		// server's real defence is `txn.client_uuid UNIQUE` (Spec §6's "two
		// pieces that already exist and need no work"); this fakes that same
		// dedup rule to prove the outbox side plays along correctly rather
		// than fabricating fifty rows.
		const delivered = new Set<string>();
		const fakeServerPost = async (row: QueuedEntry) => {
			delivered.add(row.clientUuid); // a repeat is a no-op, same as the real server
			return true;
		};

		for (let i = 0; i < 50; i++) {
			// flush() removes the row on success, so re-enqueue the SAME
			// client_uuid each time to simulate "the ack never reached the
			// client" — the outbox cannot tell a lost ack apart from a lost
			// request, which is exactly why replay has to be safe in the
			// first place.
			await enqueue(newEntry(USER_A, 'kape 65', 'uuid-replay'));
			await flush(USER_A, fakeServerPost);
		}

		expect(delivered.size).toBe(1);
		expect(await list(USER_A)).toHaveLength(0);
	});
});

describe('namespacing: user 1 is invisible to, and never flushes as, user 2', () => {
	it('flush(userB) never sees or sends userA rows, even sitting in the same store', async () => {
		await enqueue(newEntry(USER_A, 'kape 65', 'uuid-1'));
		await enqueue(newEntry(USER_B, 'jeep 15', 'uuid-2'));

		const sentAs: number[] = [];
		const result = await flush(USER_B, async (row) => {
			sentAs.push(row.userId);
			return true;
		});

		expect(result).toEqual({ sent: 1, failed: 0 });
		expect(sentAs).toEqual([USER_B]);
		// User A's row is untouched — still queued, never offered to the post
		// function under user B's flush at all.
		expect(await list(USER_A)).toHaveLength(1);
	});

	it('count() never mixes tenants', async () => {
		await enqueue(newEntry(USER_A, 'kape 65', 'uuid-1'));
		await enqueue(newEntry(USER_A, 'jeep 15', 'uuid-2'));
		await enqueue(newEntry(USER_B, 'milk tea 90', 'uuid-3'));

		expect(await count(USER_A)).toBe(2);
		expect(await count(USER_B)).toBe(1);
	});
});

describe('sign-out clears the queue', () => {
	it('clear() with no argument wipes every tenant', async () => {
		await enqueue(newEntry(USER_A, 'kape 65', 'uuid-1'));
		await enqueue(newEntry(USER_B, 'jeep 15', 'uuid-2'));

		await clear();

		expect(await list(USER_A)).toHaveLength(0);
		expect(await list(USER_B)).toHaveLength(0);
	});

	it('clear(userId) only wipes that one tenant, leaving the other queue intact', async () => {
		await enqueue(newEntry(USER_A, 'kape 65', 'uuid-1'));
		await enqueue(newEntry(USER_B, 'jeep 15', 'uuid-2'));

		await clear(USER_A);

		expect(await list(USER_A)).toHaveLength(0);
		expect(await list(USER_B)).toHaveLength(1);
	});
});
