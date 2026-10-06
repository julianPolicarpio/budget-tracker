# Contributing to Longhand

Read Part One of `split-combined-spec.md` first. About a third of
this codebase looks like a limitation if you haven't.

## The Today screen is closed

Spec §8.1 lists everything that may appear on `/`:

| #   | Widget                                              | Status          |
| --- | --------------------------------------------------- | --------------- |
| 1.1 | The daily band                                      | built (Phase 1) |
| 1.2 | Log strip (amount → category → planned flag → save) | built (Phase 1) |
| 1.3 | Today's entries, no running total                   | built (Phase 1) |
| 1.4 | Streak — count, 28-cell strip, single-day catch-up  | built (Phase 2) |
| 1.5 | Ripe 72-hour waits                                  | built (Phase 4) |
| 1.6 | Horizon — irregular due within 7 days               | built (Phase 3) |
| 1.7 | Ritual nudge — "weekly review is due"               | built (Phase 2) |
| 1.8 | Pending transfer / tranche release                  | built (Phase 3) |

Widget 1.8 is the only addition Spec §8.1 permits beyond the list, and it earns
it: an unexecuted split means every other number on the screen is describing
money that is not where the app thinks it is.

**Nothing else may be added to this screen.** Not the Spend balance. Not a
period-to-date total. Not "₱X left this week". Not a category breakdown.

The pressure to add "just the Spend balance" will be constant and must lose
every time. The Today screen showing a precise remaining figure is the exact
configuration under which Pocheptsova Ghosh & Huang measured people
_overspending_, while people tracking from memory did not (F5). The app is
deliberately worse at this than its competitors, and that is the product.

This is enforced, not requested. `src/lib/server/withholding.ts` turns a
balance-shaped field on `TodayView` into a compile error naming the field. If
the compiler stopped you, the design is working — put the number on a
REVIEW-class screen instead.

## Invariants

These are the project's standing rules. Violating one needs the user to ask for it
explicitly, in words, not an inference that it would be useful.

1. No balances, category totals or precise remaining figures on DAILY surfaces.
2. `spend_alloc / days_remaining` must not exist for periods. Only
   `spend_alloc / days`, computed once at period open. The one legitimate use
   is `tripDailyFigure()` (Phase 4) and the two functions stay separate, each
   with a comment pointing at the other.
3. No bank, e-wallet or card sync. Ever. CSV import is allowed for the one-time
   90-day calibration only.
4. No per-category budgets. Categories exist for the weekly review.
5. Money is integer minor units. `src/lib/money.ts` is the only module that
   parses or formats it, and even there the parse is done on the digit string.
6. Periods are immutable. A changed split creates a superseding period; it
   never mutates the old row.
7. `projectArrivals()` (Phase 2) is the only path to an allocation. Bi-weekly
   is 26 arrivals a year. Any `× 12` or `÷ 12` on an income figure is a bug.
8. Trip transactions: the local amount is the source of truth, home is derived.
9. All txn-based metrics carry `AND trip_id IS NULL` by default, in the shared
   selector — not as a filter each metric remembers.
10. Single user. No accounts table, no login, no tenancy column. Never bind to a
    public interface.

## The other rule with teeth: the shared txn selector

Every txn-based metric composes from `spendTxns()` in
`src/lib/server/metrics.ts`, and from nothing else. That is not tidiness. In
Phase 3 the trip quarantine — `AND trip_id IS NULL` (Spec §4.5) — is added to
that one function, and every metric inherits it, including metrics written in
month eight by someone who has never read that section.

Write a metric that queries `txn` directly and you have opted that metric out of
the quarantine silently. Two weeks abroad at four times normal spend will then
smear a twelve-week rolling average into uselessness and make a working system
look broken for a quarter.

The quarantine shipped in Phase 3, before Trip Mode exists, precisely so that
this rule was installed while there were three metric queries to fix rather than
fifteen. A test asserts that five trip transactions at four times normal spend
leave the unplanned ratio byte-identical.

