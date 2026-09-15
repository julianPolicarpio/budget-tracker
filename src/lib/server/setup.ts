/**
 * First-run setup: the five answers, and the one period row they produce.
 *
 * Everything here exists because `provisionUser()` gives a new user settings
 * and six accounts but no period, and `runRollover()` returns early when no
 * period exists — "a first period is created by hand (Spec §13 Phase 1)".
 * Until now "by hand" meant a shell script hardcoded to `WHERE id = 1`.
 *
 * Invariant 7 governs the figure this produces: the allocation is derived from
 * arrivals that actually land, never typed and never scaled from a rate.
 */
import { forUser } from './db';
import * as schema from './db/schema';
import { daysBetweenInclusive, localToday as localDateIn } from './clock';
import { weekOf } from './week';
import { dailyAllowance } from '$lib/allowance';
import {
	addIncomeSource,
	sustainableIncomeMinor,
	monthlyToWindowMinor,
	waterfall,
	type NewIncomeSource,
	type Waterfall
} from './income';

export type PeriodKind = 'weekly' | 'semimonthly' | 'monthly';

export interface PeriodWindow {
	startsOn: string;
	endsOn: string;
	days: number;
}

/** Last day of the month containing `iso`, as YYYY-MM-DD. */
function endOfMonth(iso: string): string {
	const [y, mo] = iso.split('-').map(Number);
	const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
	return `${y}-${String(mo).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/**
 * The window period #1 covers.
 *
 * Anchored on the boundary CONTAINING today, not on the signup date. `weekOf()`
 * already anchors the weekly review on `week_starts_on`; a period offset from
 * it by however many days the user happened to sign up would make every review
 * window straddle two periods for as long as the account exists. The elapsed
 * days hold no transactions, so nothing is lost by starting behind today.
 */
export function firstPeriodWindow(
	today: string,
	periodKind: PeriodKind,
	weekStartsOn: number
): PeriodWindow {
	if (periodKind === 'weekly') {
		const w = weekOf(today, weekStartsOn);
		return { startsOn: w.startsOn, endsOn: w.endsOn, days: 7 };
	}

	const [y, mo, d] = today.split('-').map(Number);
	const pad = (n: number) => String(n).padStart(2, '0');

	if (periodKind === 'semimonthly') {
		const startsOn = d <= 15 ? `${y}-${pad(mo)}-01` : `${y}-${pad(mo)}-16`;
		const endsOn = d <= 15 ? `${y}-${pad(mo)}-15` : endOfMonth(today);
		return { startsOn, endsOn, days: daysBetweenInclusive(startsOn, endsOn) };
	}

	const startsOn = `${y}-${pad(mo)}-01`;
	const endsOn = endOfMonth(today);
	return { startsOn, endsOn, days: daysBetweenInclusive(startsOn, endsOn) };
}

export interface SetupInput {
	timezone: string;
	currencyCode: string;
	currencySymbol: string;
	minorUnits: number;
	roundingStep: number;
	periodKind: PeriodKind;
	weekStartsOn: number;
	income: NewIncomeSource;
	monthlyBillsMinor: number;
}

export interface SetupResult {
	periodId: number;
	window: PeriodWindow;
	waterfall: Waterfall;
	spendAllocMinor: number;
	dailyAllowanceMinor: number;
}

/** True while the user has no period — the one condition `/setup` exists for. */
export function needsSetup(userId: number): boolean {
	const { db, owns } = forUser(userId);
	const row = db
		.select({ id: schema.period.id })
		.from(schema.period)
		.where(owns(schema.period))
		.get();
	return row === undefined;
}

/**
 * The five answers, the derivation, and period #1 — one transaction.
 *
 * Order matters: the income source must exist before `sustainableIncomeMinor()`
 * can see it, and the settings row must carry the new haircut before the
 * allowance is frozen against it.
 */
export function completeSetup(
	userId: number,
	input: SetupInput,
	now: Date = new Date()
): SetupResult {
	const { db, owns } = forUser(userId);

	if (!needsSetup(userId)) {
		// Periods are immutable (invariant 6). A second run would mean either a
		// duplicate open period or a rewritten one, and both are wrong.
		throw new Error('This account already has a period; setup does not run twice.');
	}

	return db.transaction((tx) => {
		tx.update(schema.settings)
			.set({
				timezone: input.timezone,
				currencyCode: input.currencyCode,
				currencySymbol: input.currencySymbol,
				minorUnits: input.minorUnits,
				roundingStep: input.roundingStep,
				periodKind: input.periodKind,
				weekStartsOn: input.weekStartsOn
			})
			.where(owns(schema.settings))
			.run();

		// Runs on the same better-sqlite3 connection, so it is inside this
		// transaction even though it does not take `tx` — there is one
		// connection and BEGIN applies to it. Called rather than inlined so
		// there is still exactly one place that writes an income source.
		addIncomeSource(userId, input.income, now);

		const settings = tx.select().from(schema.settings).where(owns(schema.settings)).get();
		if (!settings) throw new Error('This account has no settings row; it was never provisioned.');
		const today = localDateIn(input.timezone, now);
		const window = firstPeriodWindow(today, input.periodKind, input.weekStartsOn);

		const expected = sustainableIncomeMinor(userId, window.days);
		const billsForWindow = monthlyToWindowMinor(input.monthlyBillsMinor, window.days);

		// Big bills and the emergency-fund minimum are zero for a brand-new
		// account: nothing has been entered yet. The door badge asks for them.
		const wf = waterfall(expected, billsForWindow, 0, 0);
		const spendAllocMinor = wf.spendMinor;
		const dailyAllowanceMinor = dailyAllowance(
			{ spendAllocMinor, days: window.days },
			settings.haircutPct
		);

		const periodId = tx
			.insert(schema.period)
			.values({
				startsOn: window.startsOn,
				endsOn: window.endsOn,
				days: window.days,
				spendAllocMinor,
				dailyAllowanceMinor,
				haircutPctApplied: settings.haircutPct,
				phaseAtOpen: settings.phase,
				createdAt: now.toISOString(),
				userId
			})
			.returning({ id: schema.period.id })
			.get().id;

		return { periodId, window, waterfall: wf, spendAllocMinor, dailyAllowanceMinor };
	});
}
