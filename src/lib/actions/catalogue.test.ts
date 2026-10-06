/**
 * The action catalogue (Spec A2, A6, A7) and the context-builder's
 * Invariant 1 guarantee ("Enforced by type, not by review").
 *
 * The pure catalogue tests (shape, search, route existence) need no
 * database. The Invariant-1 pin test needs a real, seeded, isolated temp
 * database — copied from financial-integrity.integration.test.ts's harness —
 * because the guarantee under test is about what `buildActionContext()`
 * actually returns, not just what its return type says.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';
import {
	ACTION_PILLS,
	CATALOGUE,
	actionById,
	catalogueByGroup,
	searchCatalogue,
	type ActionGroup
} from './catalogue';
// NOT a top-level `import { CONTEXT_KEYS } from './context'`, deliberately.
// `./context` pulls in `$lib/server/db` at module scope, which opens
// `data/split.db` (the LIVE database) the instant it is first imported,
// using whatever `DATABASE_URL` happens to be set at that moment — and a
// static import is evaluated before this file's own `beforeAll` gets a
// chance to point `DATABASE_URL` at a temp directory instead. `./context` is
// imported dynamically inside `beforeAll` below, after `DATABASE_URL` is
// set, exactly like every other `*.integration.test.ts` file in this
// codebase already does, for the same reason. `catalogue.ts` itself only
// takes a type-only `import type { ContextKey }` from `./context`, which is
// erased at build time and carries no such risk.

// ─── Harness: one seeded, isolated temp database for the whole file ───────

type Mod = {
	context: typeof import('./context');
	auth: typeof import('../server/auth');
	irregulars: typeof import('../server/irregulars');
	subscriptions: typeof import('../server/subscriptions');
	trips: typeof import('../server/trips');
	clock: typeof import('../server/clock');
	sqlite: typeof import('../server/db').sqlite;
	schema: typeof import('../server/db').schema;
};

let m: Mod;

/** Fresh user, distinct from the migration-seeded owner (id 1), so this
 * fixture can call `provisionUser()` cleanly instead of fighting the
 * pre-existing rows migration 0003 seeds for user 1. */
