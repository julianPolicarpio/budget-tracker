import { describe, expect, it } from 'vitest';
import { demoRedirect } from './demo-routes';

const HIDDEN = [
	'/accounts',
	'/irregulars',
	'/subscriptions',
	'/trips',
	'/debt',
	'/rules',
	'/trends',
	'/settings',
	'/setup'
];

describe('demoRedirect', () => {
	it.each(HIDDEN)('sends a demo GET of %s to Today', (p) => {
		expect(demoRedirect('GET', p, 'demo')).toBe('/');
		expect(demoRedirect('HEAD', p, 'demo')).toBe('/');
	});

	it('catches sub-paths', () => {
		expect(demoRedirect('GET', '/trips/3', 'demo')).toBe('/');
		expect(demoRedirect('GET', '/settings/export', 'demo')).toBe('/');
	});

	it('lets POSTs through so the typing bar still works', () => {
		expect(demoRedirect('POST', '/trips', 'demo')).toBeNull();
		expect(demoRedirect('POST', '/accounts', 'demo')).toBeNull();
	});

	it.each(['/', '/review', '/review/2026-10-12', '/api/intent', '/demo', '/signin', '/signout', '/auth/x'])(
		'never redirects %s',
		(p) => {
			expect(demoRedirect('GET', p, 'demo')).toBeNull();
		}
	);

	it('does not catch look-alikes', () => {
		expect(demoRedirect('GET', '/rulesx', 'demo')).toBeNull();
		expect(demoRedirect('GET', '/settingsfoo', 'demo')).toBeNull();
		expect(demoRedirect('GET', '/tripsy/1', 'demo')).toBeNull();
	});

	it.each(['google', 'single-user'])('is inert for %s', (kind) => {
		for (const p of [...HIDDEN, '/trips/3', '/review', '/']) {
			expect(demoRedirect('GET', p, kind)).toBeNull();
		}
	});
});
