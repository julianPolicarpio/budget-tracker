/**
 * The demo tenant (Spec §3.4).
 *
 * This app is being published as portfolio work, and the single highest-value
 * thing for that purpose is a demo: **reviewers click a demo, reviewers do not
 * sign up.** A landing page describing a budgeting app that refuses to show you
 * your balance is a claim. One click into a working app carrying ninety days of
 * plausible history is the evidence.
 *
 * A demo tenant is NOT a special code path. It is an ordinary `app_user` with
 * `is_demo = 1`, isolated by exactly the same `user_id` mechanism as everyone
 * else, reading and writing through the same `forUser()` choke point. That is
 * deliberate: a separate "demo mode" branch would be a second implementation of
 * tenancy, and a second implementation is a second thing to get wrong.
 *
 * Two consequences of that follow, and both are properties rather than
 * limitations:
 *
 *   - Everything works, including logging. It is the app, not a screenshot
 *     tour, so a reviewer who types `kape 65` sees the real resolution line.
 *   - A demo user can never become a real one. Signing in creates a fresh
 *     tenant; the demo's rows are reaped and nothing is carried across. The
 *     alternative — promoting a demo to an account — means one user id changing
 *     hands, which is the sort of thing that quietly breaks tenancy invariants.
 */

import { and, eq, lt, sql } from 'drizzle-orm';
import { forUser, schema, unsafeDb } from './db';
import { provisionUser } from './auth';
import { dailyAllowance } from '$lib/allowance';
import { addDays } from './clock';

/** Demo tenants are reaped this long after they are created. */
export const DEMO_TTL_HOURS = 24;

/** How much history a reviewer lands in the middle of. */
const DEMO_DAYS = 90;

/**
 * A week's worth of plausible spending, in minor units, keyed by the eight
 * roots. Deliberately lopsided rather than uniform: a real week is mostly food
 * and transport with the occasional larger thing, and a flat distribution
 * across eight categories is the tell of generated data.
 */
const WEEK_SHAPE: ReadonlyArray<{ root: string; label: string; minor: number; planned: 0 | 1 }> = [
	{ root: 'food_out', label: 'Coffee', minor: 6_500, planned: 0 },
	{ root: 'transport', label: 'Jeepney', minor: 1_500, planned: 1 },
	{ root: 'food_in', label: 'Market', minor: 42_000, planned: 1 },
	{ root: 'food_out', label: 'Milk tea', minor: 12_000, planned: 0 },
	{ root: 'transport', label: 'Grab', minor: 18_000, planned: 0 },
	{ root: 'food_in', label: 'Rice', minor: 9_000, planned: 1 },
	{ root: 'social', label: 'Drinks', minor: 35_000, planned: 0 },
	{ root: 'health', label: 'Medicine', minor: 24_000, planned: 1 },
	{ root: 'food_out', label: 'Jollibee', minor: 15_500, planned: 0 },
	{ root: 'stuff', label: 'Soap', minor: 8_000, planned: 1 }
];

/**
 * Create a demo tenant seeded with `DEMO_DAYS` of history.
 *
 * Unscoped only to mint the row — there is no tenant yet, which is what this
 * function is creating. Everything after the insert goes through `forUser()`.
 */
export function createDemoUser(now: Date = new Date()): number {
	const created = unsafeDb
		.insert(schema.appUser)
		.values({
			googleSub: null,
			email: null,
			displayName: 'Demo',
			createdAt: now.toISOString(),
			isDemo: 1
		})
		.returning({ id: schema.appUser.id })
		.get();

	provisionUser(created.id, now);
	seedDemoData(created.id, now);
	return created.id;
}

/** True when this user is a demo tenant. Used to label the app for reviewers. */
export function isDemoUser(userId: number): boolean {
	const row = unsafeDb
		.select({ isDemo: schema.appUser.isDemo })
		.from(schema.appUser)
		.where(eq(schema.appUser.id, userId))
		.get();
	return row?.isDemo === 1;
}

/**
 * Ninety days of periods, transactions, logged days, commitments and one
 * completed review.
 *
 * The figures are invented and the code says so; nothing here is presented as
 * anyone's real spending. What is NOT invented is the shape — weekly periods,
 * a 15% haircut taken off the top, bills reserved rather than spent — because a
 * demo whose numbers do not obey the app's own rules teaches a reviewer the
 * wrong thing about it.
 */
