/**
 * `panel-forms.ts` — the shared bodies behind the owning routes' forms and
 * Today's quick panel.
 *
 * The whole point of the module is that the two screens cannot drift: one
 * validation path, one set of messages, one op call. These tests pin the
 * failure mapping of every helper (status and body, verbatim) and check that
 * a successful create really writes through to the database.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

let m: {
	sqlite: import('better-sqlite3').Database;
	forms: typeof import('./panel-forms');
	today: typeof import('./today');
	accounts: typeof import('./accounts');
};
const USER = 1;

/** Build a FormData the way a browser posts one: every field a string. */
function form(fields: Record<string, string>): FormData {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return body;
}

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-panel-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';
	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));

	// applyMigrations alone leaves `settings` empty — it is populated at
	// runtime by provisionUser(), not by a migration. Same gap
	// settings-write.test.ts documents.
	dbMod.sqlite
		.prepare(
			`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
			                       period_kind, week_starts_on, haircut_pct, band_pct, phase,
			                       timezone, created_at, user_id)
			 VALUES (1,'PHP','₱',2,1000,'weekly',0,15,10,0,'Asia/Manila','2026-08-01T00:00:00Z',?)`
		)
		.run(USER);

	m = {
		sqlite: dbMod.sqlite,
		forms: await import('./panel-forms'),
		today: await import('./today'),
		accounts: await import('./accounts')
	};
});

function settings() {
	const loaded = m.today.loadSettings(USER);
	if (!loaded) throw new Error('settings row missing — the seeding in beforeAll broke');
	return loaded;
}

describe('transfer', () => {
	it('rejects an unparseable amount with the route’s own message', async () => {
		const result = await m.forms.transfer(
			USER,
			form({ amount: 'lots', fromAccountId: '1', toAccountId: '2' }),
			settings()
		);
		expect(result).toEqual({ fail: [400, { error: 'Enter an amount above zero.' }] });
	});

	it('demands a one-line reason when money leaves Irregulars, Buffer or Grow', async () => {
		const grow = m.accounts.createAccount(
			USER,
			{
				name: 'Grow',
				kind: 'grow',
				institution: null,
				hasCard: false,
				isCommitted: false,
				balanceMinor: 500000
			},
			'2026-09-01'
		);
		const spend = m.accounts.createAccount(
			USER,
			{
				name: 'Spend',
				kind: 'spend',
				institution: null,
				hasCard: true,
				isCommitted: false,
				balanceMinor: 0
			},
			'2026-09-01'
		);

		const result = await m.forms.transfer(
			USER,
			form({ amount: '100', fromAccountId: String(grow), toAccountId: String(spend) }),
			settings()
		);
		if (!('fail' in result)) throw new Error('expected a failure, got a success');
		const [status, body] = result.fail;
		expect(status).toBe(422);
		expect(body.field).toBe('iouReason');
		expect(String(body.error).length).toBeGreaterThan(0);
	});
});

describe('fund', () => {
	it('rejects a blank amount and hands the raw value back to the form', async () => {
		const result = await m.forms.fund(
			USER,
			form({ irregularId: '1', accountId: '1', amount: 'nope' }),
			settings()
		);
		expect(result).toEqual({
			fail: [400, { field: 'amount', error: 'Enter an amount above zero.', rawAmount: 'nope' }]
		});
	});

	it('reports an unknown planned expense as a 409 the same money can be retried with', async () => {
		const result = await m.forms.fund(
			USER,
			form({ irregularId: '424242', accountId: '1', amount: '100' }),
			settings()
		);
		expect(result).toEqual({
			fail: [409, { field: 'amount', error: 'Unknown planned expense.', rawAmount: '100' }]
		});
	});
});

