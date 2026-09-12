/**
 * The phase engine (Spec §4.4, Method Part II).
 *
 * Five phases, each with a machine-checkable exit condition. The engine
 * **proposes**; it never advances on its own. A phase change alters where your
 * money goes, and silently reallocating someone's money is unacceptable
 * regardless of whether the arithmetic is right — so every proposal carries the
 * arithmetic and waits.
 *
 * Downgrades are explicitly non-punitive. Slipping from Phase 2 back to Phase 1
 * is a normal event; the recovery instinct after a setback is itself a
 * documented failure mode (Method Part V), and a UI that treats a slip as
 * failure is what triggers it.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { db, schema } from './db';
import { accountByKind } from './accounts';
import { openPeriodOn } from './rollover';
import type { PhaseChange, Settings } from './db/schema';

export interface PhaseDef {
	n: number;
	name: string;
	exit: string;
	funds: string;
}

export const PHASES: PhaseDef[] = [
	{
		n: 0,
		name: 'Stabilise',
		exit: 'Hold two weeks of spending as a float',
		funds: 'Bills and Spend. Buffer gets a symbolic amount — the smallest number that is not zero.'
	},
	{
		n: 1,
		name: 'Six weeks',
		exit: 'Buffer reaches 6 weeks of take-home',
		funds: 'Buffer takes the largest slice you can hold for 4–8 months. Irregulars fully funded.'
	},
	{
		n: 2,
		name: 'Kill expensive debt',
		exit: 'Nothing above ~10% APR remains',
		funds: 'Buffer drops to a trickle; everything freed goes at debt. Irregulars stays full.'
	},
	{
		n: 3,
		name: 'Deepen',
		exit: 'Buffer reaches 3 months of core expenses',
		funds: 'Buffer to 3–6 months of core expenses. Grow starts in parallel.'
	},
	{
		n: 4,
		name: 'Grow',
		exit: 'Terminal — the escalator is the work now',
		funds: 'Buffer is done. Every income increase splits 50/50 between Grow and Spend.'
	}
];

export type ExitVerdict =
	| { state: 'cleared'; detail: string }
	| { state: 'not_yet'; detail: string }
	| { state: 'unevaluable'; detail: string };

export interface PhaseStatus {
	current: PhaseDef;
	next: PhaseDef | null;
	verdict: ExitVerdict;
	/** A pending proposal awaiting the user's answer, if one exists. */
	proposal: PhaseChange | null;
}

/**
 * Evaluate the current phase's exit condition.
 *
 * Two of the five need subsystems that do not exist yet, and they say so by
 * name rather than returning a plausible-looking false. A phase engine that
 * quietly reports "not yet" when it actually cannot tell is worse than one that
 * admits it.
 */
export function evaluateExit(settings: Settings, today: string): ExitVerdict {
	const money = (m: number) => (m / 10 ** settings.minorUnits).toLocaleString('en-US');

	switch (settings.phase) {
		case 0: {
			const spend = accountByKind('spend');
			const period = openPeriodOn(today);
			if (!spend?.balanceAsOf) {
				return { state: 'unevaluable', detail: 'Assert the Spend balance at review step R1.' };
			}
			if (!period) {
				return {
					state: 'unevaluable',
					detail: 'No open period, so there is no weekly spend rate.'
				};
			}
			const weeklySpend = (period.spendAllocMinor * 7) / period.days;
			const weeks = spend.balanceMinor / weeklySpend;
			const detail = `Spend float ${weeks.toFixed(1)} of 2.0 weeks (${money(spend.balanceMinor)} ÷ ${money(Math.round(weeklySpend))}/week)`;
			return weeks >= 2 ? { state: 'cleared', detail } : { state: 'not_yet', detail };
		}

		case 1: {
			const buffer = accountByKind('buffer');
			if (!buffer?.balanceAsOf) {
				return { state: 'unevaluable', detail: 'Assert the Buffer balance at review step R1.' };
			}
			if (!settings.weeklyTakeHomeMinor) {
				return {
					state: 'unevaluable',
					detail: 'Weekly take-home is not set — run db:init with --take-home.'
				};
			}
			const weeks = buffer.balanceMinor / settings.weeklyTakeHomeMinor;
			// F14: the JPMorgan threshold is 6.2 weeks of take-home for the shock
			// that actually happens, once every 5.5 years — not six months.
			const detail = `Buffer ${weeks.toFixed(1)} of 6.0 weeks (${money(buffer.balanceMinor)} ÷ ${money(settings.weeklyTakeHomeMinor)}/week)`;
			return weeks >= 6 ? { state: 'cleared', detail } : { state: 'not_yet', detail };
		}

		case 2:
			return {
				state: 'unevaluable',
				detail: 'Needs APRs per debt — the debt table arrives in Phase 4.'
			};

		case 3:
			return {
				state: 'unevaluable',
				detail: 'Needs monthly core expenses — Bills is not itemised until income lands.'
			};

		default:
			return { state: 'cleared', detail: 'Phase 4 is terminal. The escalator is the work now.' };
	}
}