Log adherence is the one deliberate exception, and it says so in a comment: trip
days count normally, because the streak's job is to keep the app open.

## What you cannot compute yet stays NULL, and says why

`review.save_rate_bp` is never filled, because income rows do not exist. Two of
the five phase exits return `unevaluable` and name the missing input. Do not
substitute a zero, a placeholder, or a plausible-looking estimate anywhere in
this codebase.

The artefact's only value is that it is true. A metric that is quietly wrong is
worse than one that is visibly missing, and a phase engine that reports "not
yet" when it actually cannot tell will eventually be believed.

## The two allowance functions must never be unified

`dailyAllowance()` and `tripDailyFigure()` sit side by side in
`src/lib/allowance.ts` and are nearly identical. One divides by days in the
period; the other divides by days _remaining_. A future reader will notice and
try to merge them.

That merge is the bug, and it is the worst kind — it silently reintroduces
end-of-period spending acceleration into every period the user ever has, and
nothing fails visibly. The boundary condition is the whole difference: a period
has a next period to borrow from, so spending it to zero is unrecognised debt;
a trip has a hard end and no tomorrow, so drawing the envelope to near-zero on
the last day is the correct outcome. Both functions carry a comment pointing at
the other, and a test asserts `dailyAllowance` is invariant to the day of the
period.

## On a trip, local is the source of truth

`txn.amount_local_minor` is what the user typed. `txn.amount_minor` is derived
from it at the locked rate. Never the other way round: storing home as truth
means a rate correction silently rewrites what the user actually spent.

Two places convert, and **both** need the minor-unit scale factor —
`localToHome()` and `setRate()`. ¥3,800 is 3800 minor units at zero decimals
and ₱1,558.00 is 155800 at two; multiplying by the rate alone is off by 100.
That bug shipped into `setRate()` during Phase 4 and was caught by a test. If
you add a third conversion site, it needs the same factor.

## Never set state and submit in the same tick

Svelte applies state to the DOM asynchronously. A handler that sets a field and
then calls `requestSubmit()` serialises the form as it was _before_ the change:

```ts
entry.planned = '1';
formEl.requestSubmit(); // submits the OLD value
```

This shipped in the desktop overlay's P/U shortcut and recorded `unplanned` for
every entry filed as planned — while the toast, which reads the state object
rather than the form, confirmed "planned" back. Silent, and on the unplanned
ratio, which Method Part VIII calls the most diagnostic number you own.

`await tick()` before submitting. Any new keyboard shortcut that both sets a
value and saves needs the same await.

## The IOU rule is not validation

`recordTransfer()` throws `IouRequired` when money leaves Irregulars, Buffer or
Grow without a note. Do not add a "skip" affordance, a default reason, or a
remember-my-last-answer convenience. The note _is_ the intervention — it comes
from the winning arm of the Drexler trial, and its whole job is to make an
invisible leak into something you read back later. For the same reason, the
Money Map lists open IOUs one by one; summarising them into a count destroys the
mechanism.

## Phasing

Build strictly phase by phase (Spec §13). Do not scaffold later phases while
you're in there — the most likely way this project fails is a large
half-working codebase, and the roadmap exists to prevent exactly that.

Each phase gets its own migration file. Tables for income sources, tranches,
allocations, irregulars, trips, debt, rules and reviews do not belong in
`0001_phase1.sql`.

## Design skills vs this spec

Design skills govern **craft** — typography, spacing, hierarchy, motion,
component quality. This spec governs **density**. Where they conflict, the spec
wins, every time.

A skill will confidently suggest a KPI row or a stat grid on Today. That advice
is correct in general and wrong here. Reject it and note why in the commit, so
the reasoning survives past the moment.

## Before you push

```bash
npm run check   # includes the withholding guard
npm test
npm run build
```
