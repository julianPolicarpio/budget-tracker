# Effect matrix — what every money operation touches

Spec A3.3: "Every operation has defined effects on physical accounts,
purposes/reservations, obligations, spending/income reports, and the daily
guide. Write this effect matrix before migration or implementation."

This document is that matrix. Each row states what the operation does to each
dimension, what must stay untouched, and how failure is handled. Where the
code today does something this matrix forbids, the matrix is the target and
the code is marked for the A9.1 fix.

## The two ledgers

Split keeps two kinds of "how much":

- **Balances** live on `account` rows — the six buckets (inflow, bills, spend,
  irregulars, buffer, grow). A balance is money that physically exists
  somewhere. Every balance change is a row-level move between two accounts or
  an explicit correction; nothing infers a balance from reports.
- **Reservations** (new) live on the reservation ledger — money already inside
  a bucket that is promised to one planned expense. A reservation never moves
  money between buckets; it partitions one bucket's balance. The sum of a
  bucket's reservations can never exceed that bucket's balance, checked
  server-side in the same transaction.

Reports (`txn` rows, settlements, debt payments) are a third, derived thing:
they describe activity. They never feed back into balances.

## Operations

### 1. Log spending (exists — `txn` insert)

| Dimension | Effect |
| --- | --- |
| Physical accounts | None. Logging records activity; it does not move bucket balances. |
| Reservations | None. A reservation is consumed only by its own payment operation. |
| Obligations | None. |
| Reports | One `txn` row: category, planned/unplanned, source, period binding (`openPeriodOn`). Trip rows carry `trip_id` and are excluded from ordinary metrics. |
| Daily guide | Spends against today's band; closes the log day. |

Failure: invalid amount or missing P/U choice refuses before any write.
Duplicate submissions: `client_uuid` idempotency.

### 2. Record income arrival (NEW)

A3.3: "Income records a real arrival in the chosen account." Today nothing
records an arrival — money enters the system only by the user asserting a
balance on the Income account. This operation closes that gap.

