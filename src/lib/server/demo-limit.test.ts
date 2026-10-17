import { describe, expect, it } from 'vitest';
import { clientIp, createDemoLimiter, limiterKey } from './demo-limit';

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

describe('limiter pruning', () => {
	it('drops keys whose hits are all older than an hour', () => {
		let t = 0;
		const l = createDemoLimiter({ perIpPerHour: 5, maxLive: 200, now: () => t });
		l.check('1.1.1.1', 0);
		l.check('2.2.2.2', 0);
		expect(l.size()).toBe(2);
		t = 3_600_001;
		for (let i = 0; i < 100; i++) l.check('9.9.9.9', 0);
		expect(l.size()).toBe(1);
	});
});

describe('limiterKey', () => {
	it('keys IPv4 by the address', () => {
		expect(limiterKey('1.2.3.4')).toBe('1.2.3.4');
	});
	it('shares one key across a /64 and separates different /64s', () => {
		expect(limiterKey('2001:db8:1:2:aaaa::1')).toBe(limiterKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
		expect(limiterKey('2001:db8:1:2::1')).not.toBe(limiterKey('2001:db8:1:3::1'));
	});
	it('expands :: compression', () => {
		expect(limiterKey('2001:db8::1')).toBe(limiterKey('2001:0db8:0:0:0:0:0:1'));
		expect(limiterKey('::1')).toBe(limiterKey('0:0:0:0:0:0:0:1'));
	});
	it('keys IPv4-mapped addresses by the IPv4 address', () => {
		expect(limiterKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
	});
});

describe('clientIp', () => {
	it('trusts a trimmed CF header in demo mode', () => {
		expect(clientIp({ authKind: 'demo', cfHeader: ' 9.9.9.9 ', fallback: '10.0.0.1' })).toBe('9.9.9.9');
	});
	it('falls back on an empty or whitespace header', () => {
		expect(clientIp({ authKind: 'demo', cfHeader: '', fallback: '10.0.0.1' })).toBe('10.0.0.1');
		expect(clientIp({ authKind: 'demo', cfHeader: '   ', fallback: '10.0.0.1' })).toBe('10.0.0.1');
		expect(clientIp({ authKind: 'demo', cfHeader: null, fallback: '10.0.0.1' })).toBe('10.0.0.1');
	});
	it('ignores the header outside demo mode', () => {
		expect(clientIp({ authKind: 'google', cfHeader: '9.9.9.9', fallback: '10.0.0.1' })).toBe('10.0.0.1');
	});
});
