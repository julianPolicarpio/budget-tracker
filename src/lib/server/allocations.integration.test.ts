/**
 * Execute-allocation regression tests: ticking a checklist item is a balanced
 * move from Income to the destination bucket, or nothing at all.
 *
 * The bug this pins: executeAllocation used to credit the destination without
 * debiting Income, counting the arrival twice and inflating the money map by
 * the allocation sum. Conservation of the six-bucket sum is the invariant, and
 * "a second tick changes nothing" is the idempotence guarantee.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	schema: typeof import('./db').schema;
	allocations: typeof import('./allocations');
};

let m: Mod;

/** The user migrations seed with all six buckets. */
const OWNER = 1;
/** A user with no buckets at all. */
const BUCKETLESS = 2;

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-alloc-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));

	m = {
		sqlite: dbMod.sqlite,
		schema: dbMod.schema,
		allocations: await import('./allocations')
	};

	// A second user with no account rows at all. Every provisioning path
	// creates all six buckets, so a missing-bucket throw must never be
	// satisfied by silently falling back to user 1's buckets.
	m.sqlite.prepare(`INSERT INTO app_user (id, created_at) VALUES (?, 'x')`).run(BUCKETLESS);
});

/** Sum of all asserted balances — the thing that must not change. */
function totalMoney(userId: number): number {
	return (
		m.sqlite
			.prepare(`SELECT coalesce(sum(balance_minor), 0) AS t FROM account WHERE user_id = ?`)
			.get(userId) as { t: number }
	).t;
}

function balanceOfKind(userId: number, kind: string): number {
	return (
		m.sqlite
			.prepare(`SELECT balance_minor AS b FROM account WHERE user_id = ? AND kind = ?`)
			.get(userId, kind) as { b: number }
	).b;
}

function balanceOfId(accountId: number): number {
	return (
		m.sqlite.prepare(`SELECT balance_minor AS b FROM account WHERE id = ?`).get(accountId) as {
			b: number;
		}
	).b;
}

function executedAtOf(allocationId: number): string | null {
	return (
		m.sqlite.prepare(`SELECT executed_at AS e FROM allocation WHERE id = ?`).get(allocationId) as {
			e: string | null;
		}
	).e;
}

let periodSeq = 0;

/**
 * One fresh period plus the checklist rows ensureAllocations knows to make.
 * The period object is built by hand in the engine's camelCase shape — raw
 * sqlite rows are snake_case and `period.startsOn` would read undefined.
 */
function freshPeriodWithAllocations(): { id: number; startsOn: string } {
	periodSeq += 1;
	const start = `2026-09-${String(13 + periodSeq).padStart(2, '0')}`;
	const end = `2026-09-${String(19 + periodSeq).padStart(2, '0')}`;
	const result = m.sqlite
		.prepare(
			`INSERT INTO period (starts_on, ends_on, days, spend_alloc_minor, daily_allowance_minor,
			                     haircut_pct_applied, phase_at_open, created_at, user_id)
			 VALUES (?, ?, 7, 100000, 12143, 15, 1, 'x', 1)`
		)
		.run(start, end);
	const period = {
		id: Number(result.lastInsertRowid),
		startsOn: start,
		endsOn: end,
		days: 7,
		spendAllocMinor: 100000
	};

	// The Spend allocation comes from the frozen period figure; no schedules,
	// commitments or income sources exist in this fixture, so it is the only row.
	m.allocations.ensureAllocations(OWNER, period as never, '2026-09-15');
	return period;
}

