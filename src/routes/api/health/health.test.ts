import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
// The real db module opens the database on import; stub it so this test never touches one.
vi.mock('$lib/server/db', () => ({ sqlite: { prepare: () => ({ get }) } }));

import { GET } from './+server';

afterEach(() => {
	get.mockReset();
	vi.restoreAllMocks();
});

describe('GET /api/health', () => {
	it('answers { ok: true } when the database answers', async () => {
		get.mockReturnValue({});
		const res = await GET({} as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
	it('answers 503 { ok: false } without echoing the error, and logs it server-side', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		get.mockImplementation(() => {
			throw new Error('disk I/O error at /secret/path');
		});
		const res = await GET({} as never);
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ ok: false });
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('disk I/O error at /secret/path'));
	});
});
