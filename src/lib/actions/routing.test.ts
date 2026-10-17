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

	it('offers the model every action except log-spending, in catalogue order, ending with unclear', () => {
		for (const text of ['help me organise this', 'refund transfer trip plan bill debt save income account']) {
			const options = modelOptions(text);
			const ids = options.map((o) => o.id);
			expect(options.length).toBeLessThanOrEqual(16);
			expect(ids.at(-1)).toBe('unclear');
			expect(ids).not.toContain('log-spending');
			for (const id of ['record-income', 'set-budget', 'update-balance', 'add-account', 'add-edit-rule', 'move-between-purposes', 'record-payment']) {
				expect(ids).toContain(id);
			}
			expect(ids.slice(0, -1)).toEqual(catalogueOrder(ids.slice(0, -1)));
			expect(ids.slice(0, -1)).toEqual(CATALOGUE.filter((a) => a.id !== 'log-spending').map((a) => a.id));
		}
	});

	it('uses each action\'s model description when asked, else its label', () => {
		const options = modelOptions('help me organise this', 'descriptions');
		for (const o of options.slice(0, -1)) {
			const a = CATALOGUE.find((x) => x.id === o.id)!;
			expect(o.description).toBe(a.modelDescription ?? a.label);
		}
		expect(options.slice(0, -1).some((o) => o.description !== CATALOGUE.find((x) => x.id === o.id)!.label)).toBe(true);
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
