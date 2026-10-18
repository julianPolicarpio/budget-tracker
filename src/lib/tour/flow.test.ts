import { describe, expect, it } from 'vitest';
import { TOUR_STEPS } from './steps';
import { advance, entryScrollTarget, focusesEntryField, overlapsVertically, parseStoredStep, popoverSide, restoreAction, stepShowsOn } from './flow';

const LOG = 1;
const ASK = 2;
const LAYA = 3;
const REVIEW_LINK = 4;
const LAST = TOUR_STEPS.length - 1;

describe('advance', () => {
	it('moves an info step on with "next"', () => {
		expect(advance(TOUR_STEPS, 0, { kind: 'next' })).toBe(1);
	});

	it('ignores "next" on an action step that is anchored', () => {
		expect(advance(TOUR_STEPS, LOG, { kind: 'next' })).toBe(LOG);
	});

	it('lets "next" move an action step on when it fell back to an unanchored popover', () => {
		expect(advance(TOUR_STEPS, LOG, { kind: 'next', fallback: true })).toBe(ASK);
	});

	it('advances an action step only on its own event', () => {
		expect(advance(TOUR_STEPS, LOG, { kind: 'event', type: 'logged' })).toBe(ASK);
		expect(advance(TOUR_STEPS, LOG, { kind: 'event', type: 'intent' })).toBe(LOG);
		expect(advance(TOUR_STEPS, ASK, { kind: 'event', type: 'intent' })).toBe(LAYA);
		expect(advance(TOUR_STEPS, ASK, { kind: 'event', type: 'logged' })).toBe(ASK);
	});

	it('ignores events on an info step', () => {
		expect(advance(TOUR_STEPS, LAYA, { kind: 'event', type: 'logged' })).toBe(LAYA);
	});

	it('treats arriving on /review as the navigate-review event', () => {
		expect(advance(TOUR_STEPS, REVIEW_LINK, { kind: 'path', pathname: '/review' })).toBe(LAST);
		expect(advance(TOUR_STEPS, REVIEW_LINK, { kind: 'path', pathname: '/' })).toBe(REVIEW_LINK);
		expect(advance(TOUR_STEPS, LOG, { kind: 'path', pathname: '/review' })).toBe(LOG);
	});

	it('finishes after the last step', () => {
		expect(advance(TOUR_STEPS, LAST, { kind: 'next' })).toBe('done');
	});

	it('finishes on an out-of-range index rather than throwing', () => {
		expect(advance(TOUR_STEPS, 99, { kind: 'next' })).toBe('done');
	});
});

describe('stepShowsOn', () => {
	it('shows a step only on its own page', () => {
		expect(stepShowsOn(TOUR_STEPS[0], '/')).toBe(true);
		expect(stepShowsOn(TOUR_STEPS[0], '/review')).toBe(false);
		expect(stepShowsOn(TOUR_STEPS[LAST], '/review')).toBe(true);
		expect(stepShowsOn(TOUR_STEPS[LAST], '/review/')).toBe(true);
		expect(stepShowsOn(TOUR_STEPS[LAST], '/')).toBe(false);
	});
});

describe('parseStoredStep', () => {
	it('starts from the first step with nothing stored', () => {
		expect(parseStoredStep(null, TOUR_STEPS.length)).toBe(0);
	});

	it('reads a valid stored index', () => {
		expect(parseStoredStep('3', TOUR_STEPS.length)).toBe(3);
	});

	it('falls back to the first step on junk', () => {
		for (const raw of ['', 'abc', '-1', '1.5', 'NaN']) {
			expect(parseStoredStep(raw, TOUR_STEPS.length)).toBe(0);
		}
	});

	it('falls back to the first step when the index is past the end', () => {
		expect(parseStoredStep('99', TOUR_STEPS.length)).toBe(0);
	});
});

describe('restoreAction', () => {
	const base = { steps: TOUR_STEPS, demo: true, done: false };

	it('starts on Today from the first step', () => {
		expect(restoreAction({ ...base, pathname: '/', storedStep: 0 })).toBe('start');
	});

	it('resumes the last step after a reload on /review', () => {
		expect(restoreAction({ ...base, pathname: '/review', storedStep: LAST })).toBe('start');
	});

	it('resumes a mid-tour step on Today', () => {
		expect(restoreAction({ ...base, pathname: '/', storedStep: LAYA })).toBe('start');
	});

	it('finishes when the last step is stored and the visitor is elsewhere', () => {
		expect(restoreAction({ ...base, pathname: '/', storedStep: LAST })).toBe('finish');
	});

	it('leaves a mid-tour step alone on another page', () => {
		expect(restoreAction({ ...base, pathname: '/review', storedStep: LOG })).toBe('none');
	});

	it('never acts outside demo or once finished', () => {
		expect(restoreAction({ ...base, demo: false, pathname: '/', storedStep: 0 })).toBe('none');
		expect(restoreAction({ ...base, done: true, pathname: '/', storedStep: 0 })).toBe('none');
		expect(restoreAction({ ...base, demo: false, pathname: '/', storedStep: LAST })).toBe('none');
	});
});

describe('focusesEntryField', () => {
	it('is true only for the two action steps that target the entry', () => {
		expect(TOUR_STEPS.map(focusesEntryField)).toEqual([false, true, true, false, false, false]);
	});
});

describe('popoverSide', () => {
	it('places the popover above the form on typing steps only', () => {
		expect(popoverSide(TOUR_STEPS[1])).toEqual({ side: 'top', align: 'start' });
		expect(popoverSide(TOUR_STEPS[2])).toEqual({ side: 'top', align: 'start' });
		expect(popoverSide(TOUR_STEPS[0])).toEqual({});
		expect(popoverSide(TOUR_STEPS[3])).toEqual({});
	});
});

describe('entryScrollTarget', () => {
	it('scrolls down by the room the popover needs above the form', () => {
		// Phone: form top 340, popover 144 high, 24 gap -> 340 - 168 = 172.
		expect(entryScrollTarget(340, 144)).toBe(172);
	});

	it('scrolls up (negative) when the form is already too close to the top', () => {
		expect(entryScrollTarget(100, 144)).toBe(-68);
	});

	it('is zero when the form already sits exactly below the popover', () => {
		expect(entryScrollTarget(168, 144)).toBe(0);
	});
});

describe('overlapsVertically', () => {
	it('detects the popover covering the input', () => {
		expect(overlapsVertically({ top: 280, bottom: 424 }, { top: 373, bottom: 420 })).toBe(true);
	});

	it('is false when the popover ends above the input', () => {
		expect(overlapsVertically({ top: 100, bottom: 330 }, { top: 373, bottom: 420 })).toBe(false);
	});
});