describe('createPlanned', () => {
	it('refuses a cadence the schema does not allow', async () => {
		const result = await m.forms.createPlanned(
			USER,
			form({ label: 'Busted', cadence: 'weekly', amount: '100', nextDueOn: '2026-11-01' }),
			settings()
		);
		expect(result).toEqual({ fail: [400, { error: 'Pick a cadence.' }] });
	});

	it('refuses a next due date that is not a date', async () => {
		const result = await m.forms.createPlanned(
			USER,
			form({ label: 'Busted', cadence: 'monthly', amount: '100', nextDueOn: '2026-10-32' }),
			settings()
		);
		expect(result).toEqual({ fail: [400, { error: 'Next due date must be a real date.' }] });
	});

	it('creates the irregular, defaults padding to 25% and materialises its instances', async () => {
		const result = await m.forms.createPlanned(
			USER,
			form({
				label: 'Renew passport',
				cadence: 'annual',
				nextDueOn: '2026-12-01',
				category: 'not-a-real-category',
				amount: '5000'
			}),
			settings()
		);
		expect(result).toEqual({ ok: true, data: { created: true } });

		const row = m.sqlite
			.prepare(`SELECT id, padding_pct, category FROM irregular WHERE label = ?`)
			.get('Renew passport') as { id: number; padding_pct: number; category: string | null };
		expect(row.padding_pct).toBe(25);
		// An unknown category is stored as null, never invented.
		expect(row.category).toBeNull();

		const instances = m.sqlite
			.prepare(`SELECT COUNT(*) AS n FROM irregular_instance WHERE irregular_id = ?`)
			.get(row.id) as { n: number };
		expect(instances.n).toBeGreaterThan(0);
	});
});

describe('declare', () => {
	it('rejects a malformed start date before anything else touches the db', async () => {
		const result = await m.forms.declare(
			USER,
			form({ label: 'Cebu', startsOn: '2026-10-0', endsOn: '2026-10-10' }),
			settings()
		);
		expect(result).toEqual({ fail: [400, { error: 'Both dates are required.' }] });
	});

	it('rejects a trip that ends before it starts', async () => {
		const result = await m.forms.declare(
			USER,
			form({ label: 'Cebu', startsOn: '2026-10-10', endsOn: '2026-10-01' }),
			settings()
		);
		expect(result).toEqual({ fail: [400, { error: 'It cannot end before it starts.' }] });
	});
});

describe('addDebt', () => {
	it('rejects an APR that is not a percentage', async () => {
		const result = await m.forms.addDebt(
			USER,
			form({ label: 'Card', balance: '1000', minPayment: '100', apr: '601' }),
			settings()
		);
		expect(result).toEqual({ fail: [400, { error: 'Enter the APR as a percentage.' }] });
	});
});

describe('upsertRule', () => {
	it('rejects a category outside RULE_CATEGORIES', async () => {
		const result = await m.forms.upsertRule(
			USER,
			form({ cue: 'Payday', action: 'Move 20% to Grow', category: 'astrology' }),
			settings()
		);
		expect(result).toEqual({ fail: [400, { error: 'Pick a category.' }] });
	});
});

describe('quickAddBill', () => {
	it('rejects a cadence that is not a subscription cadence', async () => {
		const result = await m.forms.quickAddBill(
			USER,
			form({ label: 'Netflix', amount: '549', cadence: 'yearly' }),
			settings()
		);
		expect(result).toEqual({ fail: [400, { field: 'cadence', error: 'Pick how often it bills.' }] });
	});

	it('requires an explicitly chosen cadence', async () => {
		const result = await m.forms.quickAddBill(
			USER,
			form({ label: 'No cadence', amount: '1100', nextChargeOn: '2026-10-22' }),
			settings()
		);
		expect(result).toEqual({ fail: [400, { field: 'cadence', error: 'Pick how often it bills.' }] });
	});

	it('requires a real billing date instead of assuming one cadence from today', async () => {
		const missing = await m.forms.quickAddBill(
			USER,
			form({ label: 'No date', amount: '1100', cadence: 'monthly' }),
			settings()
		);
		const invalid = await m.forms.quickAddBill(
			USER,
			form({ label: 'Bad date', amount: '1100', cadence: 'monthly', nextChargeOn: '2026-02-31' }),
			settings()
		);
		expect(missing).toEqual({ fail: [400, { field: 'nextChargeOn', error: 'Give the billing date.' }] });
		expect(invalid).toEqual({ fail: [400, { field: 'nextChargeOn', error: 'Give the billing date.' }] });
	});

	it('keeps trial end separate from the chosen next billing date', async () => {
		const result = await m.forms.quickAddBill(
			USER,
			form({
				label: 'Trial with later charge',
				amount: '1100',
				cadence: 'monthly',
				nextChargeOn: '2026-10-31',
				freeUntil: '2026-10-01'
			}),
			settings()
		);
		expect(result).toEqual({ ok: true, data: { added: true } });
		expect(
			m.sqlite
				.prepare(
					"SELECT next_charge_on, trial_ends_on, cancel_by_on FROM subscription WHERE label = 'Trial with later charge'"
				)
				.get()
		).toMatchObject({
			next_charge_on: '2026-10-31',
			trial_ends_on: '2026-10-01',
			cancel_by_on: '2026-10-31'
		});
	});

	it('rejects a trial end after the first billing date', async () => {
		const result = await m.forms.quickAddBill(
			USER,
			form({
				label: 'Impossible trial',
				amount: '1100',
				cadence: 'monthly',
				nextChargeOn: '2026-10-01',
				freeUntil: '2026-10-31'
			}),
			settings()
		);
		expect(result).toEqual({
			fail: [400, { field: 'freeUntil', error: 'The trial must end on or before the billing date.' }]
		});
	});
});

