/**
 * A chart that cannot be drawn honestly must not be drawn.
 *
 * Observed in the running app: the review's "spent per week" chart had exactly
 * one completed review behind it, with a value of zero. Plot expands a
 * degenerate domain to fill the frame, so a single zero-value bar rendered as
 * an enormous filled rectangle — which reads as a bug, and worse, reads as a
 * huge number on a screen whose entire job is not overstating figures.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const figure = readFileSync(resolve('src/lib/components/Figure.svelte'), 'utf8');

describe('Figure refuses to draw too little data', () => {
	it('gates every render path on the same `plottable` check', () => {
		// Three places decide whether to draw: the mount, the resize, and the
		// markup. If they ever disagree, one of them draws the rectangle.
		const guards = figure.match(/!plottable|&& plottable/g) ?? [];
		expect(guards.length).toBeGreaterThanOrEqual(3);
		expect(figure).toContain('rows.length >= minPoints');
	});

	it('falls back to the empty note rather than an empty frame', () => {
		expect(figure).toContain('{#if !plottable}');
		expect(figure).toContain('{emptyNote}');
	});

	it('keeps the table view, which is the colour-contrast relief as well as the a11y fallback', () => {
		// Spec §8.6 requires it, and the light-mode palette warning is
		// discharged by it. Removing this toggle breaks accessibility twice.
		expect(figure).toContain("state('table')");
	});
});

describe('every time-series chart sets a floor', () => {
	const pages = [
		'src/routes/review/+page.svelte',
		'src/routes/irregulars/+page.svelte',
		'src/routes/trips/+page.svelte'
	];

	it('never leaves a trend chart at the default of one point', () => {
		for (const p of pages) {
			const src = readFileSync(resolve(p), 'utf8');
			const charts = (src.match(/<Figure/g) ?? []).length;
			const floors = (src.match(/minPoints=\{/g) ?? []).length;
			// Not every Figure is a trend — a single-period breakdown is fine at
			// one point — but a page with charts and no floors at all means
			// nobody thought about it.
			if (charts > 0) expect(floors).toBeGreaterThan(0);
		}
	});
});
