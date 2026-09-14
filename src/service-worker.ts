/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

/**
 * The offline app shell (Spec §6, task A5).
 *
 * *"the web is not loading fast enough and the data signal in the
 * philippines is not reliable"* — this file exists so opening the app is
 * never blocked on a live signal. It does NOT make logging work offline by
 * itself: `src/lib/outbox.ts` (IndexedDB) is what makes a save survive zero
 * bars, and `client_uuid`'s UNIQUE constraint plus `+page.server.ts`'s
 * existing "a repeat is a double-submit" handling are what make replaying a
 * queued row safe. This file's whole job is narrower: get the SHELL on
 * screen instantly, whether the network answers or not.
 *
 * Excluded from `npm run check` on purpose — see `.svelte-kit/tsconfig.json`,
 * which lists `src/service-worker.ts` under `exclude`. A service worker's
 * globals (`ServiceWorkerGlobalScope`, `caches`, …) are not the DOM globals
 * the rest of this app is checked against, and SvelteKit's own scaffolding
 * keeps the two apart rather than trying to reconcile one `lib` array for
 * both. `npm run build` still compiles this file (esbuild strips types
 * without verifying them); it is written to be correct on its own,
 * `webworker`-lib terms.
 */

import { build, files, version } from '$service-worker';
import { flush } from '$lib/outbox';

const sw = self as unknown as ServiceWorkerGlobalScope;

// Bump-safe (task A5: "a new version must not serve a stale shell"). The
// cache name is keyed to SvelteKit's own per-build `version`, so a fresh
// deploy opens a brand new cache under a new name; `activate` below deletes
// every cache that is not this one. There is never a moment where a cache
// full of a previous build's hashed asset URLs is mistaken for the current
// build's shell.
const CACHE = `split-shell-${version}`;

// The app shell: the hydration bundle (`build`) plus everything under
// `static/` (`files`) — icons, `manifest.webmanifest`, fonts. Precached on
// install so the very first offline load already has something to render
// from, not just later visits that happened to warm the cache.
const ASSETS = [...build, ...files];

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(ASSETS);
			// Take over immediately. A version bump that waits for every open
			// tab to close before it activates is a version bump that cannot
			// fix the very staleness bug it might have shipped to fix.
			await sw.skipWaiting();
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== CACHE) await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

/**
 * Requests this worker must never intercept or cache. `/auth/*` is the
 * Google OAuth round trip — a cached redirect there could resurrect a stale
 * `state` token. `/api/health` exists specifically so something OUTSIDE this
 * app can ask "is the real server answering right now"; a cached 200 would
 * make that check permanently lie.
 */
function isExempt(pathname: string): boolean {
	return pathname.startsWith('/auth/') || pathname === '/api/health';
}

sw.addEventListener('fetch', (event) => {
	// Never cache a write. A cached POST would mean replaying whatever body
	// happened to be captured at cache time — the entire class of bug
	// `client_uuid` exists to make harmless one layer down, except this one
	// would not even carry a client_uuid the server could dedupe against, it
	// would just be a stale response object. GET only, full stop.
	if (event.request.method !== 'GET') return;

	const url = new URL(event.request.url);
	if (url.origin !== location.origin || isExempt(url.pathname)) return;

	event.respondWith(respond(event.request, url));
});

async function respond(request: Request, url: URL): Promise<Response> {
	const cache = await caches.open(CACHE);

	// Static assets: cache-first. A hashed build file, or a file under
	// static/, never changes under its own URL — there is nothing to gain by
	// asking the network for it before the cache.
	if (ASSETS.includes(url.pathname)) {
		const cached = await cache.match(url.pathname);
		if (cached) return cached;
	}

	// Everything else, navigations included: network-first, with the cache
	// as the fallback that lets a dead signal still open Today instantly
	// (Spec §6's whole point). Every successful GET is opportunistically
	// cached as it comes back, so the fallback is always whatever page was
	// last actually seen — not a fixed shell frozen at build time.
	try {
		const response = await fetch(request);
		if (response.status === 200) cache.put(request, response.clone());
		return response;
	} catch (err) {
		const cached = await cache.match(request);
		if (cached) return cached;
		// Nothing live and nothing cached — a genuine failure, not something
		// to paper over with a fabricated response.
		throw err;
	}
}

// ─── Background Sync (task A5 item 4) ───────────────────────────────────
//
// Best-effort only. `online` and app-open flush (`src/routes/+page.svelte`)
// are the mechanisms this app actually depends on; this handler exists for
// the case where the tab is backgrounded right as the signal returns. iOS
// Safari fires no `sync` event at all — `SyncManager` does not exist there —
// so on iPhone the queue simply waits for the app to be opened again. That
// asymmetry is accepted by Spec §6 explicitly: do not "fix" it by polling
// from here on a timer, which is exactly the battery-draining workaround
// this design rejects.
//
// This worker has no notion of "who is signed in" on its own — that lives in
// session cookies the page holds, not in anything visible to a service
// worker. `tellServiceWorkerCurrentUser()` in outbox.ts pings the current
// user id over on every page load; if this worker was restarted since the
// last ping (entirely possible — workers are killed and revived by the
// browser at will), `flushUserId` is `null` and this handler is a no-op for
// that one reconnect. The two guaranteed flush triggers do not have this gap.
let flushUserId: number | null = null;

sw.addEventListener('message', (event: ExtendableMessageEvent) => {
	const data = event.data as { type?: string; userId?: number } | undefined;
	if (data?.type === 'split-outbox-user') {
		flushUserId = typeof data.userId === 'number' ? data.userId : null;
	}
});

// `SyncEvent` / the `sync` event are Background Sync API additions not every
// TS lib version ships; typed loosely here rather than widening `lib` for
// the whole file (this file is excluded from `npm run check` regardless —
// see the module doc above).
sw.addEventListener('sync', ((event: { tag: string; waitUntil(p: Promise<unknown>): void }) => {
	if (event.tag !== 'split-outbox-flush' || flushUserId === null) return;
	event.waitUntil(flush(flushUserId));
}) as EventListener);