describe('openAccount', () => {
	it('rejects a nameless account and echoes the whole form back', async () => {
		const result = await m.forms.openAccount(
			USER,
			form({ name: '   ', kind: 'spend', institution: 'BPI', balance: '500' }),
			settings()
		);
		expect(result).toEqual({
			fail: [
				400,
				{
					field: 'name',
					error: 'Name it something you will recognise.',
					rawName: '   ',
					kind: 'spend',
					rawInstitution: 'BPI',
					hasCard: false,
					isCommitted: false,
					rawBalance: '500'
				}
			]
		});
	});
});

describe('create retries', () => {
	it('does not create the same subscription twice after an uncertain response', async () => {
		const body = form({
			label: 'Retry ChatGPT',
			amount: '1100',
			cadence: 'monthly',
			nextChargeOn: '2026-10-22',
			clientUuid: 'retry-subscription-1'
		});
		const first = await m.forms.quickAddBill(USER, body, settings());
		const second = await m.forms.quickAddBill(USER, body, settings());
		expect(first).toEqual({ ok: true, data: { added: true } });
		expect(second).toEqual(first);
		expect(
			m.sqlite.prepare("SELECT COUNT(*) AS n FROM subscription WHERE label = 'Retry ChatGPT'").get()
		).toMatchObject({ n: 1 });
	});

	it('does not create the same debt twice after an uncertain response', async () => {
		const body = form({
			label: 'Retry Card',
			balance: '1000',
			minPayment: '100',
			apr: '18',
			clientUuid: 'retry-debt-1'
		});
		const first = await m.forms.addDebt(USER, body, settings());
		const second = await m.forms.addDebt(USER, body, settings());
		expect(first).toEqual({ ok: true, data: { added: true } });
		expect(second).toEqual(first);
		expect(
			m.sqlite.prepare("SELECT COUNT(*) AS n FROM debt WHERE label = 'Retry Card'").get()
		).toMatchObject({ n: 1 });
	});

	it('does not create the same personal rule twice after an uncertain response', async () => {
		const body = form({
			cue: 'Retry payday',
			action: 'Move money to Grow',
			category: 'adherence',
			clientUuid: 'retry-rule-1'
		});
		const first = await m.forms.upsertRule(USER, body, settings());
		const second = await m.forms.upsertRule(USER, body, settings());
		expect(first).toEqual({ ok: true, data: { saved: true } });
		expect(second).toEqual(first);
		expect(
			m.sqlite.prepare("SELECT COUNT(*) AS n FROM rule WHERE cue = 'Retry payday'").get()
		).toMatchObject({ n: 1 });
	});

	it('does not open the same account twice after an uncertain response', async () => {
		const body = form({
			name: 'Retry wallet',
			kind: 'spend',
			balance: '0',
			clientUuid: 'retry-account-1'
		});
		const first = await m.forms.openAccount(USER, body, settings());
		const second = await m.forms.openAccount(USER, body, settings());
		expect(first).toEqual({ ok: true, data: { added: true } });
		expect(second).toEqual(first);
		expect(
			m.sqlite.prepare("SELECT COUNT(*) AS n FROM account WHERE name = 'Retry wallet'").get()
		).toMatchObject({ n: 1 });
	});

	it('does not create the same planned expense twice after an uncertain response', async () => {
		const body = form({
			label: 'Retry laptop',
			amount: '50000',
			cadence: 'one_off',
			nextDueOn: '2026-12-01',
			paddingPct: '25',
			clientUuid: 'retry-planned-1'
		});
		const first = await m.forms.createPlanned(USER, body, settings());
		const second = await m.forms.createPlanned(USER, body, settings());
		expect(first).toEqual({ ok: true, data: { created: true } });
		expect(second).toEqual(first);
		expect(
			m.sqlite.prepare("SELECT COUNT(*) AS n FROM irregular WHERE label = 'Retry laptop'").get()
		).toMatchObject({ n: 1 });
	});

	it('does not declare the same trip twice after an uncertain response', async () => {
		const body = form({
			label: 'Retry Manila',
			startsOn: '2026-11-01',
			endsOn: '2026-11-03',
			tripTz: 'Asia/Manila',
			currencyCode: 'PHP',
			currencySymbol: '₱',
			localMinorUnits: '2',
			fxRateToHome: '1',
			estimate: '3000',
			clientUuid: 'retry-trip-1'
		});
		const first = await m.forms.declare(USER, body, settings());
		const second = await m.forms.declare(USER, body, settings());
		expect(first).toEqual({ ok: true, data: { declared: true } });
		expect(second).toEqual(first);
		expect(
			m.sqlite.prepare("SELECT COUNT(*) AS n FROM trip WHERE label = 'Retry Manila'").get()
		).toMatchObject({ n: 1 });
	});

	it('refuses a reused request ID when the charge changes', async () => {
		const first = await m.forms.quickAddBill(
			USER,
			form({ label: 'Retry changed bill', amount: '100', cadence: 'monthly', nextChargeOn: '2026-10-22', clientUuid: 'retry-changed-1' }),
			settings()
		);
		const changed = await m.forms.quickAddBill(
			USER,
			form({ label: 'Retry changed bill', amount: '200', cadence: 'monthly', nextChargeOn: '2026-10-22', clientUuid: 'retry-changed-1' }),
			settings()
		);
		expect(first).toEqual({ ok: true, data: { added: true } });
		expect(changed).toMatchObject({ fail: [409, { error: expect.any(String) }] });
		expect(
			m.sqlite.prepare("SELECT COUNT(*) AS n FROM subscription WHERE label = 'Retry changed bill'").get()
		).toMatchObject({ n: 1 });
	});

	it('refuses one request ID reused for a different create operation', async () => {
		const id = 'retry-cross-operation-1';
		expect(
			await m.forms.quickAddBill(
				USER,
				form({ label: 'Retry cross bill', amount: '100', cadence: 'monthly', nextChargeOn: '2026-10-22', clientUuid: id }),
				settings()
			)
		).toMatchObject({ ok: true });
		expect(
			await m.forms.addDebt(
				USER,
				form({ label: 'Retry cross debt', balance: '100', minPayment: '10', apr: '18', clientUuid: id }),
				settings()
			)
		).toMatchObject({ fail: [409, { error: expect.any(String) }] });
		expect(
			m.sqlite.prepare("SELECT COUNT(*) AS n FROM debt WHERE label = 'Retry cross debt'").get()
		).toMatchObject({ n: 0 });
	});

	it('scopes a request ID to its user', async () => {
		m.sqlite
			.prepare("INSERT INTO app_user (id, created_at) VALUES (2, '2026-09-22T00:00:00Z')")
			.run();
		const body = form({
			label: 'Shared request ID',
			balance: '1000',
			minPayment: '100',
			apr: '18',
			clientUuid: 'retry-shared-user-id'
		});
		expect(await m.forms.addDebt(USER, body, settings())).toMatchObject({ ok: true });
		expect(await m.forms.addDebt(2, body, settings())).toMatchObject({ ok: true });
		expect(
			m.sqlite.prepare("SELECT COUNT(*) AS n FROM debt WHERE label = 'Shared request ID'").get()
		).toMatchObject({ n: 2 });
	});

	it('does not save a wanted purchase twice after an uncertain response', async () => {
		const body = form({
			label: 'Retry headphones',
			amount: '3000',
			clientUuid: 'retry-wait-1'
		});
		const first = await m.forms.addWait(USER, body, settings());
		const second = await m.forms.addWait(USER, body, settings());
		expect(first).toEqual({ ok: true, data: { waiting: true } });
		expect(second).toEqual(first);
		expect(
			m.sqlite.prepare("SELECT COUNT(*) AS n FROM wait_item WHERE label = 'Retry headphones'").get()
		).toMatchObject({ n: 1 });
	});
});
