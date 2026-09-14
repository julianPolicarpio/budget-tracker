/**
 * The offline outbox (Spec §6, task A5).
 *
 * *"im on my phone and i need it to log fast but the web is not loading fast
 * enough and the data signal in the philippines is not reliable"* — an
 * always-on server does not fix a dead connection. So the save path never
 * waits on one: `enqueue()` writes to IndexedDB, which works with zero bars,
 * and the caller clears its field the moment that promise is issued — see
 * `offlineLogSubmit()` in `log-entry.svelte.ts`, the one place this module
 * is wired into the log form.
 *
 * ─── One-way replay, not sync ──────────────────────────────────────────────
 *
 * Only this device ever creates the rows in this outbox, and only THIS
 * user's own account ever receives them. There is no merge, no conflict, and
 * no "last write wins" to get right, because there is never more than one
 * writer for a given row. `flush()` is allowed to POST the same row twice
 * (a flaky reconnect can do exactly that) because `txn.client_uuid UNIQUE`
 * plus `+page.server.ts`'s existing "a repeat is a double-submit, not an
 * error" handling already make replay a no-op server-side (Spec §6's two
 * pieces that "already exist and need no work"). Anyone tempted to add
 * version vectors, tombstones, or a merge step here is solving a problem
 * this design does not have.
 *
 * ─── Namespacing (Spec §3's leak, offline edition) ─────────────────────────
 *
 * A queued entry replaying into the wrong tenant after an account switch on
 * a shared device is the offline version of the leak §3 exists to prevent —
 * a security property, not housekeeping. Two independent layers enforce it:
 *
 *   1. Every row carries the `userId` it was queued under, and `list()` /
 *      `flush()` both filter on it — a call scoped to user 2 physically
 *      cannot see or send user 1's rows, even if both happen to be sitting
 *      in the store at once.
 *   2. `clear()` with no argument wipes the entire store, called from
 *      `src/routes/signin/+page.svelte` on every mount — the one screen a
 *      signed-out browser always lands on, whether it got there by an
 *      explicit sign-out or an expired session. That is what keeps layer 1
 *      from ever actually being asked to referee two tenants at once.
 *
 * ─── Why no `fake-indexeddb` ────────────────────────────────────────────────
 *
 * It is not a dependency of this project (checked `package.json` before
 * writing this), and task A5 says not to add one. So the store this module
 * talks to is an injectable `OutboxStore` — `IndexedDbStore` below is the
 * real one; `outbox.test.ts` injects a small in-memory adapter instead of
 * touching IndexedDB (which does not exist in the Vitest `node` environment
 * this project's one test project runs under) via `setStore()`.
 */

export type PlannedFlag = '' | '0' | '1';
export type CommitmentModeFlag = '' | 'same' | 'same_essential' | 'varies';

/** The queue shape task A5 specifies, plus the handful of extra fields the
 * SAME log form already sends for the richer `new_commitment` /
 * freshly-taught-word cases (Spec §5.6-§5.9) — optional, and blank for the
 * overwhelmingly common plain-transaction case, so they never change the
 * shape of a normal queued row. */
export interface QueuedEntry {
	id: number;
	userId: number;
	text: string;
	planned: PlannedFlag;
	clientUuid: string;
	queuedAt: string;
	commitmentMode?: CommitmentModeFlag;
	taughtWord?: string;
	taughtEnglish?: string;
	taughtRoot?: string;
	/**
	 * Why the last send attempt was refused, and how many times.
	 *
	 * A queue that only counts is a queue that hides a permanent failure. An
	 * entry the server rejects for a reason that will not change — a wrong
	 * origin, a word that needs an answer — can never drain, and without this
	 * the only symptom is a number that never goes down while the app looks
	 * like it is working. Observed exactly that way: two entries sat refused
	 * for a day.
	 */
	lastError?: string;
	attempts?: number;
}

export type NewQueuedEntry = Omit<QueuedEntry, 'id' | 'queuedAt' | 'lastError' | 'attempts'>;

/** The swappable seam. `IndexedDbStore` is the only implementation shipped
 * here; tests inject their own. */
