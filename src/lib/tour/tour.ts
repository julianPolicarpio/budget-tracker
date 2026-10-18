/**
 * The demo's guided tour: a thin driver.js shell around `flow.ts`.
 *
 * Client only. driver.js is imported dynamically so SSR never loads it. All
 * decisions (which step is next, when to start) live in `flow.ts`; this file
 * only reads and writes storage, finds elements and draws popovers.
 *
 * Pages talk to the tour through `window` events:
 *   - `split:tour` { detail: { type } }   a page reports real progress
 *   - `split:tour-show` { detail: { target } }   the tour tells a page which
 *     anchor it is about to point at (desktop uses this to open the entry bar)
 */
import { advance, parseStoredStep, shouldAutoStart, stepShowsOn, type TourSignal } from './flow';
import { TOUR_STEPS, type TourStep } from './steps';

const STEP_KEY = 'split_tour_step';
const DONE_KEY = 'split_tour_done';
/** How long a missing anchor is waited for before the unanchored popover. */
const ANCHOR_WAIT_MS = 1500;
const POLL_MS = 100;

type DriverInstance = { highlight: (step: object) => void; destroy: () => void };

let active = false;
let index = 0;
let driverObj: DriverInstance | null = null;
let driverFactory: ((config: object) => DriverInstance) | null = null;
let showToken = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let fallbackShown = false;
let currentPath = '/';

// ── storage (every access guarded: private mode and blocked storage throw) ──

function readStep(): number {
	try {
		return parseStoredStep(sessionStorage.getItem(STEP_KEY), TOUR_STEPS.length);
	} catch {
		return 0;
	}
}

function writeStep(i: number) {
	try {
		sessionStorage.setItem(STEP_KEY, String(i));
	} catch {
		// No storage: the tour still runs for this page view.
	}
}

function isDone(): boolean {
	try {
		return localStorage.getItem(DONE_KEY) !== null;
	} catch {
		return false;
	}
}

function setDone(done: boolean) {
	try {
		if (done) localStorage.setItem(DONE_KEY, '1');
		else localStorage.removeItem(DONE_KEY);
	} catch {
		// Same: nothing to remember it with.
	}
}

// ── public API ──────────────────────────────────────────────────────────────

export async function startTour(options: { restart?: boolean } = {}): Promise<void> {
	if (typeof window === 'undefined') return;
	if (options.restart) {
		setDone(false);
		writeStep(0);
		index = 0;
		stopTour();
		const { goto } = await import('$app/navigation');
		if (window.location.pathname !== '/') await goto('/');
	} else {
		index = readStep();
	}
	if (active) return;

	if (!driverFactory) {
		const [mod] = await Promise.all([import('driver.js'), import('driver.js/dist/driver.css')]);
		driverFactory = mod.driver as unknown as (config: object) => DriverInstance;
	}
	if (active) return;

	active = true;
	currentPath = window.location.pathname;
	window.addEventListener('split:tour', onTourEvent);
	showCurrent();
}

/** Auto-start for the layout: only when demo, on Today, and not finished. */
export function maybeAutoStart(demo: boolean): void {
	if (typeof window === 'undefined') return;
	if (!shouldAutoStart({ demo, done: isDone(), pathname: window.location.pathname })) return;
	void startTour();
}

/** The layout calls this after every navigation (`afterNavigate` has to be
 * registered during component setup, so it cannot live in this module). */
export function notifyNavigated(pathname: string): void {
	currentPath = pathname;
	if (active) apply({ kind: 'path', pathname });
}

/** Closes the popover. Leaves the stored step and the done flag alone. */
export function stopTour(): void {
	showToken++;
	clearTimeout(pollTimer);
	closePopover();
	active = false;
	window.removeEventListener('split:tour', onTourEvent);
}

// ── engine ──────────────────────────────────────────────────────────────────

function finish() {
	setDone(true);
	try {
		sessionStorage.removeItem(STEP_KEY);
	} catch {
		// ignore
	}
	stopTour();
}

function onTourEvent(event: Event) {
	const type = (event as CustomEvent<{ type?: unknown }>).detail?.type;
	if (typeof type === 'string') apply({ kind: 'event', type });
}

function apply(signal: TourSignal) {
	if (!active) return;
	const next = advance(TOUR_STEPS, index, signal);
	if (next === 'done') return finish();
	if (next !== index) {
		index = next;
		writeStep(index);
	}
	showCurrent();
}

/** The first matching element that is actually laid out (the mobile and the
 * desktop entry forms share one anchor name; only one is visible). */
function findVisible(target: string): Element | null {
	for (const el of document.querySelectorAll(`[data-tour="${target}"]`)) {
		if (el.getClientRects().length > 0) return el;
	}
	return null;
}

function closePopover() {
	try {
		driverObj?.destroy();
	} catch {
		// Already gone.
	}
	driverObj = null;
}

function showCurrent() {
	const token = ++showToken;
	clearTimeout(pollTimer);
	const step = TOUR_STEPS[index];
	if (!step || !stepShowsOn(step, currentPath)) {
		closePopover();
		return;
	}

	window.dispatchEvent(new CustomEvent('split:tour-show', { detail: { target: step.target } }));

	const started = Date.now();
	const look = () => {
		if (token !== showToken) return;
		const el = findVisible(step.target);
		if (el) return draw(step, el, false);
		if (Date.now() - started >= ANCHOR_WAIT_MS) return draw(step, null, true);
		pollTimer = setTimeout(look, POLL_MS);
	};
	look();
}

function draw(step: TourStep, el: Element | null, fallback: boolean) {
	if (!driverFactory) return;
	closePopover();
	fallbackShown = fallback;
	const last = index === TOUR_STEPS.length - 1;
	const hasNext = step.kind === 'info' || fallback;
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	driverObj = driverFactory({
		animate: !reduced,
		smoothScroll: !reduced,
		allowClose: false,
		allowKeyboardControl: true,
		overlayColor: '#000',
		overlayOpacity: 0.6,
		stagePadding: 6,
		stageRadius: 8,
		popoverClass: 'split-tour'
	});
	driverObj.highlight({
		...(el ? { element: el } : {}),
		popover: {
			title: step.title,
			description: step.body,
			showButtons: hasNext ? ['next'] : [],
			nextBtnText: last ? 'Done' : 'Next',
			onNextClick: () => apply({ kind: 'next', fallback: fallbackShown }),
			onPopoverRender: (popover: {
				wrapper: HTMLElement;
				footer: HTMLElement;
				nextButton: HTMLButtonElement;
			}) => addSkip(popover)
		}
	});
}

function addSkip(popover: { wrapper: HTMLElement; footer: HTMLElement }) {
	const skip = document.createElement('button');
	skip.type = 'button';
	skip.className = 'split-tour-skip';
	skip.textContent = 'Skip tour';
	skip.addEventListener('click', finish);
	popover.wrapper.appendChild(skip);
}