const OWNER = 7;
let TODAY = '';

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-catalogue-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('../server/db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));

	m = {
		context: await import('./context'),
		auth: await import('../server/auth'),
		irregulars: await import('../server/irregulars'),
		subscriptions: await import('../server/subscriptions'),
		trips: await import('../server/trips'),
		clock: await import('../server/clock'),
		sqlite: dbMod.sqlite,
		schema: dbMod.schema
	};

	// Every tenanted row's user_id REFERENCES app_user(id) (migration 0008);
	// user 1's row ships with the migration, a fresh id does not.
	m.sqlite.prepare(`INSERT INTO app_user (id, created_at) VALUES (?, 'x')`).run(OWNER);
	m.auth.provisionUser(OWNER, new Date('2026-09-01T00:00:00.000Z'));

	TODAY = m.clock.localToday('Asia/Manila');

	// One row in every slice `buildActionContext()` fills, so the pin test
	// below genuinely iterates all six rather than vacuously passing on
	// empty arrays. (accounts already has the six starter buckets from
	// provisionUser.)
	m.irregulars.createIrregular(OWNER, {
		label: 'Car insurance',
		amountMinor: 500_000,
		cadence: 'annual',
		nextDueOn: m.clock.addDays(TODAY, 200),
		paddingPct: 25
	});

	m.subscriptions.createSubscription(OWNER, {
		label: 'Streaming service',
		amountMinor: 55_000,
		cadence: 'monthly',
		nextChargeOn: m.clock.addDays(TODAY, 10)
	});

	m.sqlite
		.prepare(
			`INSERT INTO debt (label, balance_minor, apr_bp, min_payment_minor, user_id)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.run('Credit card', 1_200_000, 2400, 50_000, OWNER);

	m.trips.declareTrip(OWNER, {
		label: 'Tokyo',
		startsOn: m.clock.addDays(TODAY, 30),
		endsOn: m.clock.addDays(TODAY, 35),
		tripTz: 'Asia/Tokyo',
		currencyCode: 'JPY',
		currencySymbol: '¥',
		localMinorUnits: 0,
		fxRateToHome: 0.38,
		estimateMinor: 2_000_000
	});

	m.sqlite
		.prepare(
			`INSERT INTO txn (spent_on, amount_minor, category, planned, note, period_id, entered_at, client_uuid, refund_of, user_id)
			 VALUES (?, ?, 'food_out', 0, NULL, NULL, ?, NULL, NULL, ?)`
		)
		.run(TODAY, 45_000, `${TODAY}T12:00:00.000Z`, OWNER);
});

// ─── Pure catalogue tests ───────────────────────────────────────────────────

/** Spec A2's table, verbatim: sixteen actions, four groups, in this order. */
const EXPECTED_ORDER: ReadonlyArray<{ label: string; group: ActionGroup }> = [
	{ label: 'Log spending', group: 'Record money' },
	{ label: 'Record income', group: 'Record money' },
	{ label: 'Transfer money', group: 'Record money' },
	{ label: 'Record a payment', group: 'Record money' },
	{ label: 'Record a refund', group: 'Record money' },
	{ label: 'Fund a planned expense', group: 'Set money aside' },
	{ label: 'Move money between purposes', group: 'Set money aside' },
	{ label: 'Add a trip', group: 'Create a plan' },
	{ label: 'Create a planned expense', group: 'Create a plan' },
	{ label: 'Add a bill or subscription', group: 'Create a plan' },
	{ label: 'Add a debt', group: 'Create a plan' },
	{ label: 'Save a purchase for later', group: 'Create a plan' },
	{ label: 'Add an account', group: 'Set up or adjust' },
	{ label: 'Set or change the spending budget', group: 'Set up or adjust' },
	{ label: 'Update a recorded balance', group: 'Set up or adjust' },
	{ label: 'Add or edit a personal rule', group: 'Set up or adjust' }
];

describe('CATALOGUE shape', () => {
	it('has exactly the sixteen A2 actions, with A2 labels and groups, in A2 order', () => {
		expect(CATALOGUE).toHaveLength(16);
		expect(CATALOGUE.map((a) => ({ label: a.label, group: a.group }))).toEqual(EXPECTED_ORDER);
	});

	it('gives every action a unique id', () => {
		const ids = CATALOGUE.map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('only uses valid ContextKeys in needs', () => {
		// `m` is populated by the file's top-level `beforeAll` above, which
		// always completes before any `it()` in this file runs.
		for (const action of CATALOGUE) {
			for (const key of action.needs) {
				expect(
					m.context.CONTEXT_KEYS,
					`${action.id}: "${key}" is not a valid ContextKey`
				).toContain(key);
			}
		}
	});

	it('points every route at something that actually exists on disk', () => {
		for (const action of CATALOGUE) {
			const dir =
				action.route === '/'
					? resolve('src/routes')
					: resolve('src/routes', action.route.replace(/^\//, ''));
			const hasServerFile = existsSync(join(dir, '+page.server.ts'));
			expect(
				hasServerFile,
				`${action.id}: route "${action.route}" has no src/routes${action.route === '/' ? '' : action.route}/+page.server.ts`
			).toBe(true);
		}
	});

	/*
	 * Stronger than the route check above, and the one that actually matters:
	 * a route file existing proves nothing about the named action inside it.
	 * Rename `fund` to `addMoney` on /irregulars and the catalogue silently
	 * points at a form action SvelteKit will 404 — a dead button in the panel,
	 * with every other test in this file still green. Spec A8 requires every
	 * catalogue action to be reachable; this is that requirement, pinned.
	 */
	it('points every formAction at an action that actually exists on that route', () => {
		for (const action of CATALOGUE) {
			if (action.formAction === null) continue;
			const file =
				action.route === '/'
					? resolve('src/routes/+page.server.ts')
					: resolve('src/routes', action.route.replace(/^\//, ''), '+page.server.ts');
			const source = readFileSync(file, 'utf8');
			// Actions are declared as `name: async ({ ... }) => {` inside the
			// exported `actions` object.
			const declared = new RegExp(`^\\s+${action.formAction}: async`, 'm').test(source);
			expect(
				declared,
				`${action.id}: "${action.formAction}" is not an action on ${action.route} — the panel would submit into a 404`
			).toBe(true);
		}
	});

	/*
	 * Spec A5: "Remove implementation terminology and research explanations
	 * from primary UI." The panel renders a dedicated action's `note`, and
	 * `note` used to be the same field as the engineering rationale — so the
	 * open panel showed a user route paths ("/debt has payment"), a backticked
	 * identifier, "See the comment above this entry", and a quoted spec clause.
	 * The two are separate fields now; this keeps them separate.
	 */
	it('never shows implementation terminology in a dedicated action note', () => {
		const forbidden: ReadonlyArray<{ pattern: RegExp; what: string }> = [
			{ pattern: /\//, what: 'a route path or slash' },
			{ pattern: /`/, what: 'a backticked identifier' },
			{ pattern: /\bSpec\b|\bA\d\b/, what: 'a spec reference' },
			{
				pattern: /\boperation\b|\baction\b|\bhandler\b|\bendpoint\b/i,
				what: 'implementation jargon'
			},
			{ pattern: /\bcomment\b|\bredirect\b|\bstep \d/i, what: 'developer instructions' }
		];
		for (const action of CATALOGUE) {
			if (action.behaviour.kind !== 'dedicated') continue;
			const { note } = action.behaviour;
			expect(note.length, `${action.id}: note is empty`).toBeGreaterThan(0);
			for (const { pattern, what } of forbidden) {
				expect(
					pattern.test(note),
					`${action.id}: user-facing note contains ${what} — "${note}"`
				).toBe(false);
			}
		}
	});

	it('gives every dedicated action a developer rationale that is never rendered', () => {
		for (const action of CATALOGUE) {
			if (action.behaviour.kind !== 'dedicated') continue;
			expect(
				action.behaviour.rationale.length,
				`${action.id}: dedicated actions must record WHY they are not a quick form`
			).toBeGreaterThan(0);
		}
	});

	it('groups by catalogueByGroup() in the same fixed order, covering all sixteen', () => {
		const grouped = catalogueByGroup();
		expect(grouped.map((g) => g.group)).toEqual([
			'Record money',
			'Set money aside',
			'Create a plan',
			'Set up or adjust'
		]);
		expect(grouped.flatMap((g) => g.actions)).toEqual(CATALOGUE);
	});

	it('actionById finds a real action and misses an unknown one', () => {
		expect(actionById('log-spending')?.label).toBe('Log spending');
		expect(actionById('not-a-real-id')).toBeUndefined();
	});

	it('surfaces the catalogue money operations as typing-bar pills', () => {
		// The pills are derived from CATALOGUE, so a change to the groups or
		// the operation dedupe would silently reshape the row — pin the five
		// operations that have to survive the derivation. 'log-spending' is
		// absent on purpose (the typing bar already is logging) and
		// 'move-between-purposes' collapses into 'transfer-money' because the
		// two share one operation (route + formAction) today.
		expect(ACTION_PILLS.map((pill) => pill.id)).toEqual([
			'record-income',
			'transfer-money',
			'record-payment',
			'record-refund',
			'fund-planned-expense'
		]);
	});
});