export function phaseStatus(settings: Settings, today: string): PhaseStatus {
	const current = PHASES[settings.phase] ?? PHASES[0];
	return {
		current,
		next: PHASES[settings.phase + 1] ?? null,
		verdict: evaluateExit(settings, today),
		proposal: pendingProposal()
	};
}

export function pendingProposal(): PhaseChange | null {
	return (
		db
			.select()
			.from(schema.phaseChange)
			.where(and(isNull(schema.phaseChange.acceptedAt), isNull(schema.phaseChange.declinedAt)))
			.orderBy(desc(schema.phaseChange.id))
			.get() ?? null
	);
}

/**
 * Nightly. Records a proposal when the exit clears — and does nothing else.
 * Idempotent on `(from, to, proposed_on)`.
 */
export function proposePhaseChange(settings: Settings, today: string): PhaseChange | null {
	if (pendingProposal()) return null;

	const verdict = evaluateExit(settings, today);
	if (verdict.state !== 'cleared') return null;

	const to = settings.phase + 1;
	if (to > 4) return null;

	db.insert(schema.phaseChange)
		.values({
			fromPhase: settings.phase,
			toPhase: to,
			proposedOn: today,
			rationale: verdict.detail
		})
		.onConflictDoNothing()
		.run();

	return pendingProposal();
}

export function acceptProposal(id: number, now: Date = new Date()): void {
	db.transaction((tx) => {
		const p = tx.select().from(schema.phaseChange).where(eq(schema.phaseChange.id, id)).get();
		if (!p) throw new Error(`No phase proposal ${id}`);

		tx.update(schema.phaseChange)
			.set({ acceptedAt: now.toISOString() })
			.where(eq(schema.phaseChange.id, id))
			.run();
		tx.update(schema.settings).set({ phase: p.toPhase }).where(eq(schema.settings.id, 1)).run();
	});
}

export function declineProposal(id: number, now: Date = new Date()): void {
	db.update(schema.phaseChange)
		.set({ declinedAt: now.toISOString() })
		.where(eq(schema.phaseChange.id, id))
		.run();
}

/**
 * Move phase by hand, in either direction.
 *
 * A downgrade is a normal event and the copy around this must not treat it as
 * failure — that framing is what produces the next blowout.
 */
export function setPhase(phase: number, today: string, now: Date = new Date()): void {
	const target = Math.min(4, Math.max(0, phase));
	const current = db.select().from(schema.settings).where(eq(schema.settings.id, 1)).get();
	if (!current || current.phase === target) return;

	db.transaction((tx) => {
		tx.insert(schema.phaseChange)
			.values({
				fromPhase: current.phase,
				toPhase: target,
				proposedOn: today,
				rationale: target > current.phase ? 'Moved up by hand' : 'Moved down by hand',
				acceptedAt: now.toISOString()
			})
			.onConflictDoNothing()
			.run();
		tx.update(schema.settings).set({ phase: target }).where(eq(schema.settings.id, 1)).run();
	});
}
