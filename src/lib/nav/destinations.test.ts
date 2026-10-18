import { describe, expect, it } from 'vitest';
import { DEMO_HREFS, DESTINATIONS, destinationsFor } from './destinations';

describe('destinationsFor', () => {
	it('is the full list outside demo', () => {
		expect(destinationsFor(false)).toEqual(DESTINATIONS);
	});

	it('is only Weekly review in demo', () => {
		expect(destinationsFor(true)).toEqual([{ href: '/review', label: 'Weekly review' }]);
		expect(DEMO_HREFS).toEqual(['/review']);
	});
});
