/**
 * The settings writer.
 *
 * Deliberately narrow: it writes the settings row and NOTHING else. A change
 * here takes effect at the next period open, because `daily_allowance_minor`
 * is written only when a period is created (invariant 6) and the open
 * period's `haircut_pct_applied` records the rate it was actually frozen
 * against.
 *
 * Recomputing the open period from a new haircut would be the exact failure
 * invariant 2 describes from the other direction: a number that moves under
 * the user during a period they are already spending against.
 */
import { forUser } from './db';
import * as schema from './db/schema';

const PERIOD_KINDS = ['weekly', 'semimonthly', 'monthly'] as const;

export interface SettingsPatch {
	timezone: string;
	currencyCode: string;
	currencySymbol: string;
	minorUnits: number;
	roundingStep: number;
	periodKind: 'weekly' | 'semimonthly' | 'monthly';
	weekStartsOn: number;
	haircutPct: number;
	bandPct: number;
}

export function updateSettings(userId: number, patch: SettingsPatch): void {
	if (!Number.isInteger(patch.haircutPct) || patch.haircutPct < 0 || patch.haircutPct > 100) {
		throw new Error(`haircut must be 0–100, got ${patch.haircutPct}`);
	}
	if (!Number.isInteger(patch.bandPct) || patch.bandPct < 0 || patch.bandPct > 100) {
		throw new Error(`band must be 0–100, got ${patch.bandPct}`);
	}
	if (!Number.isInteger(patch.minorUnits) || patch.minorUnits < 0 || patch.minorUnits > 4) {
		throw new Error(`minorUnits must be 0–4, got ${patch.minorUnits}`);
	}
	if (!Number.isInteger(patch.roundingStep) || patch.roundingStep < 1) {
		throw new Error(`roundingStep must be a positive integer, got ${patch.roundingStep}`);
	}
	if (!Number.isInteger(patch.weekStartsOn) || patch.weekStartsOn < 0 || patch.weekStartsOn > 6) {
		throw new Error(`weekStartsOn must be 0–6, got ${patch.weekStartsOn}`);
	}
	if (!(PERIOD_KINDS as readonly string[]).includes(patch.periodKind)) {
		throw new Error(`periodKind must be one of ${PERIOD_KINDS.join(', ')}, got ${patch.periodKind}`);
	}
	if (!patch.timezone.trim()) {
		throw new Error('timezone cannot be empty');
	}
	if (!patch.currencyCode.trim()) {
		throw new Error('currency code cannot be empty');
	}

	const { db, owns } = forUser(userId);
	db.update(schema.settings).set(patch).where(owns(schema.settings)).run();
}