describe('executeAllocation is a balanced move', () => {
	it('credits the destination and debits Income by the same amount', () => {
		const period = freshPeriodWithAllocations();
		const items = m.allocations.checklist(OWNER, period as never, '2026-09-15');
		expect(items.length).toBeGreaterThan(0);

		const item = items[0];
		const destBefore = balanceOfId(item.accountId);
		const inflowBefore = balanceOfKind(OWNER, 'inflow');
		const totalBefore = totalMoney(OWNER);

		m.allocations.executeAllocation(OWNER, item.id);

		expect(balanceOfId(item.accountId)).toBe(destBefore + item.amountMinor);
		expect(balanceOfKind(OWNER, 'inflow')).toBe(inflowBefore - item.amountMinor);
		expect(totalMoney(OWNER)).toBe(totalBefore);
	});

	it('a second tick changes nothing', () => {
		const period = freshPeriodWithAllocations();
		const item = m.allocations.checklist(OWNER, period as never, '2026-09-15')[0];

		m.allocations.executeAllocation(OWNER, item.id);
		const destAfterFirst = balanceOfId(item.accountId);
		const inflowAfterFirst = balanceOfKind(OWNER, 'inflow');
		const totalAfterFirst = totalMoney(OWNER);

		m.allocations.executeAllocation(OWNER, item.id);

		expect(balanceOfId(item.accountId)).toBe(destAfterFirst);
		expect(balanceOfKind(OWNER, 'inflow')).toBe(inflowAfterFirst);
		expect(totalMoney(OWNER)).toBe(totalAfterFirst);
	});

	it('an executed item is stamped, and only once', () => {
		const period = freshPeriodWithAllocations();
		const item = m.allocations.checklist(OWNER, period as never, '2026-09-15')[0];

		expect(executedAtOf(item.id)).toBeNull();
		m.allocations.executeAllocation(OWNER, item.id);
		expect(executedAtOf(item.id)).not.toBeNull();
	});

	it('executing every item conserves the six-bucket sum', () => {
		const period = freshPeriodWithAllocations();
		const items = m.allocations.checklist(OWNER, period as never, '2026-09-15');
		const totalBefore = totalMoney(OWNER);
		const allocSum = items.reduce((s, i) => s + i.amountMinor, 0);
		expect(allocSum).toBeGreaterThan(0);
		const inflowBefore = balanceOfKind(OWNER, 'inflow');

		for (const item of items) m.allocations.executeAllocation(OWNER, item.id);

		// Money moved, none appeared, none vanished.
		expect(totalMoney(OWNER)).toBe(totalBefore);
		expect(balanceOfKind(OWNER, 'inflow')).toBe(inflowBefore - allocSum);
	});

	it('cross-tenant execution is inert', () => {
		const period = freshPeriodWithAllocations();
		const item = m.allocations.checklist(OWNER, period as never, '2026-09-15')[0];
		const totalBefore = totalMoney(OWNER);

		expect(() => m.allocations.executeAllocation(BUCKETLESS, item.id)).not.toThrow();

		// The stranger's call found nothing owned by them — nothing moved, and
		// the owner's allocation is still pending.
		expect(totalMoney(OWNER)).toBe(totalBefore);
		expect(executedAtOf(item.id)).toBeNull();
	});

	it('throws when the user has no Income bucket instead of falling back to user 1', () => {
		const period = freshPeriodWithAllocations();
		const ownerTotalBefore = totalMoney(OWNER);
		const ownerInflowBefore = balanceOfKind(OWNER, 'inflow');

		// Give user 2 exactly one destination bucket and one allocation for it:
		// enough to get past the destination lookup, short enough to hit the
		// missing-Income guard.
		m.sqlite
			.prepare(
				`INSERT INTO account (slug, name, kind, user_id) VALUES ('spend', 'Spend', 'spend', 2)`
			)
			.run();
		const spend2 = m.sqlite
			.prepare(`SELECT id FROM account WHERE user_id = 2 AND kind = 'spend'`)
			.get() as { id: number };
		m.sqlite
			.prepare(
				`INSERT INTO allocation (period_id, account_id, amount_minor, user_id)
				 VALUES (?, ?, 5000, 2)`
			)
			.run(period.id, spend2.id);
		const alloc2 = m.sqlite
			.prepare(`SELECT id FROM allocation WHERE user_id = 2 ORDER BY id DESC LIMIT 1`)
			.get() as { id: number };

		expect(() => m.allocations.executeAllocation(BUCKETLESS, alloc2.id)).toThrow(
			'No Income bucket'
		);
		// The guard threw before anything was written: the incomplete user's
		// destination is untouched, the allocation is still pending, and user
		// 1's money was never in play.
		expect(balanceOfId(spend2.id)).toBe(0);
		expect(executedAtOf(alloc2.id)).toBeNull();
		expect(totalMoney(OWNER)).toBe(ownerTotalBefore);
		expect(balanceOfKind(OWNER, 'inflow')).toBe(ownerInflowBefore);
	});
});
