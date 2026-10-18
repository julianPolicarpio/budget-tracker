/**
 * Tour decisions with no DOM in them: given where the visitor is and what just
 * happened, which step comes next. `tour.ts` is the thin shell around this.
 */
import type { TourStep } from './steps';

export type TourSignal =
	/** The Next / Done button. `fallback` is true when the popover has no anchor. */
	| { kind: 'next'; fallback?: boolean }
	/** A `split:tour` event dispatched by a page. */
	| { kind: 'event'; type: string }
	/** The visitor arrived on a page. */
	| { kind: 'path'; pathname: string };

/** The next step index, `'done'` past the end, or `index` when nothing changes. */
export function advance(
	steps: readonly TourStep[],
	index: number,
	signal: TourSignal
): number | 'done' {
	const step = steps[index];
	if (!step) return 'done';

	let moves = false;
	if (signal.kind === 'next') {
		moves = step.kind === 'info' || signal.fallback === true;
	} else if (step.kind === 'action') {
		if (signal.kind === 'event') moves = signal.type === step.advanceOn;
		else moves = step.advanceOn === 'navigate-review' && normalise(signal.pathname) === '/review';
	}

	if (!moves) return index;
	return index + 1 >= steps.length ? 'done' : index + 1;
}

function normalise(pathname: string): string {
	return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export function stepShowsOn(step: TourStep, pathname: string): boolean {
	return normalise(pathname) === step.page;
}

/** A stored step index, or 0 for anything that is not a valid index. */
export function parseStoredStep(raw: string | null, length: number): number {
	if (raw === null || !/^\d+$/.test(raw)) return 0;
	const n = Number(raw);
	return n < length ? n : 0;
}

export type Restore = 'start' | 'finish' | 'none';

/**
 * What to do when a page loads in the demo. Resume when the stored step
 * belongs on this page (so a reload on /review picks the last step back up).
 * If the visitor reached the last step and has since left its page, the tour
 * is over. Otherwise leave it alone.
 */
export function restoreAction(input: {
	steps: readonly TourStep[];
	demo: boolean;
	done: boolean;
	pathname: string;
	storedStep: number;
}): Restore {
	if (!input.demo || input.done) return 'none';
	const step = input.steps[input.storedStep];
	if (!step) return 'none';
	if (stepShowsOn(step, input.pathname)) return 'start';
	return input.storedStep === input.steps.length - 1 ? 'finish' : 'none';
}

/** Steps that ask the visitor to type: the entry field should have focus. */
export function focusesEntryField(step: TourStep): boolean {
	return step.kind === 'action' && step.target === 'entry';
}

/** Typing steps put the popover above the form so it never covers the field. */
export function popoverSide(step: TourStep): { side: 'top'; align: 'start' } | Record<string, never> {
	return focusesEntryField(step) ? { side: 'top', align: 'start' } : {};
}

export const POPOVER_GAP = 24;

/**
 * How far to scroll (positive = down) so a form whose top is at `formTop`
 * sits just below a popover of `popoverHeight` placed above it.
 */
export function entryScrollTarget(
	formTop: number,
	popoverHeight: number,
	gap: number = POPOVER_GAP
): number {
	return Math.round(formTop - (popoverHeight + gap));
}

/** True when two rects (viewport coordinates) overlap vertically. */
export function overlapsVertically(
	a: { top: number; bottom: number },
	b: { top: number; bottom: number }
): boolean {
	return a.top < b.bottom && b.top < a.bottom;
}