describe('searchCatalogue', () => {
	it('returns everything in catalogue order for an empty or whitespace query', () => {
		expect(searchCatalogue('').map((a) => a.id)).toEqual(CATALOGUE.map((a) => a.id));
		expect(searchCatalogue('   ').map((a) => a.id)).toEqual(CATALOGUE.map((a) => a.id));
	});

	it('matches a label substring, case-insensitively', () => {
		const hits = searchCatalogue('REFUND');
		expect(hits.map((a) => a.id)).toEqual(['record-refund']);
	});

	it('matches a terms entry that is not in the label', () => {
		const hits = searchCatalogue('gcash');
		expect(hits.map((a) => a.id)).toEqual(['transfer-money']);
	});

	it('preserves group order and within-group order for a query spanning several groups', () => {
		// "money" hits four actions across two groups via a mix of label and
		// terms matches: transfer-money (label, Record money), record-refund
		// (terms "money back", Record money), fund-planned-expense (terms "add
		// money", Set money aside), move-between-purposes (label, Set money
		// aside). Alphabetical or relevance-ranked output would reorder these;
		// catalogue order would not.
		const expectedIds = [
			'transfer-money',
			'record-refund',
			'fund-planned-expense',
			'move-between-purposes'
		];
		expect(searchCatalogue('money').map((a) => a.id)).toEqual(expectedIds);
		// Case-insensitivity holds for the same multi-group query too.
		expect(searchCatalogue('MoNeY').map((a) => a.id)).toEqual(expectedIds);
	});
});

// ─── Invariant 1 pin test: uses the seeded temp database from beforeAll ────

describe('Invariant 1 — context.buildActionContext() Selectables carry only id/name/hint', () => {
	const ALLOWED_KEYS = new Set(['id', 'name', 'hint']);

	it('has no forbidden key (balance, amount, total, remaining, ...) in any slice', () => {
		const ctx = m.context.buildActionContext(OWNER);
		const slices: Array<keyof typeof ctx> = [
			'accounts',
			'plannedExpenses',
			'bills',
			'debts',
			'trips',
			'refundable'
		];

		let rowsChecked = 0;
		for (const slice of slices) {
			const rows = ctx[slice];
			expect(rows.length, `${slice} is empty — the fixture should have seeded it`).toBeGreaterThan(
				0
			);
			for (const row of rows) {
				rowsChecked++;
				for (const key of Object.keys(row)) {
					expect(ALLOWED_KEYS.has(key), `${slice} row has forbidden key "${key}"`).toBe(true);
				}
				expect(typeof row.id).toBe('number');
				expect(typeof row.name).toBe('string');
				if ('hint' in row) expect(typeof row.hint).toBe('string');
			}
		}
		expect(rowsChecked).toBeGreaterThan(0);
	});

	it('returns an all-empty context rather than throwing with no userId', () => {
		expect(m.context.buildActionContext(undefined)).toEqual({
			accounts: [],
			plannedExpenses: [],
			bills: [],
			debts: [],
			trips: [],
			refundable: []
		});
	});

	it('returns an all-empty context rather than throwing for a not-yet-set-up user', () => {
		const NOT_SET_UP = 99;
		m.sqlite.prepare(`INSERT INTO app_user (id, created_at) VALUES (?, 'x')`).run(NOT_SET_UP);
		expect(m.context.buildActionContext(NOT_SET_UP)).toEqual({
			accounts: [],
			plannedExpenses: [],
			bills: [],
			debts: [],
			trips: [],
			refundable: []
		});
	});
});
