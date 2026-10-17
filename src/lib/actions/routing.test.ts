import { describe, expect, it } from 'vitest';
import { catalogueOrder, fallbackChoices, modelOptions, routedChoices } from './routing';
import { CATALOGUE } from './catalogue';

describe('routing helpers', () => {
	it('keeps catalogue order regardless of input order', () => {
		const ids = ['save-for-later', 'record-income'];
		const order = CATALOGUE.map((a) => a.id);
		expect(catalogueOrder(ids)).toEqual([...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
	});

	it('falls back to the three defaults for text that matches nothing', () => {
		expect(fallbackChoices('help me organise this')).toEqual(['add-bill-subscription', 'add-debt', 'save-for-later']);
	});

	it('offers the model at most eight options, ending with unclear, never log-spending', () => {
		const options = modelOptions('refund transfer trip plan bill debt save income account');
		expect(options.length).toBeLessThanOrEqual(8);
		expect(options.at(-1)!.id).toBe('unclear');
		expect(options.map((o) => o.id)).not.toContain('log-spending');
	});

	it('puts a model answer first among the routed choices, in catalogue order', () => {
		const choices = routedChoices('record-refund', 'help me organise this');
		expect(choices).toContain('record-refund');
		expect(choices).toHaveLength(3);
		expect(choices).toEqual(catalogueOrder(choices));
	});

	it('treats unclear and null as no answer', () => {
		expect(routedChoices('unclear', 'help me organise this')).toEqual(fallbackChoices('help me organise this'));
		expect(routedChoices(null, 'help me organise this')).toEqual(fallbackChoices('help me organise this'));
	});
});
