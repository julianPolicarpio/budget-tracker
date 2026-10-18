import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOUR_STEPS } from './steps';

/** The files that may carry a `data-tour` anchor for a step on each page. */
const SOURCES: Record<string, string[]> = {
	'/': [
		'src/routes/+page.svelte',
		'src/lib/components/NavStrip.svelte',
		'src/lib/components/EntryResolution.svelte',
		'src/lib/components/LogOverlay.svelte',
		'src/lib/components/actions/ActionView.svelte'
	],
	'/review': ['src/routes/review/+page.svelte']
};

describe('TOUR_STEPS', () => {
	it('has six steps with unique ids', () => {
		expect(TOUR_STEPS).toHaveLength(6);
		expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(6);
	});

	it('gives every action step something to advance on', () => {
		for (const step of TOUR_STEPS) {
			if (step.kind === 'action') expect(step.advanceOn).toBeTruthy();
		}
	});

	it('anchors every step to a data-tour value present on its page', () => {
		for (const step of TOUR_STEPS) {
			const text = SOURCES[step.page].map((f) => readFileSync(f, 'utf8')).join('\n');
			// Either a plain `data-tour="x"` or a demo-gated `data-tour={... 'x' ...}`.
			const anchor = new RegExp(`data-tour=(?:"${step.target}"|\\{[^}]*'${step.target}'[^}]*\\})`);
			expect(text, `${step.id}: data-tour ${step.target}`).toMatch(anchor);
		}
	});

	it('uses no em dash and makes no accuracy claim', () => {
		for (const step of TOUR_STEPS) {
			const copy = `${step.title} ${step.body}`;
			expect(copy).not.toContain('—');
			expect(copy).not.toMatch(/\d\s*%/);
		}
	});

	it('keeps the order the design approved', () => {
		expect(TOUR_STEPS.map((s) => s.target)).toEqual([
			'range',
			'entry',
			'entry',
			'intent-result',
			'nav-review',
			'review'
		]);
	});
});
