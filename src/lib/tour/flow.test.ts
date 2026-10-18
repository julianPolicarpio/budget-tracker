import { describe, expect, it } from 'vitest';
import { TOUR_STEPS } from './steps';
import { advance, parseStoredStep, shouldAutoStart, stepShowsOn } from './flow';

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

describe('shouldAutoStart', () => {
	it('starts in demo on Today when not finished', () => {
		expect(shouldAutoStart({ demo: true, done: false, pathname: '/' })).toBe(true);
	});

	it('never starts outside demo', () => {
		expect(shouldAutoStart({ demo: false, done: false, pathname: '/' })).toBe(false);
	});

	it('does not restart a finished or skipped tour', () => {
		expect(shouldAutoStart({ demo: true, done: true, pathname: '/' })).toBe(false);
	});

	it('does not start on a page that is not Today', () => {
		expect(shouldAutoStart({ demo: true, done: false, pathname: '/review' })).toBe(false);
	});
});