export function seedDemoData(userId: number, now: Date = new Date()): void {
	const { db } = forUser(userId);

	const settings = db.select().from(schema.settings).limit(1).get();
	if (!settings) return;

	const today = now.toISOString().slice(0, 10);
	const start = addDays(today, -DEMO_DAYS);

	// ── Periods, weekly, back to back ──────────────────────────────────────
	const SPEND_ALLOC = 100_000; // ₱1,000 a week
	const allowance = dailyAllowance(
		{ spendAllocMinor: SPEND_ALLOC, days: 7 },
		settings.haircutPct
	);

	let cursor = start;
	const periods: { id: number; startsOn: string; endsOn: string }[] = [];
	while (cursor < today) {
		const endsOn = addDays(cursor, 6);
		const closed = endsOn < today;
		const row = db
			.insert(schema.period)
			.values({
				startsOn: cursor,
				endsOn,
				days: 7,
				spendAllocMinor: SPEND_ALLOC,
				dailyAllowanceMinor: allowance,
				haircutPctApplied: settings.haircutPct,
				phaseAtOpen: 0,
				closedAt: closed ? `${endsOn}T16:00:00.000Z` : null,
				createdAt: `${cursor}T00:00:00.000Z`,
				userId
			})
			.returning({ id: schema.period.id })
			.get();
		periods.push({ id: row.id, startsOn: cursor, endsOn });
		cursor = addDays(endsOn, 1);
	}

	// ── Transactions, with the week's shape repeating and drifting ─────────
	let n = 0;
	for (const p of periods) {
		for (let d = 0; d < 7; d++) {
			const on = addDays(p.startsOn, d);
			if (on >= today) break;

			// Not every day has an entry, and not every entry is the same size.
			// A perfectly regular ledger reads as fake at a glance.
			const perDay = d % 3 === 0 ? 2 : 1;
			for (let i = 0; i < perDay; i++) {
				const shape = WEEK_SHAPE[n % WEEK_SHAPE.length];
				const drift = 1 + ((n % 7) - 3) * 0.06;
				db.insert(schema.txn)
					.values({
						spentOn: on,
						amountMinor: Math.round(shape.minor * drift),
						category: shape.root,
						label: shape.label,
						source: n % 4 === 0 ? 'cash' : n % 4 === 1 ? 'ewallet' : 'card',
						planned: shape.planned,
						periodId: p.id,
						enteredAt: `${on}T21:30:00.000Z`,
						clientUuid: `demo-${userId}-${n}`,
						userId
					})
					.run();
				n++;
			}

			db.insert(schema.logDay)
				.values({
					loggedOn: on,
					entryCount: perDay,
					isCatchup: 0,
					closedAt: `${on}T21:35:00.000Z`,
					userId
				})
				.onConflictDoNothing()
				.run();
		}
	}

	// ── Commitments: one essential, one cullable, one live trial ───────────
	db.insert(schema.subscription)
		.values([
			{
				label: 'Home wifi',
				amountMinor: 75_000,
				cadence: 'monthly',
				nextChargeOn: addDays(today, 9),
				leadDays: 7,
				alertStage: 0,
				isEssential: 1,
				createdAt: now.toISOString(),
				userId
			},
			{
				label: 'Streaming',
				amountMinor: 39_900,
				cadence: 'monthly',
				nextChargeOn: addDays(today, 17),
				cancelByOn: addDays(today, 17),
				leadDays: 7,
				alertStage: 0,
				isEssential: 0,
				createdAt: now.toISOString(),
				userId
			},
			{
				label: 'Notion AI',
				amountMinor: 54_900,
				cadence: 'monthly',
				nextChargeOn: addDays(today, 5),
				trialEndsOn: addDays(today, 5),
				cancelByOn: addDays(today, 5),
				leadDays: 3,
				alertStage: 0,
				isEssential: 0,
				createdAt: now.toISOString(),
				userId
			}
		])
		.run();

	// A weekly laundry service: the varying-amount commitment that has no home
	// in a fixed-price subscriptions table, which is why irregulars exist.
	db.insert(schema.irregular)
		.values({
			label: 'Laundry',
			amountMinor: 20_000,
			isEstimate: 1,
			cadence: 'weekly',
			nextDueOn: addDays(today, 3),
			category: 'stuff',
			paddingPct: 5,
			createdAt: now.toISOString(),
			userId
		})
		.run();
}

/**
 * Delete demo tenants older than `DEMO_TTL_HOURS`.
 *
 * `ON DELETE CASCADE` on every tenanted table does the rest, which is the same
 * mechanism that backs the account-deletion promise in §3.5 — so this job also
 * exercises that path nightly rather than leaving it to be discovered broken on
 * the first real deletion request.
 */
export function reapDemoUsers(now: Date = new Date()): number {
	const cutoff = new Date(now.getTime() - DEMO_TTL_HOURS * 3_600_000).toISOString();

	const doomed = unsafeDb
		.select({ id: schema.appUser.id })
		.from(schema.appUser)
		.where(and(eq(schema.appUser.isDemo, 1), lt(schema.appUser.createdAt, cutoff)))
		.all();

	for (const d of doomed) {
		unsafeDb.delete(schema.appUser).where(eq(schema.appUser.id, d.id)).run();
	}
	return doomed.length;
}

/** How many demo tenants exist right now. Used by the reaper's job detail. */
export function countDemoUsers(): number {
	const row = unsafeDb
		.select({ n: sql<number>`count(*)` })
		.from(schema.appUser)
		.where(eq(schema.appUser.isDemo, 1))
		.get();
	return row?.n ?? 0;
}
