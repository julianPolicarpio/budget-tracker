/**
 * Today quick forms and their owning tabs must be only two entry points to the
 * same panel-form operation. These tests invoke the actual SvelteKit actions
 * so a future route-local validation or write cannot silently drift.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Action = (event: unknown) => Promise<unknown>;

let sqlite: import('better-sqlite3').Database;
let pages: Record<string, Record<string, Action>>;
let accounts: typeof import('./accounts');

const USER = 1;
const OTHER = 2;

function fields(values: Record<string, string>): FormData {
	const body = new FormData();
	for (const [key, value] of Object.entries(values)) body.set(key, value);
	return body;
}

async function invoke(page: string, action: string, values: Record<string, string>, userId = USER) {
	const handler = pages[page]?.[action];
	if (!handler) throw new Error(`Missing ${page} action ${action}`);
	try {
		return await handler({
			request: new Request('http://localhost/', { method: 'POST', body: fields(values) }),
			locals: { userId }
		} as never);
	} catch (error) {
		if (isRedirect(error)) return { redirected: true, location: error.location };
		throw error;
	}
}

function count(table: string, label: string): number {
	return Number(
		(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE label = ?`).get(label) as { n: number }).n
	);
}

beforeAll(async () => {
	process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-quick-parity-')), 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';
	const db = await import('./db');
	sqlite = db.sqlite;
	applyMigrations(sqlite, resolve('migrations'));
	sqlite.exec(`
		INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
			period_kind, week_starts_on, haircut_pct, band_pct, phase, timezone, created_at, user_id)
		VALUES (1, 'PHP', '₱', 2, 1000, 'weekly', 0, 15, 10, 0, 'Asia/Manila', '2026-01-01T00:00:00Z', 1);
		INSERT INTO app_user (id, created_at) VALUES (2, '2026-01-01T00:00:00Z');
		INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
			period_kind, week_starts_on, haircut_pct, band_pct, phase, timezone, created_at, user_id)
		VALUES (2, 'PHP', '₱', 2, 1000, 'weekly', 0, 15, 10, 0, 'Asia/Manila', '2026-01-01T00:00:00Z', 2);
	`);
	accounts = await import('./accounts');
	pages = {
		today: (await import('../../routes/+page.server')).actions as Record<string, Action>,
		accounts: (await import('../../routes/accounts/+page.server')).actions as Record<string, Action>,
		irregulars: (await import('../../routes/irregulars/+page.server')).actions as Record<string, Action>,
		trips: (await import('../../routes/trips/+page.server')).actions as Record<string, Action>,
		subscriptions: (await import('../../routes/subscriptions/+page.server')).actions as Record<string, Action>,
		debt: (await import('../../routes/debt/+page.server')).actions as Record<string, Action>,
		rules: (await import('../../routes/rules/+page.server')).actions as Record<string, Action>
	};
});

describe('quick actions match their owning-tab saves', () => {
	it('persists the same creates from Today and each owning tab', async () => {
		const spend = accounts.createAccount(USER, { name: 'Parity spend', kind: 'spend', institution: null, hasCard: true, isCommitted: false, balanceMinor: 50_000 }, '2026-01-01');
		const bills = accounts.createAccount(USER, { name: 'Parity bills', kind: 'bills', institution: null, hasCard: false, isCommitted: false, balanceMinor: 0 }, '2026-01-01');

		const transfer = { fromAccountId: String(spend), toAccountId: String(bills), amount: '100', fee: '2', movedOn: '2026-02-01' };
		expect(await invoke('today', 'transferMoney', transfer)).toEqual({ transferred: true });
		expect(await invoke('accounts', 'transfer', transfer)).toMatchObject({ redirected: true });
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM transfer t JOIN txn fee ON fee.id = t.fee_txn_id WHERE fee.amount_minor = 200").get()).toMatchObject({ n: 2 });

		const plannedToday = { label: 'Today passport', amount: '5000', cadence: 'one_off', nextDueOn: '2026-12-01', paddingPct: '25', clientUuid: 'planned-today' };
		const plannedTab = { ...plannedToday, label: 'Tab passport', clientUuid: 'planned-tab' };
		expect(await invoke('today', 'createPlannedExpense', plannedToday)).toEqual({ created: true });
		expect(await invoke('irregulars', 'upsert', plannedTab)).toMatchObject({ redirected: true });
		expect(count('irregular', 'Today passport')).toBe(1);
		expect(count('irregular', 'Tab passport')).toBe(1);

		const irregularId = Number((sqlite.prepare("SELECT id FROM irregular WHERE label = 'Today passport'").get() as { id: number }).id);
		const funding = { irregularId: String(irregularId), accountId: String(bills), amount: '50', clientUuid: 'fund-parity' };
		expect(await invoke('today', 'fundPlannedExpense', funding)).toEqual({ funded: true });
		// A repeated request key must replay through the owning action too.
		expect(await invoke('irregulars', 'fund', funding)).toMatchObject({ redirected: true });
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM expense_reservation WHERE client_uuid = 'fund-parity'").get()).toMatchObject({ n: 1 });

		const tripToday = { label: 'Today Tokyo', startsOn: '2026-06-01', endsOn: '2026-06-03', tripTz: 'Asia/Tokyo', currencyCode: 'JPY', currencySymbol: '¥', localMinorUnits: '0', fxRateToHome: '0.38', estimate: '10000', clientUuid: 'trip-today' };
		const tripTab = { ...tripToday, label: 'Tab Tokyo', clientUuid: 'trip-tab' };
		expect(await invoke('today', 'declareTrip', tripToday)).toEqual({ declared: true });
		expect(await invoke('trips', 'declare', tripTab)).toMatchObject({ redirected: true });
		expect(count('trip', 'Today Tokyo')).toBe(1);
		expect(count('trip', 'Tab Tokyo')).toBe(1);

		const billToday = { label: 'Today bill', amount: '1100', cadence: 'monthly', nextChargeOn: '2026-10-22', clientUuid: 'bill-today' };
		const billTab = { ...billToday, label: 'Tab bill', clientUuid: 'bill-tab' };
		expect(await invoke('today', 'quickAddBill', billToday)).toEqual({ added: true });
		expect(await invoke('subscriptions', 'quickAdd', billTab)).toEqual({ added: true });
		expect(count('subscription', 'Today bill')).toBe(1);
		expect(count('subscription', 'Tab bill')).toBe(1);

		const debtToday = { label: 'Today debt', balance: '1000', minPayment: '100', apr: '18', clientUuid: 'debt-today' };
		const debtTab = { ...debtToday, label: 'Tab debt', clientUuid: 'debt-tab' };
		expect(await invoke('today', 'addDebt', debtToday)).toEqual({ added: true });
		expect(await invoke('debt', 'upsert', debtTab)).toMatchObject({ redirected: true });
		expect(count('debt', 'Today debt')).toBe(1);
		expect(count('debt', 'Tab debt')).toBe(1);

		const accountToday = { name: 'Today wallet', kind: 'spend', balance: '0', clientUuid: 'account-today' };
		const accountTab = { ...accountToday, name: 'Tab wallet', clientUuid: 'account-tab' };
		expect(await invoke('today', 'openAccount', accountToday)).toEqual({ added: true });
		expect(await invoke('accounts', 'addAccount', accountTab)).toMatchObject({ redirected: true });
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM account WHERE name IN ('Today wallet', 'Tab wallet')").get()).toMatchObject({ n: 2 });

		const ruleToday = { cue: 'Today cue', action: 'Today action', category: 'adherence', clientUuid: 'rule-today' };
		const ruleTab = { ...ruleToday, cue: 'Tab cue', clientUuid: 'rule-tab' };
		expect(await invoke('today', 'upsertRule', ruleToday)).toEqual({ saved: true });
		expect(await invoke('rules', 'upsert', ruleTab)).toMatchObject({ redirected: true });
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM rule WHERE cue IN ('Today cue', 'Tab cue')").get()).toMatchObject({ n: 2 });

		const savedToday = { label: 'Today headphones', amount: '3000', clientUuid: 'wait-today' };
		const savedTab = { ...savedToday, label: 'Tab headphones', clientUuid: 'wait-tab' };
		expect(await invoke('today', 'addWait', savedToday)).toEqual({ waiting: true });
		expect(await invoke('rules', 'addWait', savedTab)).toMatchObject({ redirected: true });
		expect(count('wait_item', 'Today headphones')).toBe(1);
		expect(count('wait_item', 'Tab headphones')).toBe(1);
	});

	it('returns equivalent validation and rejects selector IDs owned by someone else', async () => {
		const badToday = await invoke('today', 'quickAddBill', { label: 'Bad bill', amount: '10', cadence: 'monthly', nextChargeOn: '' });
		const badTab = await invoke('subscriptions', 'quickAdd', { label: 'Bad bill', amount: '10', cadence: 'monthly', nextChargeOn: '' });
		expect(badToday).toMatchObject({ status: 400, data: { field: 'nextChargeOn', error: 'Give the billing date.' } });
		expect(badTab).toEqual(badToday);

		const foreignSpend = accounts.createAccount(OTHER, { name: 'Other spend', kind: 'spend', institution: null, hasCard: false, isCommitted: false, balanceMinor: 10_000 }, '2026-01-01');
		const ownSpend = accounts.createAccount(USER, { name: 'Own spend', kind: 'spend', institution: null, hasCard: false, isCommitted: false, balanceMinor: 10_000 }, '2026-01-01');
		const foreignTransfer = { fromAccountId: String(foreignSpend), toAccountId: String(ownSpend), amount: '10' };
		expect(await invoke('today', 'transferMoney', foreignTransfer)).toMatchObject({ status: 400, data: { error: expect.any(String) } });
		expect(await invoke('accounts', 'transfer', foreignTransfer)).toMatchObject({ status: 400, data: { error: expect.any(String) } });

		const otherIrregular = Number(sqlite.prepare("INSERT INTO irregular (label, amount_minor, is_estimate, cadence, next_due_on, padding_pct, created_at, user_id) VALUES ('Other planned', 10000, 1, 'one_off', '2026-12-01', 25, '2026-01-01T00:00:00Z', 2)").run().lastInsertRowid);
		const foreignFunding = { irregularId: String(otherIrregular), accountId: String(ownSpend), amount: '10' };
		expect(await invoke('today', 'fundPlannedExpense', foreignFunding)).toMatchObject({ status: 409, data: { field: 'amount' } });
		expect(await invoke('irregulars', 'fund', foreignFunding)).toMatchObject({ status: 409, data: { field: 'amount' } });
	});

	it('replays request keys without duplicate quick-form creates', async () => {
		const retry = async (action: string, body: Record<string, string>) => {
			const first = await invoke('today', action, body);
			const second = await invoke('today', action, body);
			expect(second).toEqual(first);
		};

		await retry('createPlannedExpense', { label: 'Retry planned parity', amount: '1000', cadence: 'one_off', nextDueOn: '2026-12-01', clientUuid: 'parity-retry-planned' });
		await retry('declareTrip', { label: 'Retry trip parity', startsOn: '2026-07-01', endsOn: '2026-07-02', tripTz: 'Asia/Manila', currencyCode: 'PHP', currencySymbol: '₱', localMinorUnits: '2', fxRateToHome: '1', estimate: '1000', clientUuid: 'parity-retry-trip' });
		await retry('quickAddBill', { label: 'Retry bill parity', amount: '100', cadence: 'monthly', nextChargeOn: '2026-10-22', clientUuid: 'parity-retry-bill' });
		await retry('addDebt', { label: 'Retry debt parity', balance: '1000', minPayment: '100', apr: '18', clientUuid: 'parity-retry-debt' });
		await retry('openAccount', { name: 'Retry account parity', kind: 'spend', balance: '0', clientUuid: 'parity-retry-account' });
		await retry('upsertRule', { cue: 'Retry cue parity', action: 'Retry action', category: 'adherence', clientUuid: 'parity-retry-rule' });
		await retry('addWait', { label: 'Retry saved parity', amount: '500', clientUuid: 'parity-retry-wait' });

		expect(count('irregular', 'Retry planned parity')).toBe(1);
		expect(count('trip', 'Retry trip parity')).toBe(1);
		expect(count('subscription', 'Retry bill parity')).toBe(1);
		expect(count('debt', 'Retry debt parity')).toBe(1);
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM account WHERE name = 'Retry account parity'").get()).toMatchObject({ n: 1 });
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM rule WHERE cue = 'Retry cue parity'").get()).toMatchObject({ n: 1 });
		expect(count('wait_item', 'Retry saved parity')).toBe(1);
	});
});
