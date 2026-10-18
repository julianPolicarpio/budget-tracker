import { describe, expect, it } from 'vitest';
import { canonicalRedirect } from './canonical';

const ORIGIN = 'https://split.jlndev.xyz';

describe('canonicalRedirect', () => {
	it('sends a GET on the wrong host to the same path and query on the canonical origin', () => {
		expect(canonicalRedirect('GET', '/budget', '?month=10', '127.0.0.1:3000', ORIGIN)).toBe(
			'https://split.jlndev.xyz/budget?month=10'
		);
	});
	it('leaves /api/health alone so the container health check is not redirected', () => {
		expect(canonicalRedirect('GET', '/api/health', '', '127.0.0.1:3000', ORIGIN)).toBeNull();
	});
	it('never redirects a POST', () => {
		expect(canonicalRedirect('POST', '/budget', '', '127.0.0.1:3000', ORIGIN)).toBeNull();
	});
	it('does nothing when the host already matches', () => {
		expect(canonicalRedirect('GET', '/budget', '', 'split.jlndev.xyz', ORIGIN)).toBeNull();
	});
	it('does nothing without an origin or without a host header', () => {
		expect(canonicalRedirect('GET', '/budget', '', '127.0.0.1:3000', null)).toBeNull();
		expect(canonicalRedirect('GET', '/budget', '', null, ORIGIN)).toBeNull();
	});
});
