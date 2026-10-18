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
import { advance, dockedScrollDelta, entryScrollTarget, focusesEntryField, overlapsVertically, parseStoredStep, popoverSide, restoreAction, shouldDock, stepShowsOn, type TourSignal } from './flow';
import { TOUR_STEPS, type TourStep } from './steps';

const STEP_KEY = 'split_tour_step';
const DONE_KEY = 'split_tour_done';
/** How long a missing anchor is waited for before the unanchored popover. */
const ANCHOR_WAIT_MS = 1500;
const POLL_MS = 100;

type DriverInstance = { highlight: (step: object) => void; refresh: () => void; destroy: () => void };

let active = false;
let index = 0;
let driverObj: DriverInstance | null = null;
let driverFactory: ((config: object) => DriverInstance) | null = null;
let showToken = 0;
let startToken = 0;
let undock: (() => void) | null = null;
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
		stopTour();
	}
	// The newest call wins: every await below re-checks this token, so a stale
	// auto-start can never draw over (or advance past) a Replay.
	const token = ++startToken;
	const stale = () => token !== startToken;

	if (options.restart) {
		const { goto } = await import('$app/navigation');
		if (stale()) return;
		if (window.location.pathname !== '/') await goto('/');
		if (stale()) return;
	}
	if (active) return;

	if (!driverFactory) {
		const [mod] = await Promise.all([import('driver.js'), import('driver.js/dist/driver.css')]);
		driverFactory = mod.driver as unknown as (config: object) => DriverInstance;
	}
	if (stale() || active) return;

	// Read the step only now, after every await: storage may have changed.
	index = options.restart ? 0 : readStep();
	active = true;
	currentPath = window.location.pathname;
	window.addEventListener('split:tour', onTourEvent);
	showCurrent();
}

/** Called by the layout on mount: resumes the stored step, or ends a tour
 * whose last step was left behind. */
export function maybeAutoStart(demo: boolean): void {
	if (typeof window === 'undefined') return;
	const action = restoreAction({
		steps: TOUR_STEPS,
		demo,
		done: isDone(),
		pathname: window.location.pathname,
		storedStep: readStep()
	});
	if (action === 'start') void startTour();
	else if (action === 'finish') finish();
}

/** The layout calls this after every navigation (`afterNavigate` has to be
 * registered during component setup, so it cannot live in this module). */
export function notifyNavigated(pathname: string): void {
	currentPath = pathname;
	if (active) apply({ kind: 'path', pathname });
}

/** Closes the popover. Leaves the stored step and the done flag alone. */
export function stopTour(): void {
	startToken++;
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
	undock?.();
	undock = null;
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
		if (el) return void settleThenDraw(step, el);
		if (Date.now() - started >= ANCHOR_WAIT_MS) return draw(step, null, true);
		pollTimer = setTimeout(look, POLL_MS);
	};
	look();
}

/** Scrolls the anchor to the middle of whatever scrolls it (the log overlay has
 * its own scroll area, which driver.js does not know about), waits for the
 * scroll to settle, then draws. */
async function settleThenDraw(step: TourStep, el: Element) {
	const token = showToken;
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
	await new Promise<void>((r) => requestAnimationFrame(() => r()));
	if (!reduced) {
		let last = el.getBoundingClientRect().top;
		let still = 0;
		for (let i = 0; i < 40 && still < 3; i++) {
			await new Promise<void>((r) => requestAnimationFrame(() => r()));
			const top = el.getBoundingClientRect().top;
			still = Math.abs(top - last) < 0.5 ? still + 1 : 0;
			last = top;
		}
	}
	if (token !== showToken || !active) return;
	draw(step, el, false);
}

function scrollParent(el: Element): HTMLElement | null {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const y = getComputedStyle(p).overflowY;
		if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
	}
	return null;
}

/** Phone: the popover is pinned to the top by CSS. Keep the input below it,
 * now and whenever typing grows the form and shifts the layout. */
function dockEntry(form: Element) {
	const input = form.querySelector<HTMLInputElement>('input[name="text"]');
	if (!input) return;
	const keepClear = () => {
		const popover = document.querySelector<HTMLElement>('.driver-popover');
		if (!popover) return;
		const delta = dockedScrollDelta(
			input.getBoundingClientRect().top,
			popover.getBoundingClientRect().bottom
		);
		if (delta === 0) return;
		const parent = scrollParent(form);
		if (parent) parent.scrollBy({ top: delta, behavior: 'auto' });
		else window.scrollBy({ top: delta, behavior: 'auto' });
		driverObj?.refresh();
	};
	keepClear();
	input.addEventListener('input', keepClear);
	// The layout shifts after the input event (the resolution line re-renders).
	const onInput = () => requestAnimationFrame(keepClear);
	input.addEventListener('input', onInput);
	undock = () => {
		input.removeEventListener('input', keepClear);
		input.removeEventListener('input', onInput);
	};
}

/** On a short screen the popover can land on the text field. When it does,
 * scroll the form down until the popover fits above it, then redraw. */
function clearEntryField(form: Element) {
	const input = form.querySelector<HTMLInputElement>('input[name="text"]');
	const popover = document.querySelector<HTMLElement>('.driver-popover');
	if (!input || !popover) return;
	const covers = () =>
		overlapsVertically(popover.getBoundingClientRect(), input.getBoundingClientRect());
	if (!covers()) return;
	const delta = entryScrollTarget(
		form.getBoundingClientRect().top,
		popover.getBoundingClientRect().height
	);
	const parent = scrollParent(form);
	if (parent) parent.scrollBy({ top: delta, behavior: 'auto' });
	else window.scrollBy({ top: delta, behavior: 'auto' });
	driverObj?.refresh();
}

function focusEntryField() {
	const form = findVisible('entry');
	const input = form?.querySelector<HTMLInputElement>('input[name="text"]');
	input?.focus({ preventScroll: true });
}

function draw(step: TourStep, el: Element | null, fallback: boolean) {
	if (!driverFactory) return;
	closePopover();
	fallbackShown = fallback;
	const last = index === TOUR_STEPS.length - 1;
	const hasNext = step.kind === 'info' || fallback;
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const docked = el !== null && shouldDock(step, window.innerWidth);

	driverObj = driverFactory({
		animate: !reduced,
		smoothScroll: !reduced,
		allowClose: false,
		allowKeyboardControl: true,
		overlayColor: '#000',
		overlayOpacity: 0.6,
		stagePadding: 6,
		stageRadius: 8,
		popoverClass: docked ? 'split-tour split-tour-docked' : 'split-tour'
	});
	driverObj.highlight({
		...(el ? { element: el } : {}),
		popover: {
			title: step.title,
			description: step.body,
			...(el ? popoverSide(step) : {}),
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
	// Typing steps: the visitor should be able to type straight away. Skip tour
	// stays reachable with Tab.
	if (!fallback && focusesEntryField(step)) {
		focusEntryField();
		if (el && docked) dockEntry(el);
		else if (el) clearEntryField(el);
	}
}

function addSkip(popover: { wrapper: HTMLElement; footer: HTMLElement }) {
	const skip = document.createElement('button');
	skip.type = 'button';
	skip.className = 'split-tour-skip';
	skip.textContent = 'Skip tour';
	skip.addEventListener('click', finish);
	popover.wrapper.appendChild(skip);
}
