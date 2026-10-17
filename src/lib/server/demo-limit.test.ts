import { describe, expect, it } from 'vitest';
import { createDemoLimiter } from './demo-limit';

describe('demo limiter', () => {
	it('allows five tenants per IP per hour, then refuses until the hour rolls', () => {
		let t = 0;
		const l = createDemoLimiter({ perIpPerHour: 5, maxLive: 200, now: () => t });
		for (let i = 0; i < 5; i++) expect(l.check('1.2.3.4', 0)).toBe('ok');
		expect(l.check('1.2.3.4', 0)).toBe('too-many');
		expect(l.check('5.6.7.8', 0)).toBe('ok');
		t = 3_600_001;
		expect(l.check('1.2.3.4', 0)).toBe('ok');
	});
	it('reports busy at the global cap without spending the IP budget', () => {
		const l = createDemoLimiter({ perIpPerHour: 1, maxLive: 200, now: () => 0 });
		expect(l.check('1.2.3.4', 200)).toBe('busy');
		expect(l.check('1.2.3.4', 199)).toBe('ok');
	});
});