export interface OutboxStore {
	add(entry: NewQueuedEntry): Promise<QueuedEntry>;
	list(userId: number): Promise<QueuedEntry[]>;
	remove(id: number): Promise<void>;
	/** Record why a send was refused, so the queue can say so. */
	markFailed?(id: number, error: string): Promise<void>;
	/** Clears one user's rows, or every row when `userId` is omitted (used by
	 * sign-out, which does not get to assume it still knows who was signed
	 * in). */
	clear(userId?: number): Promise<void>;
}

// ─── The real store ─────────────────────────────────────────────────────

const DB_NAME = 'split-outbox';
const DB_VERSION = 1;
const STORE_NAME = 'queue';
const USER_INDEX = 'by_user';

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
				store.createIndex(USER_INDEX, 'userId');
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/**
 * Raw IndexedDB, no dependency (task A5's requirement). Every method opens
 * its own connection rather than caching one across calls: this file is
 * imported from both the page and `service-worker.ts`, which are different
 * globals with different lifetimes, and a shared handle across the two
 * would outlive whichever one closes first for no benefit — these are small,
 * infrequent, personal-scale operations, not a hot path worth pooling.
 */
class IndexedDbStore implements OutboxStore {
	async add(entry: NewQueuedEntry): Promise<QueuedEntry> {
		const db = await openDb();
		return new Promise((resolve, reject) => {
			const row = { ...entry, queuedAt: new Date().toISOString() };
			const tx = db.transaction(STORE_NAME, 'readwrite');
			const req = tx.objectStore(STORE_NAME).add(row);
			req.onsuccess = () => resolve({ ...row, id: req.result as number });
			req.onerror = () => reject(req.error);
		});
	}

