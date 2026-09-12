/**
 * The one number (Method Part II, Spec §6.1).
 *
 * SEE ALSO tripDailyFigure() — Spec §6.1b, arriving in Phase 4 at
 * src/lib/server/trip.ts. That function MUST divide by days *remaining*.
 * This one MUST NOT, and the difference is not a style preference:
 *
 *   A period always has a next period to borrow from, so `remaining ÷ days
 *   remaining` produces the end-of-period spending acceleration that
 *   Pocheptsova Ghosh & Huang measured (F5). A trip has a hard end date and
 *   no tomorrow, so spending its envelope to ~zero on the last day is the
 *   correct outcome. Same arithmetic, opposite meaning.
 *
 * Keep the two functions separate. A future refactor will notice they are
 * nearly identical and try to unify them; that refactor is the bug.
 */

export interface AllowanceInputs {
	/** The frozen allocation from the immutable period row. */
	spendAllocMinor: number;
	/** Days in the WHOLE period — never days remaining. */
	days: number;
}

export interface Band {
	low: number;
	high: number;
}

/**
 * daily_allowance = spend_alloc / days × (1 − haircut)
 *
 * The haircut is the structural safety margin (F5): rather than relying on the
 * user to hold a mental buffer, take it off the top and let it accumulate
 * silently, sweeping to Irregulars at period close.
 *
 * Note the absence of a `daysRemaining` parameter. That absence is the point.
 */
export function dailyAllowance(period: AllowanceInputs, haircutPct: number): number {
	if (period.days <= 0) throw new Error('period.days must be > 0');
	// Integer-first: one rounding, at the end.
	return Math.round((period.spendAllocMinor * (100 - haircutPct)) / (100 * period.days));
}

/**
 * The display band (Spec §4.2). Showing a range rather than a precise figure
 * was one of the five interventions that reduced overspending; a precise
 * "you have ₱84 left" licenses spending to exactly ₱84, and past it.
 */
export function displayBand(
	allowanceMinor: number,
	opts: { bandPct: number; roundingStep: number }
): Band {
	const { bandPct, roundingStep } = opts;
	const step = Math.max(1, roundingStep);

	const low = floorTo((allowanceMinor * (100 - bandPct)) / 100, step);
	let high = ceilTo((allowanceMinor * (100 + bandPct)) / 100, step);

	// A band that collapsed to a single figure is a precise figure, which is
	// the exact thing this function exists to avoid. Widen it by one step.
	if (high <= low) high = low + step;

	return { low: Math.max(0, low), high };
}

export interface TripFigure {
	/** Spend this much today, in the trip's local currency. Precise, not banded. */
	figure: number;
	/** How far past the envelope you already are, if at all. */
	over: number;
	daysLeft: number;
	remaining: number;
}

/**
 * The deliberate inversion (Spec §6.1b).
 *
 * SEE ALSO dailyAllowance() above: that function must NEVER divide by days
 * remaining. This one must. Same arithmetic, opposite meaning, and the
 * difference is the boundary condition:
 *
 *   A period always has a next period to borrow from, so spending it to zero
 *   is a debt you have not recognised yet. A trip has a hard end date and no
 *   tomorrow, so spending the envelope down to near-zero on the last day is
 *   the correct outcome, not a failure.
 *
 * If you are here because you noticed these two functions are nearly
 * identical and want to unify them: that refactor is the bug. Unifying them
 * silently reintroduces the end-of-period acceleration that F5 measured, into
 * every period the user ever has.
 *
 * No haircut. The 15% exists to accumulate a margin that sweeps to Irregulars
 * at period close; a trip has nothing to sweep into, and a padded trip figure
 * just means coming home with money stranded in an envelope you disband. Trip
 * padding lives at the estimate stage instead — the mandatory +25% on the
 * irregular (F10), which is the right place for it.
 *
 * Recomputed each morning rather than fixed, because trip spending is
 * genuinely front-loaded (flights, deposits) and a fixed figure would read as
 * failure on day one and false comfort on day six.
 */
export function tripDailyFigure(
	trip: { envelopeMinor: number; bufferDrawMinor: number; endsOn: string },
	spentSoFarMinor: number,
	today: string
): TripFigure {
	const remaining = trip.envelopeMinor + trip.bufferDrawMinor - spentSoFarMinor;
	const daysLeft = Math.max(1, daysInclusive(today, trip.endsOn));

	if (remaining <= 0) return { figure: 0, over: -remaining, daysLeft, remaining };
	return { figure: Math.floor(remaining / daysLeft), over: 0, daysLeft, remaining };
}

function daysInclusive(from: string, to: string): number {
	const [y1, m1, d1] = from.split('-').map(Number);
	const [y2, m2, d2] = to.split('-').map(Number);
	return (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000 + 1;
}

function floorTo(value: number, step: number): number {
	return Math.floor(value / step) * step;
}

function ceilTo(value: number, step: number): number {
	return Math.ceil(value / step) * step;
}
