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

export function shouldAutoStart(input: {
	demo: boolean;
	done: boolean;
	pathname: string;
}): boolean {
	return input.demo && !input.done && normalise(input.pathname) === '/';
}