| Dimension | Effect |
| --- | --- |
| Physical accounts | +amount on the chosen account (default: the user's Income bucket). |
| Reservations | None. |
| Obligations | None. |
| Reports | None. An arrival is not income *reporting*; `income_source` schedules are untouched and the daily allowance never changes (invariant 10). |
| Daily guide | None. |

Rules: amount > 0, integer minor units, account must be owned. Suggested
allocation ≠ completed allocation (A3.3): the suggestion changes nothing until
the allocation operation runs.

### 3. Move money — bank/e-wallet transfer (exists, extended by A3.1)

| Dimension | Effect |
| --- | --- |
| Physical accounts | −amount on source, +amount on destination, one transaction, one `transfer` row linking both sides. |
| Fee (optional) | A separate linked spending amount with its own explicit paying account, defaulted visibly to the source: one `txn` row (category `other`, note references the transfer) −fee on the paying account. Fee-only spending: the principal is never a `txn`. |
| Reservations | None. Moving money between locations never re-points a purpose (A3.1). |
| Obligations | None. |
| Reports | Principal: none. Fee: one spending `txn`. |
| Daily guide | The fee `txn` counts against the band like any spending — a fee is real spending. The principal never touches the guide. |

Rules: source ≠ destination (reject), amount > 0, both accounts owned.
Same-currency only — cross-currency stays unavailable until an explicit
conversion contract exists. Edits/reversals of a transfer must move both
sides and the fee together or refuse.

### 4. Allocation — "Mark done" (FIXED this session)

| Dimension | Effect |
| --- | --- |
| Physical accounts | −amount on the user's Income (inflow) bucket, +amount on the destination bucket, one transaction, `executed_at` stamped. Balanced move; the six-bucket sum is conserved. |
| Reservations | None. |
| Obligations | None. |
| Reports | None. |
| Daily guide | None. |

Known hazard (documented in code, resolved by A1 reconciliation work): a user
who already hand-updated the destination balance and then ticks gets the
amount twice. The correction operation (op 9) is the way out, not silent
detection.

### 5. Fund planned expense (NEW)

A3.2's two cases:

1. **Move from another purpose** — source bucket −amount, destination bucket
   +amount, plus a reservation row for the expense inside the destination
   bucket. If a real bank move also happened, it is recorded separately as
   op 3 and linked; the allocation is never duplicated.
2. **Assign from money already in the fund** — no bucket movement at all. A
   reservation row is created; the bucket's *unassigned* remainder shrinks
   because the reservation now claims part of its balance.

| Dimension | Effect |
| --- | --- |
| Physical accounts | Case 1 only: balanced move between buckets. Case 2: none. |
| Reservations | +reservation for this expense. Sum of the destination bucket's reservations must stay ≤ its balance — checked server-side, atomically, including concurrent submissions. |
| Obligations | The planned expense (irregular instance) is untouched — funding is not settling. |
| Reports | None. Funding is not spending. |
| Daily guide | None. |

Rules: same money cannot fund two expenses — reservations are per-expense
rows, never percentages of a shared pool. Partial funding allowed. Reducing or
reversing funding releases exactly that reservation. Editing the estimated
cost is not a cash movement. Funding history is written as rows, so the
detail view reads it, it is not reconstructed.

### 6. Pay planned expense (NEW)

| Dimension | Effect |
| --- | --- |
| Physical accounts | −amount on the paying account chosen explicitly at payment time. |
| Reservations | The expense's reservation is consumed up to the payment amount. Underfunded payment is allowed and explicit (overspending is shown, never blocked silently). Overpayment releases nothing extra — there is nothing left to release. |
| Obligations | The planned expense's instance settles via the existing settlement path. |
| Reports | One spending `txn` row (the actual payment), exactly once. |
| Daily guide | Counts against the band like any recorded payment. |

Cancellation: releases the full reservation, settles nothing, writes nothing
to reports.

### 7. Record bill/debt payment (exists for debt; source added)

| Dimension | Effect |
| --- | --- |
| Physical accounts | Target: −amount on the explicit source account chosen at payment time. Current code moves no account balance — the payment reduces only the debt. A9.1 adds the explicit source; until then the matrix records the gap, it does not hide it. |
| Reservations | None (bills are not reservation-backed yet). |
| Obligations | `debt_payment` row; debt balance decreases; `closed_on` when it reaches zero. |
| Reports | None today. A3.3 requires principal/interest/fee splitting rather than treating all payments identically — the schema keeps one amount until the debt model is extended; the matrix flags this as the known simplification. |
| Daily guide | None. |

Credit-card rule (A3.3): a card purchase logged as spending and its later
repayment must not both count as spending. Repayment of recorded card debt is
a balance movement, not a spending `txn`.

### 8. Refund (NEW)

| Dimension | Effect |
| --- | --- |
| Physical accounts | +amount on the account the refund lands in, chosen explicitly. |
| Reservations | None. |
| Obligations | None. |
| Reports | A linked negative `txn` row on the original expense's category — spending goes down; it never appears as earned income. Linked to the original `txn` where one exists. |
| Daily guide | A refund may raise today's remaining band; that is arithmetic, not a reward. |

Rules: sum of refunds on one expense ≤ the expense's amount, validated on
write; partial and repeated refunds allowed within that bound; date effect is
the refund's own date — historical reports are never rewritten.

### 9. Correct recorded balance (exists as `assertBalance`; audit trail NEW)

A3.3: "Updating a recorded balance is a correction with an audit trail, not an
inferred income or expense."

| Dimension | Effect |
| --- | --- |
| Physical accounts | Balance set to the asserted value on one account; a correction row records old value, new value, difference, and when. |
| Reservations | A correction that would leave a bucket's reservations exceeding its new balance refuses and names the reservations in the way — the user releases or re-funds first. No guessed conversion of purpose money (A3.3 last sentence). |
| Obligations | None. |
| Reports | None. A correction is never counted as income or spending, and it does not reapply any earlier transfer the user already reflected by hand (that double-count is the allocation hazard; the correction UI shows the delta explicitly before saving). |
| Daily guide | None. |

### 10. Change budget / allowance (exists — review adjust)

| Dimension | Effect |
| --- | --- |
| Physical accounts | None. A budget change never creates cash. |
| Reservations | None. |
| Obligations | None. |
| Reports | None. Historical transactions and completed review snapshots are never rewritten; a new superseding period starts from its effective date. |
| Daily guide | Forward-only from the effective date. Requires amount, period, and effective date. |

### 11. Settle irregular instance (exists)

| Dimension | Effect |
| --- | --- |
| Physical accounts | −actual on the Irregulars bucket. Known simplification: the SQL clamps at zero (`max(0, …)`) so an underfunded settlement shows zero rather than a negative fund. The matrix records this honestly; changing it is a decision for the reconciliation work, not this phase. |
| Reservations | Once reservation rules land, a settled instance consumes its expense's reservation first, then the bucket remainder. |
| Obligations | Instance → settled with `actual_minor`; next due date advances. |
| Reports | None (settlements are not `txn` rows). |
| Daily guide | None. |

### 12. Trip spending (exists, quarantined)

Trip `txn` rows carry `trip_id`, are excluded from ordinary metrics and the
daily guide, and compare against the trip plan in trip context only
(A4). Leaving a trip back into ordinary spending is explicit.

## Cross-cutting invariants

1. Money is created exactly once — by an income arrival — and destroyed
   never. Every other operation conserves the six-bucket sum, moves money
   between buckets, or corrects a balance with an audit row.
2. Every multi-record operation is one database transaction with an ownership
   check (`owns()`) on every table it touches.
3. Duplicate submits and retries after an uncertain response are idempotent
   (`client_uuid` on entry writes; explicit idempotency keys on new
   operations).
4. Reports never mutate balances; balances never mutate reports.
5. Historical rows are immutable: corrections supersede, they do not rewrite.

## Gaps this matrix declares, with their landing phase

- No income-arrival operation exists (op 2). Schema and idempotency ship in
  migration 0015; the engine and its action land in Phase 2 with the shared
  action catalogue.
- Debt payments move no account balance and have no explicit source (op 7).
  Fixed in A9.1: the payment operation takes an explicit source account.
- `assertBalance` writes no audit trail (op 9). Fixed in A9.1: corrections
  gain a `balance_correction` row; the direct action stays for emergencies.
- Settlement clamps at zero (op 11) — underfunded settlement is invisible.
  Recorded, unchanged this phase; the reconciliation work decides it.
- Transfers carry no fee or linkage (op 3 extension). Fixed in A9.1.
- Refunds (op 8): linkage column ships in migration 0015; the engine and
  action land in Phase 2 with the catalogue.
