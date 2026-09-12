/**
 * The withholding layer (Spec §4.2) — enforced by the type system, not by
 * convention, because a convention will not survive six months of you adding
 * "just one useful number".
 *
 *   Surface class          Balances?  Category totals?  Precise remaining?
 *   ──────────────────────────────────────────────────────────────────────
 *   DAILY   (Today, Log)   no         no                no — band only
 *   REVIEW  (all others)   yes        yes               yes
 *
 * Each DAILY-class view module instantiates the guard against its own payload
 * type:
 *
 *   type _guard = Assert<DailySurfaceVerdict<TodayView>>;
 *
 * Adding a field whose name reads like a balance, a total or a remaining
 * figure turns that line into a compile error that names the field.
 *
 * If you are here because the compiler stopped you: this is the design
 * working. A precise remaining figure on the daily surface is the exact
 * configuration under which Pocheptsova Ghosh & Huang measured people
 * overspending (F5). Put the number on a REVIEW-class screen instead.
 */

/** Substrings that mark a field as withheld from DAILY-class surfaces. */
type WithheldWord =
	'balance' | 'remaining' | 'total' | 'spent' | 'sum' | 'budget' | 'available' | 'leftover';

type IsWithheldName<S extends string> =
	Lowercase<S> extends `${string}${WithheldWord}${string}` ? true : false;

/** Every offending key in T, at any depth. `never` when the type is clean. */
export type WithheldKeys<T> = T extends readonly (infer U)[]
	? WithheldKeys<U>
	: T extends object
		? {
				[K in keyof T & string]: IsWithheldName<K> extends true ? K : WithheldKeys<T[K]>;
			}[keyof T & string]
		: never;

/**
 * `true` when the payload is clean; otherwise the offending key names, so the
 * compiler error reads "Type 'spendBalanceMinor' does not satisfy the
 * constraint 'true'" rather than something anonymous.
 *
 * The `[X] extends [never]` form is deliberate — it stops the conditional
 * distributing over a union of offending keys.
 */
export type DailySurfaceVerdict<T> = [WithheldKeys<T>] extends [never] ? true : WithheldKeys<T>;

/** Applied at the use site, where T is concrete. */
export type Assert<T extends true> = T;

// ─── Proof the guard bites ────────────────────────────────────────────────
// If a refactor ever neuters WithheldKeys, the directive below becomes an
// unused-@ts-expect-error error and this file stops compiling. The guard
// therefore tests itself, at build time, with no test runner involved.
interface WithheldSurfaceUnderTest {
	band: { low: number; high: number };
	spendBalanceMinor: number;
}
// @ts-expect-error - a balance on a DAILY-class surface must not compile
type _proof = Assert<DailySurfaceVerdict<WithheldSurfaceUnderTest>>;