	async list(userId: number): Promise<QueuedEntry[]> {
		const db = await openDb();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readonly');
			const req = tx.objectStore(STORE_NAME).index(USER_INDEX).getAll(IDBKeyRange.only(userId));
			req.onsuccess = () => resolve(req.result as QueuedEntry[]);
			req.onerror = () => reject(req.error);
		});
	}

	async remove(id: number): Promise<void> {
		const db = await openDb();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			tx.objectStore(STORE_NAME).delete(id);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	async markFailed(id: number, error: string): Promise<void> {
		const db = await openDb();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			const os = tx.objectStore(STORE_NAME);
			const get = os.get(id);
			get.onsuccess = () => {
				const row = get.result as QueuedEntry | undefined;
				if (row) {
					row.lastError = error;
					row.attempts = (row.attempts ?? 0) + 1;
					os.put(row);
				}
			};
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	async clear(userId?: number): Promise<void> {
		const db = await openDb();
		if (userId === undefined) {
			return new Promise((resolve, reject) => {
				const tx = db.transaction(STORE_NAME, 'readwrite');
				tx.objectStore(STORE_NAME).clear();
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		}
		const rows = await this.list(userId);
		if (rows.length === 0) return;
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			const store = tx.objectStore(STORE_NAME);
			for (const row of rows) store.delete(row.id);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}
}

// `new IndexedDbStore()` touches no browser global itself — every access to
// `indexedDB` is inside a method body, called lazily. That is what makes it
// safe to construct at module load time even under Vitest's `node`
// environment, where `indexedDB` does not exist, as long as nothing actually
// calls a method without first swapping in a test store via `setStore()`.
let store: OutboxStore = new IndexedDbStore();

/** The injection seam `outbox.test.ts` uses instead of `fake-indexeddb`. */
export function setStore(s: OutboxStore): void {
	store = s;
}

// ─── The four required operations ──────────────────────────────────────

export function enqueue(entry: NewQueuedEntry): Promise<QueuedEntry> {
	return store.add(entry);
}

export function list(userId: number): Promise<QueuedEntry[]> {
	return store.list(userId);
}

export function remove(id: number): Promise<void> {
	return store.remove(id);
}

/** Record why a send was refused. No-ops on a store that does not support it. */
export function markFailed(id: number, error: string): Promise<void> {
	return store.markFailed?.(id, error) ?? Promise.resolve();
}

export interface FlushResult {
	sent: number;
	failed: number;
}

/**
 * POST every queued row belonging to `userId`, oldest first, removing each
 * one the moment its POST succeeds. A row that fails — no signal, or the
 * server genuinely rejects it — is left in place for the next flush to
 * retry; nothing here decides a row is undeliverable and drops it. Replay is
 * safe by construction (see this module's doc comment), so retrying a row
 * that actually made it through on a prior, uncertain attempt costs nothing.
 */
export async function flush(
	userId: number,
	post: (entry: QueuedEntry) => Promise<boolean> = postToServer
): Promise<FlushResult> {
	const rows = [...(await list(userId))].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
	let sent = 0;
	let failed = 0;
	for (const row of rows) {
		let ok: boolean;
		try {
			ok = await post(row);
		} catch {
			ok = false;
		}
		if (ok) {
			await remove(row.id);
			sent++;
		} else {
			failed++;
		}
	}
	return { sent, failed };
}

/** Clears one user's rows, or the whole store when `userId` is omitted. */
export function clear(userId?: number): Promise<void> {
	return store.clear(userId);
}

/** Called from `src/routes/signin/+page.svelte` on mount (Spec §6's "cleared
 * on sign-out"). Named separately from `clear()` for readability at the call
 * site — it always means "wipe everything", never one user. */
export function clearAll(): Promise<void> {
	return store.clear();
}

export async function count(userId: number): Promise<number> {
	return (await list(userId)).length;
}

// ─── The real POST, and the real reconnect triggers ────────────────────

/**
 * The same wire format `use:enhance` uses for a `?/logEntry` submission
 * (`node_modules/@sveltejs/kit/src/runtime/app/forms.js`), replicated by
 * hand because this runs with no page and no `enhance` around to do it: a
 * plain `URLSearchParams` body, the two headers that tell SvelteKit this is
 * an action call rather than a full-page POST, and `credentials:
 * 'same-origin'` so the session cookie identifying the user goes along with
 * it — the same cookie the browser already carries, whether this runs in
 * the tab or in `service-worker.ts`.
 */
async function postToServer(entry: QueuedEntry): Promise<boolean> {
	const body = new URLSearchParams();
	body.set('text', entry.text);
	body.set('clientUuid', entry.clientUuid);
	body.set('planned', entry.planned);
	body.set('commitmentMode', entry.commitmentMode ?? '');
	body.set('taughtWord', entry.taughtWord ?? '');
	body.set('taughtEnglish', entry.taughtEnglish ?? '');
	body.set('taughtRoot', entry.taughtRoot ?? '');

	const res = await fetch('/?/logEntry', {
		method: 'POST',
		credentials: 'same-origin',
		headers: {
			accept: 'application/json',
			'x-sveltekit-action': 'true',
			'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'
		},
		body
	});
	// Anything short of 2xx is left queued for the next attempt (see flush()'s
	// doc comment) — including a validation failure, since resolving that
	// needs the user's own eyes, not a retry loop.
	return res.ok;
}

const SYNC_TAG = 'split-outbox-flush';

/**
 * Background Sync registration (task A5 item 4) — best effort only, and
 * deliberately so. `online` and app-open flush (wired in
 * `src/routes/+page.svelte`) are the mechanisms this app actually depends
 * on; this is a bonus for the case where the tab is backgrounded right as
 * the signal returns. iOS Safari has no `SyncManager` at all — there this
 * silently does nothing, and the queue simply waits for the app to be
 * opened again. That asymmetry is accepted, not a bug to route around with
 * a polling loop (Spec §6 says so explicitly).
 */
export async function registerBackgroundSync(): Promise<void> {
	try {
		if (!('serviceWorker' in navigator)) return;
		const reg = await navigator.serviceWorker.ready;
		// `SyncManager` is not in every browser's lib.dom typings (Background
		// Sync has no support on iOS Safari at all — see this function's own
		// doc comment), so the feature test is also the type escape hatch.
		const withSync = reg as ServiceWorkerRegistration & {
			sync?: { register(tag: string): Promise<void> };
		};
		await withSync.sync?.register(SYNC_TAG);
	} catch {
		// No Background Sync support, or no service worker yet — fine.
	}
}

/**
 * Tells an already-controlling service worker which user is live, so its
 * best-effort `sync` handler never sends a row under the wrong session (see
 * `service-worker.ts`). Re-sent on every page load, since the worker may
 * have been restarted and forgotten between visits.
 */
export function tellServiceWorkerCurrentUser(userId: number): void {
	navigator.serviceWorker?.controller?.postMessage({ type: 'split-outbox-user', userId });
}
