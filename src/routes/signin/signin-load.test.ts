/**
 * The sign-in load function: pure, reads only locals.authKind and the URL,
 * so it is imported directly (no server module, no database).
 */
import { describe, expect, it } from 'vitest';
import { load } from './+page.server';

type Kind = 'single-user' | 'demo' | 'google';

function run(authKind: Kind, search = '') {
	const event = { locals: { authKind }, url: new URL(`http://localhost/signin${search}`) };
	return load(event as never) as { demoOnly: boolean; notice: 'busy' | 'too-many' | null };
}

describe('/signin load', () => {
	it('demoOnly is true only in demo mode', () => {
		expect(run('demo').demoOnly).toBe(true);
		expect(run('google').demoOnly).toBe(false);
		expect(run('single-user').demoOnly).toBe(false);
	});

	it('passes through the two known notices', () => {
		expect(run('demo', '?demo=busy').notice).toBe('busy');
		expect(run('demo', '?demo=too-many').notice).toBe('too-many');
	});

	it('maps anything else to null', () => {
		expect(run('demo').notice).toBeNull();
		expect(run('demo', '?demo=<script>').notice).toBeNull();
		expect(run('demo', '?demo=').notice).toBeNull();
	});
});
