# Longhand — Method & Build Spec

**Doc version:** 1.1, approved overhaul amendment added 2026-09-21 (original method: 2026-08-16).
**Status:** Existing application with an approved, not-yet-implemented overhaul scope. The amendment below specifies the next work; it does not claim that the features already exist.

---

## How to use this document

This is two documents in one, and the order matters.

**Part One — The Method** is the personal-finance system itself, derived from behavioural-science field evidence. It is the _why_. Its numbered findings (**F1**–**F14**, in Method Part I) are cited throughout Part Two as the justification for design decisions.

**Part Two — The Build Spec** is what to build. It assumes Part One and references it constantly.

### If you are an AI coding agent, read this first

1. **Read Part One before writing code.** Roughly a third of Part Two's decisions look like limitations or oversights if you haven't. They are not. "No bank sync," "no live balance," "no category budgets," and "manual entry required" are deliberate, load-bearing, and each traces to a cited study. **Do not helpfully fix them.**

2. **The single most important invariant:** the Today screen must never display an account balance, a category total, or a precise "remaining" figure (Spec §4.2). This is enforced as a type-level guard, not a convention. If you find yourself adding a balance to Today because it would be useful, you have found the thing this design exists to prevent.

3. **Build phase by phase** (Spec §13). Phase 1 is Today + log form + SQLite, and nothing else. Do not scaffold later phases "while you're in there." The most likely failure mode of this project is a large half-working codebase, and the roadmap is structured specifically to prevent it.

4. **When guidance conflicts, this document wins** — over design skills (Spec §8.0), over framework conventions, over what a typical budgeting app does.

5. **Before starting, read Spec §14 (Open Questions).** Five decisions have suggested defaults but are the user's to confirm.

### Reference conventions

| Prefix                     | Means                                        |
| -------------------------- | -------------------------------------------- |
| **F1**–**F14**             | A numbered research finding in Method Part I |
| **Method Part I**–**VIII** | A section of Part One                        |
| **Spec §0**–**§14**        | A section of Part Two                        |

---

# Approved overhaul amendment (2026-09-21)

## A0. Scope, precedence, and status

User-approved direction: make every tab understandable by purpose, give Today quick access to recording and setup, and improve task-specific visualisation. This amendment is the implementation scope, not a completion report. It supersedes older UI restrictions that prevent the actions described here; it does not replace the behavioural method, existing accounting invariants, or unrelated deployment/authentication decisions. Implement in the order in A9, not as a simultaneous rewrite.

The canonical file is this repository-root `split-combined-spec.md`. Older references to `docs/split-combined-spec.md` are stale. Retain existing routes initially; user-facing renaming does not require breaking URLs. Preserve useful existing capabilities and saved data unless a replacement is explicitly specified below.

Non-negotiable constraints:
- Today remains a calm daily screen: no account balances, category totals, precise remaining-spending amount, KPI strip, or dashboard of charts. Its daily guide stays a range.
- No per-category spending budgets, bank sync, automatic bank transfers, or automated transaction import added by this overhaul.
- Money remains integer minor units. Period changes create superseding records; logging income does not silently recalculate an open period's daily allowance. Preserve the existing allocation projection path and trip-currency rules.
- Bank/e-wallet accounts describe where money is held. Purposes and planned expenses describe what it is reserved for. They must not be treated as interchangeable accounts or counted twice.
- Retain the dark-primary direction, keyboard-first operation, and common page frame. Apply antislop during implementation; the spec's density rules take precedence over generic design advice.

## A1. Purpose-first tabs

Each tab must state its main task in one short sentence, make its primary action evident, and explain unfamiliar values where they appear. Secondary controls are disclosed when needed, not deleted.

| Tab / existing route | Purpose and required change |
| --- | --- |
| Today `/` | Log daily spending and start quick actions. Keep spending entry directly accessible and preserve the daily ritual. Add the shared Actions entry point described in A2. |
| Weekly review `/review` | Check the week and prepare for the next. Keep a guided sequence with plain-language explanations, relevant comparisons, and clear next steps. Distinguish recording a change from merely viewing a recommendation. |
| Accounts `/accounts` | Update recorded balances and organise money. Distinguish accounts from purposes, transfers from income/spending, and corrections from new transactions. Show last-updated context and provide dedicated balance reconciliation. |
| Planned expenses `/irregulars` | Prepare for expenses coming later. Replace the Big bills/Irregulars user-facing terminology, provide Add money per expense, and show cost, due date, assigned money, and what is still needed. |
| Bills & subscriptions `/subscriptions` | See upcoming charges and decide what to keep. Clearly distinguish schedules, recorded payments, overdue items, and cancelled/paused plans. A due date is not proof that money was paid. |
| Trips `/trips` | Plan a trip, track its spending, and record its final cost. Separate planned budget, money set aside, actual spending, and settlement. Preserve local-currency entry and isolation from ordinary spending metrics. |
| Debt `/debt` | Track what is owed, record payments, and compare repayment options. Explain annual interest and minimum payments; show projection assumptions and limitations beside comparisons. |
| Trends `/trends` | Understand changes over time. Put meaningful weekly comparisons and spending breakdowns ahead of unexplained metrics. Distinguish missing records from zero spending. |
| Wishlist & rules `/rules` | Save a purchase to reconsider after the waiting period, and manage personal if-then rules. Keep both capabilities; make their separate purposes obvious. Preserve the 72-hour waiting rule. |

## A2. Today and the shared Actions panel

Provide a labelled Actions button on Today and an equivalent entry point on other tabs. Ordinary spending entry must not gain an extra step. Do not copy all management forms into the Today page or show the whole action catalogue permanently.

The searchable panel uses stable, plain-language groups:

| Group | Actions |
| --- | --- |
| Record money | Log spending; Record income; Transfer money; Record a payment; Record a refund |
| Set money aside | Fund a planned expense; Move money between purposes |
| Create a plan | Add a trip; Create a planned expense; Add a bill or subscription; Add a debt; Save a purchase for later |
| Set up or adjust | Add an account; Set or change the spending budget; Update a recorded balance; Add or edit a personal rule |

Choose the action first, then show the relevant form. Payment forms must distinguish a bill, debt, or other supported obligation rather than using an ambiguous subtraction. The relevant tab uses the same form and operation, prefilled with its selected item. Quick edits to an existing item use those same forms after selecting it.

Interaction requirements:
- Minimum required fields first; optional fields expandable. Context is specific to the chosen item, not a dashboard of unrelated figures.
- Save returns to the originating page with a concrete confirmation and optional View item link. Do not redirect automatically to a management tab.
- Creating a trip, planned expense, bill, or debt does not itself record a payment or transfer. Offer funding/payment as an explicit next action where appropriate.
- A short dependent setup step, such as adding an account during a transfer, returns to the unfinished parent form without losing input. No stack of nested dialogs.
- Desktop supports keyboard navigation, visible focus, Escape, and focus restoration. Small screens use a full-screen form when needed, with reachable controls and scrollable content.
- Unsaved work is protected; validation errors retain entered values. Failed submissions show a retry path. Duplicate submissions cannot create duplicate financial records.
- The no-balances rule applies to Today-hosted forms too: account selectors show names, not balance lists. Show entered amounts, plan costs/dates, and operation effects without leaking precise available-to-spend totals. Detailed balance reconciliation opens Accounts. Update a recorded balance from Today opens that dedicated workspace with the account preselected.
- Setting a budget can show its entered amount, effective period, and resulting daily range; it must not show a precise current remaining-spending figure.
- Bulk deletion, full reconciliation, and the full weekly review remain dedicated workflows. Today can link to them rather than compressing them into quick forms.

Expected benefit is a hypothesis to validate: fewer navigation steps without slower ordinary logging or more recording mistakes. Do not describe it as a measured usability improvement before testing.

## A3. Transfers, funding, and financial correctness

### A3.1 Transfer between bank/e-wallet accounts

Transfer money requires source, destination, amount, date, and optional fee/note. A BDO-to-GCash transfer creates one linked operation with equal principal leaving the source and entering the destination. It is neither income nor spending. Reject identical source/destination accounts and invalid amounts. A fee is a separate linked spending amount with an explicit paying account, defaulted visibly to the source. Record both sides and any fee atomically; edits and reversals preserve that linkage.

This flow initially covers same-currency accounts. Cross-currency transfers must not silently assume parity or invent an exchange rate; keep them unavailable until an explicit conversion contract is specified. Existing trip currency support is unaffected.

Confirm that Split records a transfer the user made; it does not move money at the bank. Transfers between locations do not silently change reservations/purposes. A purpose change is a separate explicit operation.

### A3.2 Planned-expense funding

Every planned expense has an Add money action with amount and source. Distinguish:
1. Moving money from another purpose, such as Spending, and assigning it to this expense. Update the source purpose and destination reservation together without changing total owned money. If a real bank transfer also occurred, record it explicitly and link it without duplicating the allocation.
2. Assigning money already held in the planned-expense fund. Reduce its unassigned amount and increase the expense reservation; do not increase the fund/account balance again.

The same money cannot fund multiple expenses. Available-to-assign checks run server-side and atomically, including concurrent submissions. Show the expense's funding history in its detail view. Reducing or reversing funding releases the correct reservation; editing an estimated cost is not a cash movement. Paying the expense consumes the appropriate reservation and records the actual payment once. Handle partial funding, partial payments, overspending, and cancellation explicitly; never silently drop or invent money.

### A3.3 Income, payments, refunds, corrections, and budgets

- Income records a real arrival in the chosen account. Suggested allocation and completed allocation are distinct states. Allocation moves/reserves existing money; it must not create a second arrival.
- Before building new actions, reproduce and resolve the audit concern in `src/lib/server/allocations.ts`: the Mark done path was observed crediting a destination without an obvious source debit. Establish whether the source is cash or a purpose and test the full flow, including a user who already updated their recorded balance. Do not blindly add a debit without resolving the model.
- Bill/debt/planned-expense payments must have an explicit source and target. Credit-card purchases and later repayments must not be counted as spending twice. Split principal, interest, and fees when the model requires it, rather than treating all debt payments identically.
- Refunds link to the original expense where possible; partial and repeated refunds must be validated. They must not appear as new earned income. Define their date/reporting effect in tests.
- Updating a recorded balance is a correction with an audit trail, not an inferred income or expense. Show what will change and do not reapply earlier transfers already represented by that correction.
- Budget setup/adjustment requires the amount, period, and effective date. Changes create superseding periods using the existing allowance rules, never rewrite historical transactions, and never create cash. Preserve completed review snapshots and historical interpretation.
- Every operation has defined effects on physical accounts, purposes/reservations, obligations, spending/income reports, and the daily guide. Write this effect matrix before migration or implementation. Where existing data cannot disambiguate cash and purpose balances, require explicit reconciliation rather than guessing a conversion.

## A4. Task-specific data visualisation

Numbers and relevant actions remain primary. Each visual must answer a named question, use actual recorded data, and include a readable textual equivalent. No decorative charts or KPI rows.

| Area | Question | Visual |
| --- | --- | --- |
| Planned expense detail/list | How much is set aside and what is still needed? | Labelled funded/remaining bar per expense, with cost and due date |
| Planned expenses overview | Which upcoming months need preparation? | Monthly grouping or compact timeline of expected expenses |
| Bills & subscriptions | What is due next, and when are charges clustered? | Upcoming-charge timeline/list with due, paid, and overdue states |
| Trends / Weekly review | How has spending changed? | Comparable weekly bars with period labels, values, and a short explanation |
| Trends | What contributed to the change? | Focused spending breakdown, not category budgets |
| Debt | How do repayment options differ? | Payoff timeline/comparison with total interest and visible assumptions; no unsupported projection |
| Trips | How does recorded spending compare with the trip plan? | Labelled plan-versus-actual progress in trip context, with local/home-currency meaning explicit |

Empty datasets show useful next actions rather than fabricated samples. Sparse/incomplete records are labelled. Comparisons use consistent intervals and explain exclusions, especially trip spending. Future charges and debt projections are estimates, not actual transactions. No permanent financial charts are added to Today.

## A5. Copy, layout, and interaction quality

- Use natural, educated Filipino English, short action-led instructions, and specific buttons such as Add money, Record payment, or Save trip. Avoid accounting jargon or explain it inline when necessary.
- Separate expected, reserved, recorded, paid, and remaining-to-fund amounts in wording. Never call a recommendation completed or a schedule paid.
- Remove implementation terminology and research explanations from primary UI; retain concise help where it answers a real question.
- All tabs share the same visual frame width and height, aligned headers/navigation, and predictable internal scrolling. Equal frame height does not mean forcing content into equal lengths or clipping it. Preserve the existing 46rem sheet direction unless explicitly revised later.
- Retain dense management/review pages and a calm Today page. Use hierarchy, grouping, and purposeful spacing rather than identical cards for everything.
- Validate empty, loading, saving, error, populated, overdue, and long-content states. All controls must work with keyboard and touch, have visible focus, and meet contrast requirements.

## A6. Shared architecture

Build one action catalogue containing labels, searchable terms, required context, and the form/operation mapping. Reuse form components and shared server-side operations from Today and their owning tabs. Do not call one page's action handler from another page or duplicate accounting code across routes.

All mutations require existing authorization/ownership checks, integer-money validation, database transactions where multiple records change, duplicate-submit protection, and auditable linkage. Idempotency must cover retries after an uncertain response, not only disable the button. Return consistent success/error results and invalidate affected accounts, plans, history, and daily/review views without rewriting historical snapshots.

Provide safe corrections or linked reversals. Do not promise a generic Undo for actions whose later dependent records make reversal unsafe. Explain and test those cases. Preserve existing offline behaviour where supported; retries/replays must not duplicate records, and actions not safely supported offline must clearly remain unsaved.

## A7. Risks and mitigations

| Risk | Required mitigation |
| --- | --- |
| Today becomes crowded | One Actions entry point; forms appear only after selection; spending remains direct |
| Too many choices | Stable grouping, plain labels, search; no unpredictable reordering |
| Acting without context | Selected-item details and explicit effect summary before consequential saves |
| Quick setup becomes a wizard | Required fields first, optional detail, preserved drafts, full-page escape route |
| Inconsistent results across tabs | Shared forms, validation, operations, and parity tests |
| Double counting or accidental mutations | Effect matrix, atomic linked operations, idempotency, correction/reversal rules |
| Hidden dependency or incomplete data | Dependent setup with return, explicit reconciliation, no guessed historical money |

## A8. Acceptance and verification

- Every catalogue action is reachable from Today, either as a quick form or an explicitly designated dedicated workflow. Equivalent actions in owning tabs produce identical persisted results.
- Test direct expense logging, income, transfer with/without fees, planned-expense creation/funding/payment, trip creation, bill/debt payment, refund, budget change, dependent account setup, and saved-purchase/rule actions end to end.
- Financial tests cover principal conservation, fee-only spending for transfers, reservation conservation, insufficient/unassigned funds, concurrent writes, duplicate/retried submissions, rollback on failure, partial funding/payment/refund, linked edits/reversals, and card repayment without duplicate expense.
- Prove the allocation fix using a regression test against the full source/destination model. Verify a recorded-balance correction cannot cause the same arrival/transfer to be counted again.
- Prove period immutability, income not mutating daily allowance, no per-category budgets, trip exclusion from ordinary metrics, and currency minor-unit correctness. Include type/UI tests that Today receives/displays no prohibited balances or exact remaining-spending figures.
- Exercise keyboard-only operation, dialog close/back/focus restoration, unsaved work, validation, loading/error states, and double submission. Verify all tabs at 1440px, 390px, and 320px widths and with long content, with no overflow, clipping, unreachable controls, or console errors.
- Every chart's values must reconcile to the same selectors/totals used by its textual representation. Zero data, missing data, and projections must be distinguishable.
- Compare current and revised representative flows for completion steps/time, wrong selections, abandonment, and understanding of the saved result. Treat usability improvements as unproven until observed; do not invent benchmarks or outcomes.
- Use an isolated test database for mutation tests. Back up live data before any migration, provide a rollback path, and verify migration on a copy first. Builds may restart the live launchd service; do not use production data as test fixtures.

## A9. Implementation order and completion boundaries

1. Financial foundation: document the effect matrix; reproduce allocation/balance issues; implement linked transfers, reservation rules, safe corrections, and regression tests. Design and verify any required data migration before exposing new actions.
2. Shared actions: reusable forms/server operations, action catalogue, Today entry point, contextual entry points in owning tabs, dependent setup, and accessibility/error handling.
3. Purpose-first management: Accounts, Planned expenses, Bills & subscriptions, Trips, Debt, Wishlist & rules. Preserve existing features and route compatibility while replacing confusing interactions.
4. Review and visualisation: clear weekly review, meaningful Trends comparisons, then each task-specific visual where its underlying records are reliable.
5. Full verification: financial regression suite, action parity, all-tab interaction/layout tests, representative usability comparison, and a final copy/antislop audit. Update the handoff after each completed phase with real evidence and remaining work.

Spec compilation is complete when this amendment is saved and checked. The application overhaul is complete only when the implementation and A8 checks pass. No application changes are claimed by this amendment.

---

# PART ONE — THE METHOD

_The personal-finance system. Read this first; Part Two is unintelligible without it._

## Method 0 — The one-paragraph summary

Most budgeting advice fails because it asks you to _predict and categorise_ well. The research says humans are bad at both. What humans _are_ good at is spending whatever is sitting in front of them. So the system below does not try to make you a better forecaster. It makes the money physically unavailable before you can spend it, leaves exactly **one account and one daily number** in front of you, and asks for **one 60-second log a day and one 15-minute review a week**. Everything else is automated or ignored.

Five accounts. One number. Four rules. Five rituals. That's the whole thing.

---

## Method Part I — The evidence, and what each finding forces into the design

I'm listing this first because every design decision downstream is a consequence of one of these. If you disagree with a design choice, the argument is with the study, not with me.

### 1. Simple rules beat proper accounting — especially when motivation is low

Drexler, Fischer & Schoar ran an RCT with 1,193 micro-entrepreneurs in the Dominican Republic, randomising them into standard accounting training, rule-of-thumb training, or control, with a 12-month follow-up at 87% retention. The rule-of-thumb group was taught essentially one thing: _keep business cash and personal cash in physically separate drawers, and write an IOU when you move money between them._ That group beat the formal-accounting group on separating cash (+8pp vs 0pp), keeping records (+11pp vs +4pp), and separating accounts (+12pp vs +3pp). Bad-week sales rose ~25% of the mean. Critically, the advantage was **largest for the least educated, least motivated, worst-managed participants**; for sophisticated participants the two approaches tied.

> **Design consequence:** the core of the system is physical separation of money into a handful of accounts, plus a rule for what happens when you move money between them. Not a chart of accounts.

### 2. Defaults and automation dominate willpower by an enormous margin

Madrian & Shea's canonical study of a firm switching 401(k) enrolment from opt-in to opt-out saw participation go from ~37% to ~86% of new hires — a ~50-percentage-point swing from changing nothing but the default. Follow-up work found auto-enrol plans run 25–50pp above opt-in plans reliably. Thaler & Benartzi's _Save More Tomorrow_ went further: participants who pre-committed to escalate their savings rate out of future raises went from a 3.5% to a 13.6% savings rate over 40 months.

> **Design consequence:** the split happens automatically on the day money arrives, by standing instruction. You never make a "should I save this month" decision, because the decision is already made and executed before you see the balance. And your savings rate escalates on a schedule tied to income increases, not to willpower.

### 3. Commitment devices produce large, real savings increases — and low take-up

Ashraf, Karlan & Yin's SEED experiment with 1,777 clients of Green Bank in the Philippines offered a savings account with a self-chosen goal (a date or an amount) that you _could not withdraw from_ until you hit it. No extra interest. Take-up was only 28% — but among those offered it, average savings balances rose **42% at six months and 82% at twelve months**, and this was genuine new saving, not money shuffled from elsewhere.

> **Design consequence:** one of your five accounts must be _deliberately inconvenient_ — a different institution, no linked card, ideally a time deposit or goal-locked product. The friction is the feature. And note the 28% take-up: the reason most people don't do this isn't that it doesn't work, it's that it's uncomfortable at signup. Do it in week one, while motivated.

### 4. Partitioning and earmarking money increases saving

Soman & Cheema ran a 14-week field experiment with 146 low-income construction labourers in rural India, all earning identical wages, with a baseline savings rate of 0.75%. They varied whether the savings target arrived in one sealed envelope or two, and whether the envelope carried a photo of the saver's children. Over 14 weeks: plain/pooled saved 280 rupees; photo/pooled 360; plain/partitioned 377; photo/partitioned 450. Partitioning alone was worth roughly a third more saved. Plain envelopes were opened by 64% of households, photo envelopes by 54%.

> **Design consequence:** split savings across named sub-goals rather than one pooled "savings" pot, and attach a concrete image or name to each. "Buffer" is weaker than "Rent-if-I-lose-my-job". "Travel" is weaker than "Japan, March".

### 5. …but _over_-partitioning your **spending** budget backfires, and so does precise real-time balance info

This is the finding that most budgeting apps get wrong. Pocheptsova Ghosh & Huang, across three field studies and two lab experiments, found that people who tracked spending _from memory_ did not overspend, while people who regularly checked a budgeting app **spent significantly more than they had budgeted**, with the effect concentrating near the end of the budget period. The mechanism: uncertainty makes you keep a safety margin; a precise "you have $84 left" number licenses you to spend to exactly $84 — and past it. Of six fixes they tested, five helped, including showing a _range_ rather than a precise figure and permitting mid-period budget updates. The one that **backfired** was dividing the budget into smaller categories, which gave people mental-accounting excuses.

> **Design consequence:** partition your **savings** finely; keep your **spending** as one undivided pool. Track spending manually with a lag, don't stare at a live balance. Set your daily number **below** the true limit so the safety margin is built in structurally rather than psychologically.

### 6. Manual tracking beats automatic aggregation — for behaviour, not for accuracy

Zhang's two-study paper (app-user data from China plus a US survey) found expense-tracking is associated with a reduced share of discretionary spending, and that the pathway runs through _financial self-awareness_. Crucially, **automated tracking** via bank integration was associated with **lower attention and weaker self-awareness** than active manual recording. The act of typing it in is where the "pain of paying" and the behaviour change live.

Zhang is correlational, though, and this is invariant 3 of ten — so it needs an experiment under it. Soman's rehearsal studies are that experiment. Across two experiments covering five payment mechanisms he varied only the _payment mechanism_ and found that a past payment suppresses the next purchase **only when the mechanism required the consumer to write the amount down**, and only when wealth was depleted immediately rather than on a delay. In Experiment 1 (n = 160), subjects who paid a simulated month of expenses by check rated their purchase intention for an additional discretionary item at M = 3.80, against M = 5.26 for subjects who paid identical amounts by credit card (F(1, 152) = 18.23, p < .001). The recording step is not overhead attached to the intervention; it _is_ the intervention, and a bank feed is precisely the mechanism that removes it.

> **Design consequence:** automate every _transfer_; manually log every _discretionary purchase_. These are opposite instructions on purpose. Automation is for money you've already decided about. Manual entry is for money you're still deciding about. This is also why R1 asks you to **type** four balances the app could compute — the typing is the rehearsal.

### 7. Monitoring your progress works — more so when written down and made visible to someone

Harkin et al.'s meta-analysis of 138 RCTs and 19,951 participants found that prompting people to monitor goal progress improved goal attainment at **d = 0.40**. The effect was larger when progress was **physically recorded** and when it was **reported or made public**. Increased monitoring frequency mediated the effect.

> **Design consequence:** the weekly review must produce a written artefact (a row in a log, a number in a file), and you should send that number to one other human. This single addition is probably the highest-leverage free upgrade in the entire system.

### 8. If-then plans convert intention into action at d = 0.65

Gollwitzer & Sheeran's meta-analysis across 94 independent tests and 8,000+ participants found implementation intentions — "if [specific cue], then I will [specific action]" — improved goal attainment at d = 0.65 over goal intentions alone. The cue must be a detectable event; the response must be specific and start within seconds of the cue.

> **Design consequence:** Method Part V is a list of pre-written if-then rules for each of your predictable failure points. Don't skip it. It's not filler; it's the highest-effect-size intervention on this page.

### 9. Framing the target as a daily amount roughly quadruples uptake — and erases the income gap

Hershfield, Shu & Benartzi tested savings-programme framings on 8,931 new Acorns users. Same money, three framings. Enrolment: **$5/day → 29.9%. $35/week → 10.3%. $150/month → 7.1%.** In the lower-amount replication, $7/week beat $30/month 39.9% to 21.8%. And the kicker: under monthly framing, higher-income users enrolled at three times the rate of lower-income users — under daily framing that gap **disappeared entirely**.

> **Design consequence:** the "One Number" in this system is a **daily** figure, both for the savings target and the spend allowance. Never write your budget as a monthly number on the dashboard, even though you calculate it monthly.

### 10. You will underestimate your spending, and you will forget the irregular stuff entirely

Two separate biases stack here. First, generic optimism: reviewed work finds people underestimate weekly spending by roughly 30%, and about 35% of forecasters miss their savings goal. Second — and worse — Sussman & Alter's "The Exception Is the Rule" shows people systematically exclude _exceptional_ expenses (the wedding gift, the laptop charger, the surprise fee) from their mental budget precisely because each one feels like a one-off, while in aggregate they are perfectly predictable. Documented debiasers: unpacking the prediction into concrete items, predicting _events_ rather than _time periods_, and explicitly recalling atypical past spending.

> **Design consequence:** (a) a dedicated Irregulars account is non-optional; (b) your first budget gets a mandatory **+25% padding** on variable categories; (c) the annual ritual is an _event-by-event_ inventory of irregular costs, not a monthly average.

### 11. Cards make you willing to pay more than cash does

Prelec & Simester found the credit-card premium on willingness-to-pay can run **up to 100%** in real transactions of meaningful value, and concluded it is unlikely to be explained by liquidity constraints alone. It's a psychological effect of decoupling payment from consumption.

> **Design consequence:** discretionary spending comes from a **debit** instrument tied to the Spend account with a hard balance. Credit cards, if used at all, are used only for fixed bills already automated from the Bills account and paid in full — never for discretionary spending.

### 12. Small wins really do generate momentum — but they cost money, so bound the trade-off

Brown & Lahey's lab study (91 undergraduates copying 150 lines arranged ascending, even, or descending) found the ascending arrangement — the debt-snowball analogue — produced significantly faster work (11.08s per cell vs 12.13s even and 12.50s descending, p < 0.02), driven by _post-subgoal motivation_: finishing a small chunk raises self-efficacy for the next one. The authors explicitly caveat that interest-rate differentials can offset the motivational gain, and Hamilton (2023) quantifies the pecuniary cost of this "debt account aversion".

> **Design consequence:** the debt rule in Method Part IV is a hybrid with a numerical switch, not a religion.

### 13. Financial education works — modestly, and it decays

Kaiser, Lusardi, Menkhoff & Urban's meta-analysis of **76 RCTs across 32 countries and 160,000+ participants** found financial education improves financial knowledge by 0.204 SD and downstream behaviour by 0.100 SD — 3.6 to 5.5 times larger than the pessimistic 2014 Fernandes, Lynch & Netemeyer estimate of 0.018 SD, which rested on only 13 RCTs. Effects decayed from 0.099 to 0.071 SD after six months but stayed significant. **Saving and budgeting behaviours showed the most robust results.** Median dose: 7 hours.

> **Design consequence:** knowing this system is worth roughly a tenth of a standard deviation of behaviour change and it **fades in about six months**. Hence the quarterly audit in Method Part III — it is a booster shot, not bureaucracy.

### 14. The right emergency-fund target is smaller and more precise than "six months"

The JPMorgan Chase Institute's _Weathering Volatility 2.0_ modelled a simultaneous income dip and expense spike — an event that hits a typical family roughly **once every 5.5 years** — and found families need about **6.2 weeks of take-home income** in liquid assets to absorb it. **65% of families lack that buffer.** For context, the Federal Reserve's 2025 Survey of Household Economics and Decisionmaking found 63% of US adults could cover a $400 emergency with cash or equivalent, and 55% had three months of expenses set aside — both flat year-on-year and below the 2021 peak of 59%.

> **Design consequence:** the first savings milestone is **six weeks of take-home**, not six months. It's achievable, it's the empirically-derived threshold for the actual shock that actually happens, and hitting it early produces the post-subgoal motivation from finding #12.

---

## Method Part II — The architecture

### The five accounts

You need five _destinations_. Whether they're five separate banks, or three banks and two named sub-wallets inside one app, doesn't matter — what matters is that each has its own balance you can see independently and that moving money between them requires a deliberate act.

| #   | Account           | What lands here                              | What leaves here                                | Card attached?                       |
| --- | ----------------- | -------------------------------------------- | ----------------------------------------------- | ------------------------------------ |
| 1   | **INFLOW**        | 100% of all income, always                   | Automated transfers to 2–5, on arrival day      | **No**                               |
| 2   | **BILLS**         | Fixed, contractual, same-every-period costs  | Auto-debits only                                | No (or one credit card paid in full) |
| 3   | **SPEND**         | Your discretionary allowance                 | Everything you actually decide to buy           | **Yes — debit only**                 |
| 4   | **IRREGULARS**    | The monthly slice of your annual lumpy costs | Only when a listed irregular actually comes due | No                                   |
| 5   | **BUFFER / GROW** | Emergency fund, then long-term goals         | Only under the Rule of Four                     | **No — deliberately inconvenient**   |

Notes on each:

**1. INFLOW** is a pass-through. Its balance should be near zero for most of the period. Its only job is to be the single point where the split happens, so that the split is one automation rather than N. Students with several income sources (allowance, part-time work, freelance, occasional gifts) benefit most from this — it collapses "irregular income" into a single predictable event.

**2. BILLS** holds only costs that are contractual and stable: rent, tuition instalment, phone plan, transit pass, insurance premium, subscriptions, minimum debt payments. If a cost varies by more than ~15% period to period, it does _not_ live here — it lives in Irregulars with a padded estimate. The point of Bills is that you never think about it. If you find yourself thinking about Bills, something is misfiled.

**3. SPEND** is the _only_ account you look at day to day. Food out, groceries, coffee, transport beyond the pass, clothes, entertainment, gifts, impulse everything. **It is deliberately not subdivided** (finding #5). One pool, one number.

**4. IRREGULARS** is the account that separates people who "budget" from people whose budget survives contact with reality. It receives 1/12 of every annual cost every month (or 1/52 weekly), so the cost is already paid for when it arrives. This is the direct countermeasure to finding #10.

**5. BUFFER / GROW** is the commitment account (finding #3). Different institution. No debit card. Ideally a product with a withdrawal delay or a goal lock. Once the buffer milestone is hit, this account's _inflow_ redirects to long-term goals while the buffer principal stays untouched.

### The one number

On the dashboard, in your head, on your lock screen, there is exactly one figure:

```
DAILY SPEND ALLOWANCE = (SPEND allocation for the period) ÷ (days in the period) × 0.85
```

Three things about that formula:

- It's **daily** because daily framing quadrupled savings uptake and eliminated the income gap (finding #9).
- The **× 0.85** is the structural safety margin. Finding #5 showed that a precise live balance gets spent to the last unit and then past it. Rather than relying on you to hold a mental buffer, we take 15% off the top and let it accumulate silently. What's left over at period end sweeps to Irregulars.
- It's computed from the **allocation**, not from the current balance. You never do "balance ÷ days remaining", because that's the exact end-of-period acceleration the app study documented.

Display it as a **range** where possible — "spend around 400–450 today" — not a precise remaining balance. That was one of the five interventions that reduced overspending.

### The split percentages

Do **not** start with 50/30/20. That ratio comes from Warren & Tyagi's _All Your Worth_ and is a reasonable _destination_ for a mid-career earner with stable housing costs, but as a _starting point_ it's wrong for most students (whose "needs" often exceed 50% because housing and tuition dominate a small income) and wrong for high earners (whose "wants" shouldn't need 30%).

Instead, calibrate from your own last 90 days, then move toward a target on a ladder. Your starting split is simply _what you actually did_, with the padding applied. Your target split is determined by which phase you're in:

**Phase 0 — Stabilise** _(you have less than 2 weeks of spending in liquid cash)_
Everything to Bills and Spend. Irregulars gets a token amount. Buffer gets a **symbolic** amount — the smallest number that isn't zero. It is not about the money; it's about establishing the automation and getting one subgoal completion (finding #12). Exit when you hold two weeks' spending as a float.

**Phase 1 — Six weeks** _(the JPMorgan threshold)_
Buffer gets the largest slice you can hold for 4–8 months. Irregulars gets its full computed amount — do not shortchange this, or Buffer will get raided. High-interest debt gets minimums only. Exit when Buffer = 6 weeks of take-home.

**Phase 2 — Kill expensive debt**
Buffer contributions drop to a trickle; everything freed goes to debt using the rule in Method Part IV. Irregulars stays fully funded. Exit when everything above ~10% APR is gone.

**Phase 3 — Deepen**
Buffer to 3–6 months of _core_ expenses (Bills + a lean Spend, not your full lifestyle). Begin Grow allocations in parallel.

**Phase 4 — Grow**
Buffer is done and stops receiving money. Its allocation moves wholesale to Grow. Apply the _Save More Tomorrow_ escalator: **every income increase is split 50/50 between Grow and Spend** before it ever touches your daily number. This is the mechanism that took people from 3.5% to 13.6% (finding #2) and it's the single highest-value habit in Phase 4.

### The category taxonomy — deliberately short

You log spending against **eight** categories. Not forty. Finding #5 showed that finer categories give you mental-accounting excuses; finding #1 showed simple heuristics beat detailed bookkeeping.

1. **Food-in** (groceries, cooking)
2. **Food-out** (restaurants, delivery, coffee, snacks)
3. **Transport**
4. **Study/Work** (books, software, tools, materials, printing)
5. **Health** (medicine, appointments, fitness)
6. **Social** (gifts, going out, shared costs)
7. **Stuff** (clothes, gadgets, household)
8. **Other**

Four notes:

- **Food-in and Food-out are split** because that boundary is the single most reliably actionable variance in most people's budgets. Everything else is merged.
- Categories exist for the **weekly review**, not for the daily log. You do not budget per category. You do not get to say "I'm under on Transport so I can overspend on Food-out." One pool.
- Every entry gets a binary flag: **planned / unplanned**. Over a few weeks your unplanned ratio becomes the most diagnostic number you own — it's the direct measure of finding #10 operating on you.
- Bills and Irregulars entries are _not_ logged manually. They're already decided. Logging them dilutes the attention that makes manual tracking work (finding #6).

---

## Method Part III — The rituals

Five cadences. Total time cost: **~25 minutes a week, ~2.5 hours a quarter.** Compare that to the median 7-hour dose in the education meta-analysis (finding #13) — you'll exceed it in the first three months and, unlike a one-off course, you won't decay, because the quarterly audit re-boosts.

### Daily — the 60-second log

**When:** a fixed anchor event, not a time. "After I brush my teeth at night." Time-based cues are weaker than event-based cues.

**What:** open the log. For each Spend-account purchase today: amount, one of eight categories, planned/unplanned flag. That's it. No notes, no receipts, no reconciliation.

**Manual entry is the point** (finding #6). If your tool auto-imports transactions, you must still touch each one to categorise and flag it. An auto-categorised transaction you never looked at produces no self-awareness and therefore no behaviour change.

**If you spent nothing:** you still open it and log a zero. The streak is a monitored progress artefact (finding #7). Breaking the streak is what kills this system, and a zero-spend day is the cheapest possible way to keep it alive.

### Weekly — the 15-minute money date

**When:** a fixed slot with a name. Sunday evening is the standard because it precedes the week it governs.

**Do these six things, in order, in 15 minutes:**

1. **Log the four balances** (Spend, Irregulars, Buffer, and total debt) as a written row. Physical recording was a moderator in Harkin et al. — writing the number down is doing work that thinking about the number does not do.
2. **Compute this week's actuals** per category and the **unplanned ratio** (unplanned spend ÷ total spend).
3. **Look at the top three transactions.** Not the total — the top three. Ask one question of each: _would I do that again?_ Three answers, no analysis paralysis.
4. **Check the week ahead for irregulars.** Anything on the calendar that costs money? Move it from Irregulars to Spend now, tagged, so it doesn't eat the daily allowance.
5. **Adjust the daily number if needed.** Mid-period adjustment was one of the interventions that reduced overspending (finding #5) — a budget you're allowed to update is a budget you don't abandon.
6. **Send the number to your person.** One line, one other human: _"Week 12: spent X, unplanned ratio 22%, buffer at 3.1 weeks."_ This is the public-reporting moderator from finding #7 and it is free.

### Monthly — the 30-minute reconcile

1. Verify every automated transfer actually fired. They fail silently more often than you'd think.
2. Re-run the split. Did income change? Recompute allocations and the daily number.
3. Sweep the Spend surplus (that accumulated 15%) into Irregulars.
4. Update the Irregulars ledger: what came due, what's coming, is the balance tracking the schedule?
5. Trend check: three-month rolling average per category. Single months are noise.
6. One question: **which single category, if it moved 10%, would change my trajectory the most?** Pick one target for next month. One.

### Quarterly — the 90-minute audit

This exists because financial-education effects decay measurably after six months (finding #13).

1. **Re-derive** the whole split from actual last-90-days data instead of last quarter's assumptions.
2. **Phase check.** Have you cleared this phase's exit condition? Move up. Have you slipped? Move down without drama.
3. **Subscription and recurring cull.** List every recurring charge. For each: used in the last 30 days? If no, cancel now, in this session, not later.
4. **Rate check.** Is the Buffer account still competitive? Is there a better commitment product?
5. **Failure-mode review.** Read Method Part V. Which if-then rules fired? Which ones didn't work? Rewrite them — the cue was probably too vague.
6. **Re-earmark.** Rename the savings goals to whatever you actually want now (finding #4 — the concrete label is doing work).

### Annually — the irregulars rebuild

The one ritual that most determines whether the system survives its second year.

Do **not** estimate a monthly average. Sussman & Alter's finding is that averaging is exactly how exceptional expenses vanish from a budget. Instead, walk the calendar **event by event**:

- Insurance premiums, licences, renewals, registration fees
- Tuition, enrolment, exam fees, textbooks, lab fees, thesis printing
- Tax payments, professional dues, certifications
- Birthdays (list the actual people), holidays, weddings, funerals
- Annual software and subscriptions billed yearly
- Device replacement — assume a phone every 3 years, a laptop every 4, and divide
- Medical: annual check-up, dental, prescriptions, one unplanned illness
- Home/vehicle maintenance, one repair you can't name yet
- Travel: trips home, one trip you'll want to take

Sum it. **Add 25%** for the ones you didn't think of — this is the documented magnitude of the underestimate, and every year you'll find the padding was needed. Divide by 12 (or 52). That's the Irregulars allocation, and it is not negotiable downward.

---

## Method Part IV — The four rules

These are the heuristics that replace judgement. Following finding #1, they're short enough to hold in memory without a reference.

### Rule 1 — Split on arrival

Money is allocated the day it lands, by standing instruction, before you have seen the balance. If an automatic transfer isn't possible (cash allowance, cash tips), you execute the split **manually within 24 hours** — and if it's physical cash, physically separate it, because that was literally the intervention that worked in the Drexler et al. trial.

_For irregular income:_ you cannot fix a percentage to an unknown amount, so fix the **order** instead. Every arrival, in sequence: Bills to full → Irregulars to full → Buffer minimum → remainder to Spend, and the daily number is recomputed until the next expected arrival. Once you have three months of history, take your **lowest** month as your baseline income, budget to that, and treat everything above it as a windfall governed by Rule 4.

### Rule 2 — One spending account, debit only

Every discretionary decision draws from Spend, on a debit instrument, against a real balance. No credit card for discretionary purchases — the willingness-to-pay premium runs up to 100% (finding #11). If a purchase can't come from Spend, it isn't a spending decision; it's a _plan change_, which means it goes through Rule 4.

### Rule 3 — Every transfer out of savings needs an IOU

Directly from the winning arm of the Drexler trial. If you move money out of Irregulars or Buffer, you write a one-line note: **date, amount, why, and the date it's coming back.** No approval needed. No guilt. Just the note.

The note is the entire mechanism. It converts an invisible leak into a visible, countable event, and at your quarterly review you will read a list of them. Most people find that seeing four IOUs in a row does more than any rule prohibiting the transfer would have.

### Rule 4 — The 72-hour rule, and the windfall split

**For any unplanned purchase above your daily allowance:** wait 72 hours. Write it on a list with the date. If you still want it after 72 hours and it fits, buy it — from Spend, guilt-free. Most items die on the list. The ones that survive are genuinely wanted, and you get them without the cognitive cost of having resisted.

**For any unexpected income** — bonus, gift, refund, 13th cheque, a good freelance month: split it **50% to whatever the current phase is funding, 50% to Spend**, immediately, before it's in your head as spendable. Not 100% to savings — that's the rule people break, and breaking one rule tends to take the others with it. Fifty percent is the rate people actually sustain.

### The travel sub-rule

A trip is the purest test of this system, because it is the canonical exceptional expense: perfectly predictable in aggregate, and systematically excluded from budgets because each individual trip feels like a one-off (finding #10). It also arrives with the pain of paying at its weakest — unfamiliar currency and heavier card use working against you simultaneously (finding #11). So travel is where you need the _most_ structure at exactly the moment it feels like the moment to relax.

The rule is one sentence:

> **A trip is not a spending period. It is a funded irregular being drawn down.**

Trip money never touches your daily Spend allowance. It comes from Irregulars, where it has been accruing since the last annual rebuild, and it lives in its own envelope for the duration.

**Before — the funding check.** No later than the day you book, the trip enters the Irregulars list as a one-off with a date and an estimate, padded 25% like everything else. If it isn't fully funded by departure, you have exactly three honest options: shorten it, downgrade it, or take the shortfall from Buffer _with an IOU_ (Rule 3) and a repayment date. What you do not do is let it silently eat the next two months of Spend, which is what happens by default and is why post-holiday months feel inexplicably tight.

**During — the envelope, not the allowance.** Compute a trip daily number: `envelope ÷ days`, recomputed each morning against what's actually left. This is the _one_ place where dividing by days-remaining is correct rather than dangerous. The usual objection (finding #5) is that a precise remaining balance licenses you to spend to the limit and past it — but a trip has a hard end date and no next period to borrow from, so spending the envelope down to near-zero on the last day is the right outcome, not a failure. The boundary condition is genuinely different, so the formula flips meaning.

Log in the local currency at one exchange rate fixed on day one. Do not chase the daily rate. Over a two-week trip the drift is under a couple of percent and it will not change a single decision you make.

**After — settle and recalibrate.** Within a week of getting back, record what the trip _actually_ cost against what you estimated. This single number is the most valuable calibration data you will ever generate, because travel is where your estimation error is largest and most visible. Feed it into next year's estimate. Then resume normal periods.

**And the data-hygiene rule that matters more than it sounds:** trip spending is tagged and **excluded from your ongoing metrics** — the unplanned ratio, the category averages, the rolling trends. Not because it doesn't count, but because two weeks at four times your normal spend will smear your three-month averages into uselessness and make the system look broken for a quarter. Trips are measured against their own envelope. Everything else is measured against your actual life. Keep the two ledgers separate and both stay legible.

**Note on longer stays.** Anything past roughly six weeks — a semester abroad, a long posting — is not a trip and this rule does not apply. That is a new cost of living, which means closing the period, re-running the 90-day calibration from scratch against local prices, and re-entering the phase ladder wherever the new numbers put you. Trying to model a relocation as a very large envelope is how people discover four months later that they've been quietly draining their buffer.

### The debt sub-rule

You have both a mathematically optimal order (highest interest rate first — avalanche) and a motivationally optimal order (smallest balance first — snowball, supported by the post-subgoal motivation finding, #12). Use this switch:

> Compute the **total extra interest** the snowball order costs you versus the avalanche order over the full payoff. If that number is **less than one month of your Spend allocation**, use the snowball — buy the motivation, it's cheap. If it's more, use the avalanche, but carve out **one** exception: pay off your single smallest balance first regardless, to bank one subgoal completion, then switch to strict avalanche.

This is the honest version of a debate that's usually argued as ideology. The motivational effect is real and measured; so is its cost. Price it, then choose.

---

## Method Part V — Failure modes, as if-then plans

Implementation intentions run at d = 0.65 (finding #8), which is larger than almost anything else in this document. The format matters: the **cue must be a concrete detectable event**, and the **action must be specific and start immediately**. Copy these, edit the specifics to your life, and keep them where you'll see them.

**Adherence failures**

- _If I miss the daily log two nights in a row, then the next morning I log one combined entry for both days and do not attempt to reconstruct details._
  (Two missed days is where systems die — not from the missing data, but from the guilt of the backlog. Pre-authorising a lossy catch-up is what keeps the streak alive.)
- _If I miss a weekly money date, then I do a 5-minute version — balances and unplanned ratio only — within 24 hours._
- _If I have logged nothing for a full week, then I skip all backfill, reset the streak to zero, and start tonight._

**Overspending failures**

- _If I'm about to buy something over my daily allowance that isn't on my calendar, then I add it to the 72-hour list and close the app/leave the shop._
- _If my Spend balance hits zero before the period ends, then I move exactly one day's allowance from Irregulars, write the IOU, and repay it from next period's Spend._
  (Note it comes from Irregulars, not Buffer. Buffer is for emergencies. Running out of pocket money is not an emergency.)
- _If I'm shopping while tired, hungry, upset, or drinking, then I buy only what's on the list I wrote before leaving._
- _If a "sale" or "limited time" framing is what's making me want it, then it goes on the 72-hour list automatically, no exceptions._

**Structural failures**

- _If an unexpected bill arrives, then before paying it I check whether it belongs on the Irregulars list, and if it does I add it there in the same sitting._
- _If my income changes by more than 10%, then I re-run the full split within 48 hours rather than waiting for the monthly._
- _If I get a raise, allowance increase, or new income source, then 50% of the increase goes to the current phase's target before I ever see it in Spend._
- _If a subscription renewal notice arrives, then I decide right then — keep or cancel — and never "decide later"._

**Social failures**

- _If friends propose something I can't afford this week, then I say "I'm out this week, but I'm in for [specific alternative date/cheaper thing]" — a counter-offer, not a refusal._
  (Budgets fail socially far more often than they fail arithmetically. Having the sentence pre-written is most of the battle.)
- _If someone asks to borrow money, then I answer with a specific figure I'm willing to treat as a gift, or "I can't this time" — never an open-ended yes._

**Travel failures**

- _If I book a trip, then before I close the booking tab I add it to Irregulars with a padded estimate and a date._
  (The booking moment is the only reliable cue. An hour later the trip exists emotionally but not financially, and that gap is where the whole cost goes unfunded.)
- _If I'm on a trip and I've spent past the day's envelope figure, then I take it out of a later day of the same trip rather than from Spend or Buffer._
- _If I get home from a trip, then within seven days I record the actual total against my estimate — before I've forgotten and while the card statements are fresh._
- _If I'm paying in a foreign currency and hesitating, then I convert it to my home currency out loud before deciding._
  (Countering the weakened pain of paying from finding #11 — the conversion is the friction the unfamiliar notes removed.)

**Motivational failures**

- _If I feel like the system isn't working, then I open the weekly log and read the first row I ever wrote before making any changes._
- _If I've blown the budget badly, then I log the actual number anyway, in full, and change nothing until the next weekly review._
  (The recovery instinct — dramatically restricting the next week — is what produces the next blowout. Log it and continue.)

---

## Method Part VI — Setup, day by day

Seven days. Roughly 4 hours total. Do not compress this into one sitting; the spacing is deliberate, because the calibration in day 2 needs to sit before you act on it.

**Day 1 — Inventory (45 min).** List every account, card, debt (balance + rate + minimum), and recurring charge you have. Don't fix anything, don't judge anything. Just get it on one page.

**Day 2 — Calibrate (60 min).** Pull the last 90 days of transactions from your bank/wallet apps. Sort every line into the eight categories plus Bills. Compute your true monthly average per category. **Then add 25% to every variable category** — you are underestimating (finding #10), so build the correction in at the source instead of discovering it in month two.

**Day 3 — Irregulars (45 min).** Run the annual event-by-event inventory from Method Part III. Add 25%. Divide by 12. Write the resulting number down; it's the allocation that most people skip and most systems die without.

**Day 4 — Open the accounts (30 min + waiting).** Whatever you're missing from the five. The critical one is **Buffer at a different institution with no card attached** — recall the SEED trial's 28% take-up (finding #3). Today, while you're motivated, is when this gets done. It will not feel urgent again.

**Day 5 — Automate (45 min).** Set the standing instructions from Inflow. Set the date to your income arrival date, or the very next day. Move every fixed bill's debit to the Bills account. Verify each one, individually — silent failures are the most common way this system quietly stops working.

**Day 6 — Instrument (30 min).** Set up wherever you'll log. Create the eight categories, the planned/unplanned flag, and the weekly balance log. Compute your daily number with the × 0.85. Put it where you'll see it. Set the nightly reminder tied to an event, not a clock time.

**Day 7 — Commit (20 min).** Write your if-then rules from Method Part V, edited to your actual life, and put them somewhere visible. Text one person and ask them to receive a one-line number from you every week. Book the weekly money date as a recurring calendar event. Log day one.

---

## Method Part VII — The two profiles, side by side

The system is identical. Four parameters change.

|                                    | **Student on an allowance**                                                                                                                                       | **Salaried working adult**                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Income event**                   | Weekly or monthly allowance + irregular part-time/freelance/gifts                                                                                                 | Regular salary, 1–2 dates per month, plus bonuses                                                                                |
| **Period length**                  | **Weekly.** Shorter periods mean faster feedback and less end-of-period drift, and match how allowance arrives.                                                   | **Monthly**, sub-divided into weekly Spend tranches so the daily number stays daily.                                             |
| **Where Bills sit**                | Often paid by family — if so, **still list them at real value** in a shadow column. You need to know your true cost of living before you graduate into paying it. | Real, contractual, fully automated.                                                                                              |
| **Biggest structural risk**        | **Income irregularity.** Use the "lowest of three months" baseline in Rule 1, and treat everything above baseline as windfall.                                    | **Lifestyle inflation.** The 50/50 raise split (Rule 4) is the whole defence; without it every raise vanishes within two months. |
| **Biggest behavioural risk**       | Social spending and end-of-allowance zeroing. The 15% haircut and the social if-then plans in Method Part V exist mainly for this.                                | Unlogged card spending. The manual-log requirement (finding #6) exists mainly for this.                                          |
| **Irregulars profile**             | Tuition instalments, books, lab and thesis fees, org dues, transport home, device replacement                                                                     | Insurance, tax, maintenance, medical, gifts, travel, device replacement                                                          |
| **Phase you're probably in**       | 0 → 1. Buffer target = 6 weeks of _your_ take-home, which is a small and very achievable number. That's the point.                                                | 1 → 2 → 3, depending on debt.                                                                                                    |
| **What "6 weeks of buffer" means** | Six weeks of your actual spending, not of a salary you don't have. Often a genuinely modest sum.                                                                  | 6.2 weeks of take-home pay, per the JPMorgan threshold.                                                                          |

**One note specific to the student case:** a small income is the _best_ possible time to install this, not the worst. Finding #1 showed rule-of-thumb systems help least-sophisticated and least-motivated users the most, and finding #9 showed daily framing erased the income gap in savings uptake entirely. The habit transfers to the salary; the salary does not create the habit.

---

## Method Part VIII — Measuring whether it's actually working

Do not measure success by "did I stick to the budget." Measure these five, weekly, in your log. Everything here is a real behavioural quantity, not a feeling.

| Metric                  | How to compute                                                    | Target trajectory                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Log adherence**       | Days logged ÷ days in period                                      | >85% by week 4. Below 70% means the ritual is misplaced — move the cue, don't try harder.                                                  |
| **Unplanned ratio**     | Unplanned spend ÷ total Spend, **excluding tagged trip spending** | Falling. Starting at 40–50% is normal. Under 25% by month three is good. This is the direct measure of finding #10 losing its grip on you. |
| **Buffer weeks**        | Buffer balance ÷ weekly take-home                                 | Rising to 6.0 (finding #14), then to 13–26 in Phase 3                                                                                      |
| **Irregulars coverage** | Irregulars balance ÷ next 3 months of scheduled irregulars        | ≥1.0 and staying there. Below 1.0 is the leading indicator that Buffer is about to get raided.                                             |
| **Save rate**           | (Buffer + Grow contributions) ÷ take-home                         | Rising. The _Save More Tomorrow_ benchmark is 3.5% → 13.6% over 40 months (finding #2). Anything on that slope is working.                 |

**The honest expectation-setting:** the meta-analytic effect of financial education on behaviour is ~0.10 SD (finding #13) — real but modest, and it decays. What makes this system different from a course is that its effect doesn't come primarily from _knowledge_. It comes from defaults (~50pp on participation), commitment (+82% on balances), earmarking (+30% on saved amounts), monitoring (d = 0.40), and if-then plans (d = 0.65) — mechanisms that keep operating whether or not you remember why they're there. That's deliberate. The system is designed to work on a version of you that has stopped caring.

---

---

# PART TWO — THE BUILD SPEC

_What to build. Assumes Part One throughout._

## Spec 0 — TL;DR

A single-user, self-hosted budgeting server that implements The Split System: five accounts, one daily number, four rules, five rituals. It is a **manual-entry** money tracker with a scheduled-irregulars engine, a phase-based savings ladder, and a weekly review ritual that produces a written artefact. It runs as one Docker container with one SQLite file, on hardware you already own, reachable only over your private network. No bank integration. No cloud. No accounts system.

**The core architectural insight of this whole document:**

> This app must be **deliberately worse** at the things budgeting apps compete on — live balances, rich categories, automatic import — because the field evidence says each of those features is what causes overspending. The design constraint is therefore _what to withhold and when_, not what to display.
>
> The obvious approach — one dashboard showing balances, category budgets, and charts, always available — is precisely the configuration that Pocheptsova Ghosh & Huang measured people _overspending_ under (**F5**), while people tracking from memory did not overspend.

That single decision drives three things: the app has **two mutually exclusive faces** (Today vs Review) and routing enforces it; the daily number is computed from an **immutable period allocation snapshot**, never from `balance ÷ days_remaining`; and manual entry is a hard requirement rather than a fallback for missing bank APIs (**F6**).

---

## Spec 1 — Goals & Non-Goals

### Goals

| ID  | Goal                                                                    | Success looks like                                                                            |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| G1  | Make the nightly log cost under 60 seconds                              | Median time from app-open to entry-saved < 20s; 3 taps for a typical entry                    |
| G2  | Never show a precise "remaining" figure on the daily surface            | Today screen contains zero account balances; allowance shown as a ±10% range                  |
| G3  | Compute and hold the irregulars schedule so lumpy costs never hit Spend | Irregulars coverage ratio ≥ 1.0 sustained; zero unplanned draws on Buffer for scheduled items |
| G4  | Produce a written weekly artefact and a one-line shareable summary      | A `review` row exists for ≥ 85% of weeks; copy-to-clipboard summary in one tap (**F7**)       |
| G5  | Survive five years with no maintenance and no bill                      | Single container, pinned LTS base, zero paid dependencies, automated nightly backup           |
| G6  | Work offline on a phone at 11pm with no signal                          | Nightly log queues locally and syncs; no network required to record a transaction             |
| G7  | Keep financial data off the public internet                             | No port exposed to WAN in the recommended deployment; reachable only via private network      |

### Non-Goals

Be honest about these. Each is something you will want and should not build.

- **No bank / e-wallet / card sync.** Not "later" — it is contraindicated. Automated tracking measurably _lowers_ attention and self-awareness relative to manual recording (**F6**). Building it would make the app more impressive and less effective.
- **No multi-user, no accounts, no login screen with email.** One human. Network isolation is the auth boundary.
- **No budget-per-category.** Categories exist for the weekly review only. There is no "you have X left in Food-out" anywhere in the UI (**F5** — subdividing the spending budget was the one intervention that _backfired_).
- **No live-updating remaining balance on the Today screen.** Ever. This is the whole thesis.
- **No investment tracking, net worth, portfolio, or market data.** The Grow account holds a number you type in monthly. That's it.
- **No receipt scanning, OCR, or photo attachments.** Adds friction to the one ritual that must stay under 60 seconds.
- **No AI categorisation.** Eight categories, chosen by a human in one tap. An LLM call here buys nothing and costs the self-awareness the manual choice generates.
- **No mobile native app.** PWA. See Spec §8.7 for the iOS caveats you'll hit.
- **No multi-currency accounting.** One home currency. Trips carry a second currency at a single locked rate (Spec §4.5) — that is the whole of the multi-currency story, and it is deliberately not an FX subsystem. No rate API, no historical rate table, no per-account currency.
- **No relocation or nomadic support.** Trip Mode covers days to ~6 weeks. Beyond that it's a new cost of living and the answer is to re-run Setup, not to extend the envelope. Longhand assumes one stable home baseline throughout and that assumption is load-bearing — if you stop having a home baseline, this is the wrong app.

---

## Spec 2 — Users & Core Stories

One persona, two modes. Same schema, four different parameter values (see Method Part VII).

- **Student mode** — weekly period, irregular multi-source income, "lowest of three months" baseline, shadow-valued bills that family pays.
- **Adult mode** — monthly period sub-divided into weekly Spend tranches, contractual bills, raise-escalator active.

Stories:

1. As a user, at 11pm with no signal, I want to log today's three purchases in under 60 seconds so the streak survives.
2. As a user, I want to open the app and see exactly one number telling me what I can spend today, without seeing what's in my accounts.
3. As a user, on Sunday evening I want a guided six-step review that ends with a one-line summary I can paste to a friend.
4. As a user, when income lands, I want the split executed or, if my bank can't automate it, a checklist telling me exactly which transfers to make.
5. As a user, I want the app to tell me a month in advance that an irregular cost is coming and whether it is already funded.
6. As a user, when I want something expensive, I want to put it on a 72-hour list and be told when the wait is up.
7. As a user, I want to know which phase I'm in and precisely what clears it.

---

## Spec 3 — System Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Phone / laptop browser (PWA, installed to home screen)       │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Today      │  │  Review      │  │  Maps / Trends /     │  │
│  │  (hero +    │  │  (6-step     │  │  Irregulars / Debt   │  │
│  │   log form) │  │   wizard)    │  │  (behind Review gate)│  │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                │                     │              │
│  ┌──────┴────────────────┴─────────────────────┴───────────┐  │
│  │ Service worker + IndexedDB outbox (offline write queue) │  │
│  └──────────────────────────┬──────────────────────────────┘  │
└─────────────────────────────┼─────────────────────────────────┘
                              │ HTTPS over private network only
                              │ (Tailscale / LAN — never WAN)
┌─────────────────────────────┼─────────────────────────────────┐
│  Single Node process (SvelteKit, adapter-node)                │
│  ┌──────────────┐ ┌─────────────────┐ ┌────────────────────┐  │
│  │ Route        │ │ Domain services │ │ Scheduler (in-proc)│  │
│  │ handlers     │─│ · allowance     │ │ · 02:00 rollover   │  │
│  │ (form        │ │ · accrual       │ │ · 21:00 log nudge  │  │
│  │  actions +   │ │ · phase engine  │ │ · Sun review nudge │  │
│  │  JSON API)   │ │ · payoff switch │ │ · 03:00 backup     │  │
│  └──────┬───────┘ └────────┬────────┘ └─────────┬──────────┘  │
│         └──────────────────┴────────────────────┘             │
│                            │                                  │
│                   ┌────────┴─────────┐                        │
│                   │ Drizzle → SQLite │  data/split.db (WAL)   │
│                   └────────┬─────────┘                        │
│                            │                                  │
│                   ┌────────┴─────────┐                        │
│                   │ Nightly backup   │  → data/backups/*.db   │
│                   │ (VACUUM INTO)    │  → optional off-box    │
│                   └──────────────────┘                        │
└───────────────────────────────────────────────────────────────┘
```

**Request-time:** everything the user touches. Every read is a single-digit-millisecond SQLite query; there is no reason for any page to take more than 50ms server-side. **Budget: p95 < 100ms end-to-end on LAN.**

**Background (in-process cron, not a separate service):** period rollover, irregular instance materialisation, accrual posting, nudge notifications, and the nightly backup. All four are idempotent and keyed by date, so a missed run or a double run is harmless — this matters because a home server reboots and a cron tick gets skipped.

**Deliberately absent:** no queue, no Redis, no worker process, no external API. If you find yourself adding one, re-read Spec §12's over-engineering row.

---

## Spec 4 — Core Subsystems

### 4.1 Allocation & the daily number

**In:** income arrivals from one or more scheduled sources. **Out:** an immutable `period` row plus N `allocation` rows, and a `daily_allowance` figure.

#### Two clocks, not one

The single most important structural point in this subsystem: **income cadence and period cadence are independent.** Collapsing them into one setting breaks immediately —

- Weekly allowance against monthly tuition: a weekly period can't see the tuition.
- Daily income (tips, gig work): a period per arrival means 365 periods a year and the split automation firing daily.
- Bi-weekly pay against monthly rent: 26 arrivals versus 12 bill cycles, and nothing lines up.

So there are two schedules and they are configured separately:

| Concept             | Lives on                                    | Values                                                          |
| ------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| **Income cadence**  | `income_source.cadence`, one row per source | `daily · weekly · biweekly · semimonthly · monthly · irregular` |
| **Period cadence**  | `settings.period_kind`                      | `weekly · semimonthly · monthly`                                |
| **Tranche cadence** | `settings.tranche_kind`                     | `period` (no tranching) or `weekly`                             |

Multiple sources coexist — a weekly allowance, a bi-weekly part-time wage and irregular freelance income can all be active at once, each with its own schedule.

#### Stages

1. **Period opens** on its own calendar, independent of any arrival. Expected income for the window = the sum of each active source's arrivals _projected into that window_ (Spec §6.1c). For `irregular` sources, use the baseline instead — the **minimum** of the last three months, per Rule 1, never the mean.
2. **Split resolution.** Fixed-percentage split against expected income when all sources are scheduled. If any active source is `irregular`, apply the **ordered waterfall** from Rule 1: Bills to full → Irregulars to full → Buffer minimum → remainder to Spend.
3. **Freeze.** Write a `period` row with `spend_alloc_minor`, `starts_on`, `ends_on`, `days`. **This row is immutable.** Changing the split mid-period creates a _new_ period (`supersedes_id`), it does not mutate the old one.
4. **Compute** `daily_allowance = spend_alloc / days * 0.85` (Spec §6.1), and a display band of ±10%.
5. **Arrivals execute the split on arrival** (Rule 1 is unchanged) but **do not move the daily number.** The period was budgeted from expectation; actual arrivals reconcile against it at close.
6. **Release tranches.** If `tranche_kind = 'weekly'`, Spend is released to the Spend account one week at a time rather than as a lump (Spec §4.1b).
7. **Reconcile at close.** Actual arrivals minus expected → surplus goes through the windfall rule (50/50, Rule 4); shortfall reduces the next period's expectation and is surfaced, not silently absorbed.

#### 4.1b Tranches — partitioning applied to time

With a monthly period, the Spend _account_ holds a whole month even though the user only ever sees a daily band. The band restrains what they **see**; it does nothing about what's **reachable**. A single impulse purchase can take a fortnight of Spend because the money is sitting there.

Weekly tranching releases Spend from Inflow to Spend one week at a time on a standing instruction, so the account never holds more than ~7 days. This is the earmarking-and-partitioning finding (**F4**) applied to time rather than to accounts, and it is what makes a monthly period safe to run.

The daily number is **unchanged** by tranching — it is still `spend_alloc / days_in_period`, computed once at period open. Tranches change what's physically reachable, not what's displayed. Do not recompute the daily figure per tranche; that reintroduces a period boundary every week and with it the end-of-period acceleration (**F5**) that Spec §6.1 exists to prevent.

> **Recommended pairings.** Daily or irregular income → weekly period, no tranching. Weekly income → weekly period, no tranching. Bi-weekly, semi-monthly or monthly income → monthly period **with** weekly tranches. Tranching a weekly period is pointless overhead; not tranching a monthly one is the F5 risk in physical form.

#### The bi-weekly trap

Bi-weekly is **26 arrivals a year**. Semi-monthly is **24**. These are different by ~8% and are conflated constantly, including by people who have been paid bi-weekly for a decade.

The consequence is that twice a year a calendar month contains three arrivals. The correct handling: **budget every month as if there are two, and route the third through the windfall rule** (50/50, Rule 4). Never smooth 26 arrivals across 12 months — that leaves the user short in ten months and flush in two, which is exactly the volatility the system exists to remove.

This must be implemented as _projection over a real calendar_, never as an annual figure divided by twelve. See the conversion table in Spec §6.1c and treat any code that hardcodes `× 12` as a bug.

> **Quality gate — the "why is my number weird" check.** If the new `daily_allowance` differs from the previous period's by more than 25%, do not silently apply it. Surface a confirmation showing the inputs that changed — including whether this is a three-paycheck month. Silent large swings in the one number the user trusts is how trust in the system dies.

**Transfer checklist.** Where the user's bank can't automate the split or the tranche release, emit an explicit checklist of the moves to make by hand (Spec §8.3.4). A `planned` allocation with no `executed_at` after 48 hours surfaces on Today as a one-line prompt — an unexecuted split is the failure that silently invalidates every downstream number.

**Failure mode:** user records income twice. Mitigate with a duplicate warning on (amount, source, ±2 days) and make `void` a first-class state rather than deleting rows.

### 4.2 The withholding layer

Not a feature so much as an invariant enforced in one place, because it will otherwise erode as features are added.

```
Surface class          Balances?  Category totals?  Precise remaining?
──────────────────────────────────────────────────────────────────────
DAILY   (Today, Log)   no         no                no — band only
REVIEW  (all others)   yes        yes               yes
```

Implement as a server-side layout guard, not a CSS class: routes under `(daily)` load from a `todayView()` service that **cannot** return balance fields — the function's return type doesn't have them. Make it a type error to leak a balance onto the Today screen. A convention will not survive six months of you adding "just one useful number."

**The band, precisely.** Display `round(allowance*0.9)` – `round(allowance*1.1)` to a sensible unit (nearest 10 in most currencies, nearest 50 for high-denomination ones). Rationale in **F5**: showing a range rather than a precise figure was one of the five interventions that reduced end-of-period spending acceleration.

### 4.3 Irregulars engine

The only subsystem with non-trivial logic, and the one that determines whether the system survives year two (**F10**).

1. **Definition.** User declares an irregular: label, amount, cadence (`annual` / `semiannual` / `quarterly` / `monthly` / `one_off` / `every_n_years`), next due date, category, and an `is_estimate` flag.
2. **Materialisation.** A nightly job projects each definition forward 24 months into `irregular_instance` rows. Idempotent on `(irregular_id, due_on)`.
3. **Accrual.** Per period, required accrual = Σ over instances due in the next 12 months of `amount / periods_until_due`. Post as an `allocation` to the Irregulars account.
4. **Drawdown.** When an instance is marked paid, decrement Irregulars and mark the instance `settled` with the actual amount. **Store actual separately from estimate** — the delta is what feeds the annual re-estimate and is the honest measure of your prediction bias.
5. **Coverage ratio** = `irregulars_balance / Σ(instances due in next 90 days)`.

> **Quality gate — coverage below 1.0.** This is the leading indicator that Buffer is about to be raided. When coverage drops below 1.0, the Review screen leads with it, above everything else, with the specific shortfall and the specific instance that will bounce. Do not let this be one tile among twelve.

**Failure mode — the silent one that kills the system:** the user stops marking instances paid, so the ledger drifts from reality while the app keeps reporting healthy coverage. Mitigate with a reconciliation prompt in the monthly ritual: _"These 3 instances were due and not marked. Paid, skipped, or rescheduled?"_ — forced three-way choice, no dismiss.

### 4.4 Phase engine

Five phases (Method Part I §Phase 0–4), each with a machine-checkable exit condition:

| Phase       | Exit condition (evaluated nightly)                 |
| ----------- | -------------------------------------------------- |
| 0 Stabilise | `spend_float_weeks >= 2`                           |
| 1 Six weeks | `buffer_balance >= 6 * weekly_take_home` (**F14**) |
| 2 Kill debt | `max(debt.apr where balance>0) < 10%`              |
| 3 Deepen    | `buffer_balance >= 3 * monthly_core_expenses`      |
| 4 Grow      | terminal; escalator active                         |

The engine **proposes**, it never auto-advances — a phase change alters allocations, and silently reallocating someone's money is unacceptable regardless of correctness. Surface as a Review-screen prompt with the arithmetic shown.

Downgrades are explicitly non-punitive in copy. Slipping from Phase 2 back to Phase 1 is a normal event, and the UI must not treat it as failure — the recovery instinct after a setback is itself a documented failure mode (Method Part V).

### 4.5 Trip Mode

Travel breaks four assumptions at once, and the failure is silent: the daily band goes red for the whole trip, the unplanned ratio spikes to ~90%, the rolling averages carry a smear for three months afterwards, and the streak starts feeling punitive at exactly the point where people abandon the system. Add a single-currency data model and a fixed-timezone rollover job, and travel is the most likely thing to break this app in real use.

**The resolving idea, same as the plan's travel sub-rule:**

> A trip is not a spending period. It is a **funded irregular being drawn down.**

A trip is therefore modelled as a `one_off` irregular that has been accruing since it was declared, plus a `trip` row that owns an envelope, a currency, a timezone and a date range. Trip spending never touches `period.spend_alloc_minor`.

**The inversion worth understanding before implementing it.** Spec §6.1 forbids `remaining ÷ days_remaining` — it is the formula that produces end-of-period acceleration (**F5**). Trip Mode uses exactly that formula, deliberately. The reason F5's finding applies to periods and not to trips is the boundary condition: a period always has a next period to borrow from, so spending to zero is a debt you haven't recognised yet, whereas a trip has a hard end date and no tomorrow. Spending the envelope down to near-zero on the last day is the correct outcome. Same arithmetic, opposite meaning.

Keep them in separate functions with names that say so — `dailyAllowance()` and `tripDailyFigure()` — and a comment on each pointing at the other. A future reader will otherwise "fix" one of them.

Stages:

1. **Declare** (cue: the booking moment). Creates an `irregular` with `cadence='one_off'` plus a `trip` row in `planned` status. Padded 25% like any other estimate.
2. **Accrue.** Ordinary irregulars accrual (Spec §4.3) funds it. No special case.
3. **Funding check** (fires 14 days before `starts_on`). If `envelope < expected`, surface the shortfall with the three honest options — shorten, downgrade, or draw from Buffer **with a mandatory IOU**. There is no fourth option and no dismiss button; letting the shortfall silently consume the next two periods of Spend is the default failure this check exists to prevent.
4. **Activate** on `starts_on`. Today screen swaps to the trip hero; rollover, nudges and the day boundary move to `trip_tz`.
5. **Log** against the trip. Entries carry `trip_id`, `amount_local_minor`, and the locked `fx_rate_used`.
6. **Settle** on return. Record actual vs expected; the delta feeds the estimate-accuracy chart (Spec §8.4.6). Deactivate, restore home timezone.

**Currency: local for deciding, home for accounting.**

The user is standing in a shop reading a price tag in the local currency. A home-currency daily figure requires mental arithmetic at exactly the moment of decision, so it is useless there. But the envelope came from Irregulars in home currency and that's what calibration is measured in. Both are true, so split by purpose:

| Surface                                     | Currency                                                  | Why                                              |
| ------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| Trip daily figure (hero)                    | **local**                                                 | Pacing against price tags                        |
| Entry keypad                                | **local**, with home equivalent live beneath as they type | The decision moment needs the friction (**F11**) |
| Entries list                                | local primary, home muted                                 | Recall matches what they saw                     |
| Envelope, burn-down, settle, all accounting | **home**                                                  | It came from Irregulars                          |

The live home-currency figure under the keypad is not a convenience — it is the countermeasure. Foreign currency weakens the pain of paying, and the conversion is the friction the unfamiliar notes removed.

**Which rate: effective, not mid-market.** After the first withdrawal the user does one division — `home currency debited ÷ local currency received` — which captures the ATM fee and the card FX markup. Those typically run several percent, far larger than rate drift over a two-week trip. Which produces the inversion worth naming: **a live mid-market rate would be _less_ accurate than the user's locked effective rate**, because it ignores the fees actually paid. The more sophisticated solution is the wrong one, and it costs an API key, a network dependency and a rot risk in an app whose premise is running untouched for five years. **No FX API.** If cash and card rates differ materially, set the trip rate to whichever dominates and use the per-transaction override for big one-offs.

**Storage direction matters, because the rate is editable.** `amount_local_minor` is the **source of truth** for trip transactions; `amount_minor` (home) is _derived_. Editing `fx_rate_to_home` recomputes every home-currency figure for that trip and leaves the local amounts the user actually typed untouched. Getting this backwards means a rate correction silently rewrites history.

**Zero-decimal currencies are a real bug source.** `trip.local_minor_units` must be set per trip and must not inherit `settings.minor_units`. JPY, KRW and VND have none; a handful of Gulf currencies have three. The entry keypad **suppresses the decimal point entirely** when the value is 0 — otherwise the first purchase abroad is a 100× fat-finger, in an unfamiliar currency, where the user has no intuition to catch it.

**Settle takes two numbers.** The user enters what the bank _actually_ charged, from statements; the app already knows what was logged at the locked rate. `envelope − logged` is the **estimate** error (did the trip cost what I thought). `actual − logged` is the **FX-and-fee** error (was my rate right). These are different failures with different fixes — the first tunes next year's estimate, the second tunes next trip's rate — and conflating them into one number means neither improves.

**Domestic trips** set `fx_rate_to_home = 1.0`, local currency = home currency, and `local_minor_units = settings.minor_units`. Everything collapses to the normal path with no branching.

**Timezone: the day boundary follows your body, not your bank.** While a trip is active, the rollover job and the log-day key use `trip_tz`. The transition days are allowed to be 23 or 25 hours long. `log_day` is keyed on a date string and is the authority for the streak, so a short day is a normal row and a long day is a normal row — no special handling, which is the point of keying on the string rather than on a timestamp range.

> **Quality gate — metric quarantine.** Every ongoing-metric query gains `WHERE trip_id IS NULL` **by default**. Not a display filter — a query-layer default, so a new metric added in month eight inherits the exclusion instead of quietly reintroducing the smear. Trends carries one "include travel" toggle. Trip spending is measured against its own envelope on the Trips screen and nowhere else.

**Streak stays forgiving.** Trip days count normally, and the catch-up window widens from 48h to 72h while a trip is active. Losing a streak to a long-haul flight is a pointless way to lose a user.

**Explicitly out of scope:** stays beyond ~6 weeks. That is a relocation, not a trip — a new cost of living requiring a fresh 90-day calibration, a currency change at the `settings` level, and phase-ladder re-entry. Modelling it as a very large envelope produces a buffer drain discovered four months late. If it happens, run Setup again; do not extend Trip Mode. Continuous/nomadic use is out of scope entirely — Longhand assumes one stable home baseline and that assumption is load-bearing throughout.

### 4.6 Ritual engine

Five cadences, each a first-class record, because a completed ritual is the monitored artefact that **F7** says carries the d = 0.40 effect.

- `daily` — the log. A day with zero transactions still requires an explicit "nothing today" record. Streak counts _logged days_, not spending days.
- `weekly` — the six-step wizard, one screen per step, resumable. Writes a `review` row with balances snapshotted.
- `monthly`, `quarterly`, `annual` — checklists whose items map 1:1 to Method Part III. Each item is a row; partial completion persists.

**Streak logic, deliberately forgiving.** One missed day does not break the streak if a combined catch-up entry is filed within 48 hours (this is the pre-authorised lossy catch-up from Method Part V, encoded). Two consecutive missed days breaks it. On break, the app offers exactly one action: _start tonight_ — no backfill flow, because building the backfill flow is building the guilt.

---

## Spec 5 — Data Structures

SQLite. All money stored as **integer minor units** (cents/centavos) — never floats. All dates as `TEXT` ISO-8601 `YYYY-MM-DD`; all timestamps as ISO-8601 UTC.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── Configuration (single row, id = 1) ────────────────────────────────
CREATE TABLE settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  currency_code         TEXT    NOT NULL,          -- 'PHP', 'USD' — display only
  currency_symbol       TEXT    NOT NULL,
  minor_units           INTEGER NOT NULL DEFAULT 2,
  rounding_step         INTEGER NOT NULL DEFAULT 1000, -- band rounding, minor units
  period_kind           TEXT    NOT NULL CHECK (period_kind IN ('weekly','semimonthly','monthly')),
  -- Tranche = how Spend is RELEASED, independent of how it's COMPUTED (Spec §4.1b).
  -- 'weekly' is strongly recommended whenever period_kind = 'monthly'.
  tranche_kind          TEXT    NOT NULL DEFAULT 'period'
                          CHECK (tranche_kind IN ('period','weekly')),
  week_starts_on        INTEGER NOT NULL DEFAULT 0,    -- 0=Sun
  -- NOTE: income cadence is NOT here. It lives per-source on income_source,
  -- because a user can have several sources on different schedules (Spec §4.1).
  haircut_pct           INTEGER NOT NULL DEFAULT 15,   -- the ×0.85; tunable, not hidden
  band_pct              INTEGER NOT NULL DEFAULT 10,   -- ±10% display band
  phase                 INTEGER NOT NULL DEFAULT 0,
  escalator_split_pct   INTEGER NOT NULL DEFAULT 50,   -- Rule 4 windfall/raise split
  timezone              TEXT    NOT NULL DEFAULT 'UTC',
  nudge_log_at          TEXT,                          -- '21:00' local, NULL = off
  nudge_review_at       TEXT,                          -- 'SUN 19:00'
  created_at            TEXT    NOT NULL
);

-- ─── The five accounts (extensible, but seeded with exactly five) ──────
CREATE TABLE account (
  id            INTEGER PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE,   -- inflow|bills|spend|irregulars|buffer|grow
  name          TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN
                  ('inflow','bills','spend','irregulars','buffer','grow')),
  institution   TEXT,                      -- free text; the "different bank" reminder
  is_committed  INTEGER NOT NULL DEFAULT 0,-- 1 = deliberately inconvenient (F3)
  has_card      INTEGER NOT NULL DEFAULT 0,
  balance_minor INTEGER NOT NULL DEFAULT 0,-- last user-asserted balance
  balance_as_of TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT
);

-- ─── Named savings goals: fine partitioning of the SAVINGS side (F4) ───
CREATE TABLE goal (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES account(id),
  label          TEXT    NOT NULL,   -- concrete: "Rent if I lose my job", not "Buffer"
  target_minor   INTEGER,
  saved_minor    INTEGER NOT NULL DEFAULT 0,
  image_ref      TEXT,               -- the Soman & Cheema photo effect, optional
  target_date    TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','reached','abandoned')),
  created_at     TEXT NOT NULL
);

-- ─── Income sources: one row per stream, each with its own schedule ─────
CREATE TABLE income_source (
  id             INTEGER PRIMARY KEY,
  label          TEXT    NOT NULL,        -- 'allowance', 'part-time', 'freelance'
  cadence        TEXT    NOT NULL CHECK (cadence IN
                   ('daily','weekly','biweekly','semimonthly','monthly','irregular')),
  -- Schedule anchors. Which one is used depends on cadence; the rest are NULL.
  anchor_date    TEXT,                    -- biweekly: start of the 14-day cycle
  day_of_week    INTEGER,                 -- weekly: 0=Sun
  days_of_month  TEXT,                    -- semimonthly '15,30' · monthly '5'
                                          -- '99' = last day, for short months
  expected_minor INTEGER,                 -- per ARRIVAL, not per month
  -- For cadence='irregular': baseline = MIN of last 3 months (Rule 1), never
  -- the mean. Recomputed at each period open; NULL until 3 months of history.
  baseline_minor INTEGER,
  is_variable    INTEGER NOT NULL DEFAULT 0,  -- timing fixed, amount moves
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL
);

-- ─── Income arrivals ───────────────────────────────────────────────────
CREATE TABLE income (
  id           INTEGER PRIMARY KEY,
  source_id    INTEGER REFERENCES income_source(id),  -- NULL = one-off/windfall
  received_on  TEXT    NOT NULL,
  amount_minor INTEGER NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('scheduled','unscheduled','windfall')),
  period_id    INTEGER REFERENCES period(id),   -- which period it reconciles into
  is_void      INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  created_at   TEXT    NOT NULL
);
CREATE INDEX idx_income_received ON income(received_on DESC) WHERE is_void = 0;
CREATE INDEX idx_income_source   ON income(source_id, received_on DESC) WHERE is_void = 0;

-- ─── The immutable allocation snapshot ─────────────────────────────────
-- Never UPDATE a period's monetary fields. Supersede it.
CREATE TABLE period (
  id                     INTEGER PRIMARY KEY,
  starts_on              TEXT    NOT NULL,
  ends_on                TEXT    NOT NULL,
  days                   INTEGER NOT NULL,
  -- EXPECTED at open, from projecting every active source into this window
  -- (Spec §6.1c). NOT an annual figure ÷ 12 — biweekly is 26/yr, not 24.
  income_expected_minor  INTEGER NOT NULL,
  income_actual_minor    INTEGER,           -- summed at close; drives reconcile
  is_extra_arrival       INTEGER NOT NULL DEFAULT 0,  -- the 3-paycheck month
  spend_alloc_minor      INTEGER NOT NULL,
  daily_allowance_minor  INTEGER NOT NULL,  -- = spend_alloc/days*(1-haircut)
  haircut_pct_applied    INTEGER NOT NULL,  -- frozen; settings may change later
  tranche_kind           TEXT    NOT NULL DEFAULT 'period',
  phase_at_open          INTEGER NOT NULL,
  supersedes_id          INTEGER REFERENCES period(id),
  closed_at              TEXT,
  swept_minor            INTEGER,           -- surplus moved to irregulars at close
  created_at             TEXT    NOT NULL
);

-- Weekly Spend releases within a period (Spec §4.1b). Absent when tranche_kind='period'.
CREATE TABLE tranche (
  id            INTEGER PRIMARY KEY,
  period_id     INTEGER NOT NULL REFERENCES period(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,        -- 1..N within the period
  releases_on   TEXT    NOT NULL,
  amount_minor  INTEGER NOT NULL,
  executed_at   TEXT,
  UNIQUE (period_id, seq)
);
CREATE INDEX idx_tranche_pending ON tranche(releases_on) WHERE executed_at IS NULL;
CREATE UNIQUE INDEX idx_period_open
  ON period(starts_on) WHERE closed_at IS NULL AND supersedes_id IS NULL;

CREATE TABLE allocation (
  id            INTEGER PRIMARY KEY,
  period_id     INTEGER NOT NULL REFERENCES period(id) ON DELETE CASCADE,
  account_id    INTEGER NOT NULL REFERENCES account(id),
  amount_minor  INTEGER NOT NULL,
  executed_at   TEXT,                     -- NULL = transfer checklist not yet done
  UNIQUE (period_id, account_id)
);

-- ─── The manual log. Discretionary Spend ONLY. Bills/Irregulars excluded ─
CREATE TABLE txn (
  id            INTEGER PRIMARY KEY,
  spent_on      TEXT    NOT NULL,
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  category      TEXT    NOT NULL CHECK (category IN
                  ('food_in','food_out','transport','study_work',
                   'health','social','stuff','other')),
  planned       INTEGER NOT NULL,          -- the diagnostic flag (F10)
  note          TEXT,                      -- optional, ≤ 60 chars, never required
  period_id     INTEGER REFERENCES period(id),
  entered_at    TEXT    NOT NULL,          -- for the <60s adherence metric
  client_uuid   TEXT    UNIQUE,            -- offline outbox idempotency key
  -- Trip fields (Spec §4.5). trip_id NOT NULL ⇒ excluded from ongoing metrics by
  -- default. FK resolves at insert time, so the forward reference is fine.
  trip_id            INTEGER REFERENCES trip(id),
  amount_local_minor INTEGER,              -- as typed, in trip currency
  fx_rate_used       REAL                  -- frozen per row: history never moves
);
CREATE INDEX idx_txn_date     ON txn(spent_on DESC);
CREATE INDEX idx_txn_period   ON txn(period_id, category);
-- Metric indexes are trip-filtered to match the quarantine default (Spec §4.5)
CREATE INDEX idx_txn_metrics   ON txn(spent_on, category) WHERE trip_id IS NULL;
CREATE INDEX idx_txn_unplanned ON txn(spent_on) WHERE planned = 0 AND trip_id IS NULL;
CREATE INDEX idx_txn_trip      ON txn(trip_id, spent_on) WHERE trip_id IS NOT NULL;

-- ─── Explicit "nothing today" — keeps the streak honest ────────────────
CREATE TABLE log_day (
  logged_on   TEXT PRIMARY KEY,
  entry_count INTEGER NOT NULL DEFAULT 0,
  is_catchup  INTEGER NOT NULL DEFAULT 0,
  closed_at   TEXT NOT NULL
);

-- ─── Rule 3: every savings withdrawal carries an IOU ───────────────────
CREATE TABLE transfer (
  id              INTEGER PRIMARY KEY,
  moved_on        TEXT    NOT NULL,
  from_account_id INTEGER NOT NULL REFERENCES account(id),
  to_account_id   INTEGER NOT NULL REFERENCES account(id),
  amount_minor    INTEGER NOT NULL,
  iou_reason      TEXT,          -- REQUIRED when from = irregulars|buffer|grow
  iou_repay_by    TEXT,
  repaid_at       TEXT,
  created_at      TEXT    NOT NULL
);
CREATE INDEX idx_transfer_open_iou
  ON transfer(moved_on) WHERE iou_reason IS NOT NULL AND repaid_at IS NULL;

-- ─── Irregulars ────────────────────────────────────────────────────────
CREATE TABLE irregular (
  id             INTEGER PRIMARY KEY,
  label          TEXT    NOT NULL,
  amount_minor   INTEGER NOT NULL,
  is_estimate    INTEGER NOT NULL DEFAULT 1,
  cadence        TEXT    NOT NULL CHECK (cadence IN
                   ('one_off','monthly','quarterly','semiannual','annual','every_n_years')),
  cadence_n      INTEGER,
  next_due_on    TEXT    NOT NULL,
  category       TEXT,
  padding_pct    INTEGER NOT NULL DEFAULT 25,  -- the mandatory +25% (F10)
  archived_at    TEXT
);

CREATE TABLE irregular_instance (
  id             INTEGER PRIMARY KEY,
  irregular_id   INTEGER NOT NULL REFERENCES irregular(id) ON DELETE CASCADE,
  due_on         TEXT    NOT NULL,
  expected_minor INTEGER NOT NULL,           -- includes padding
  actual_minor   INTEGER,                    -- filled on settle; feeds re-estimation
  status         TEXT    NOT NULL DEFAULT 'projected'
                   CHECK (status IN ('projected','due','settled','skipped','rescheduled')),
  settled_on     TEXT,
  UNIQUE (irregular_id, due_on)
);
CREATE INDEX idx_ii_due ON irregular_instance(due_on)
  WHERE status IN ('projected','due');

-- ─── Trips (Spec §4.5). A trip is a funded irregular, not a spending period ──
CREATE TABLE trip (
  id                    INTEGER PRIMARY KEY,
  label                 TEXT    NOT NULL,
  starts_on             TEXT    NOT NULL,
  ends_on               TEXT    NOT NULL,
  trip_tz               TEXT    NOT NULL,   -- day boundary follows your body
  currency_code         TEXT    NOT NULL,   -- may equal home currency
  currency_symbol       TEXT    NOT NULL,
  -- MUST NOT inherit settings.minor_units. JPY/KRW/VND = 0, most = 2,
  -- KWD/BHD/JOD = 3. A wrong value here is a silent 100× entry error.
  local_minor_units     INTEGER NOT NULL,
  -- The EFFECTIVE rate the user actually got (incl. ATM + card FX fees), not
  -- mid-market. Locked at start, editable; editing recomputes this trip only.
  fx_rate_to_home       REAL    NOT NULL,   -- 1.0 if domestic
  envelope_minor        INTEGER NOT NULL,   -- funded amount, home currency
  irregular_instance_id INTEGER REFERENCES irregular_instance(id),
  buffer_draw_minor     INTEGER NOT NULL DEFAULT 0,  -- shortfall covered by IOU
  status                TEXT    NOT NULL DEFAULT 'planned'
                          CHECK (status IN ('planned','active','settled','cancelled')),
  -- Settle takes TWO numbers, and their difference is the point (Spec §4.5):
  --   logged  = Σ txn at the locked rate   → estimate error vs envelope
  --   charged = what the bank actually took → FX + fee error vs logged
  logged_total_minor    INTEGER,            -- computed at settle
  actual_minor          INTEGER,            -- user-entered from statements
  settled_on            TEXT,
  created_at            TEXT    NOT NULL,
  CHECK (ends_on >= starts_on)
);
-- At most one active trip. Overlapping trips are a data-entry error, not a feature.
CREATE UNIQUE INDEX idx_trip_active ON trip(status) WHERE status = 'active';
CREATE INDEX idx_trip_dates ON trip(starts_on) WHERE status IN ('planned','active');

-- ─── Debt ──────────────────────────────────────────────────────────────
CREATE TABLE debt (
  id              INTEGER PRIMARY KEY,
  label           TEXT    NOT NULL,
  balance_minor   INTEGER NOT NULL,
  apr_bp          INTEGER NOT NULL,      -- basis points: 1850 = 18.5%
  min_payment_minor INTEGER NOT NULL,
  opened_on       TEXT,
  closed_on       TEXT
);

CREATE TABLE debt_payment (
  id            INTEGER PRIMARY KEY,
  debt_id       INTEGER NOT NULL REFERENCES debt(id),
  paid_on       TEXT    NOT NULL,
  amount_minor  INTEGER NOT NULL
);

-- ─── If-then plans (F8) and the 72-hour list (Rule 4) ──────────────────
CREATE TABLE rule (
  id          INTEGER PRIMARY KEY,
  cue         TEXT    NOT NULL,        -- "If I'm about to buy over my allowance…"
  action      TEXT    NOT NULL,        -- "…then I add it to the 72-hour list."
  category    TEXT,                    -- adherence|overspend|structural|social|motivation
  fired_count INTEGER NOT NULL DEFAULT 0,
  last_fired  TEXT,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE wait_item (
  id            INTEGER PRIMARY KEY,
  label         TEXT    NOT NULL,
  amount_minor  INTEGER,
  added_at      TEXT    NOT NULL,
  ripe_at       TEXT    NOT NULL,      -- added_at + 72h
  outcome       TEXT CHECK (outcome IN ('bought','dropped','expired')),
  resolved_at   TEXT
);

-- ─── The monitored artefact (F7) ───────────────────────────────────────
CREATE TABLE review (
  id                    INTEGER PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN
                          ('weekly','monthly','quarterly','annual')),
  period_label          TEXT NOT NULL,        -- '2026-W33'
  completed_at          TEXT,
  spend_balance_minor   INTEGER,
  irregulars_minor      INTEGER,
  buffer_minor          INTEGER,
  debt_total_minor      INTEGER,
  total_spent_minor     INTEGER,
  unplanned_ratio_bp    INTEGER,              -- basis points
  buffer_weeks_x100     INTEGER,
  coverage_ratio_bp     INTEGER,
  save_rate_bp          INTEGER,
  shared_at             TEXT,                 -- the public-reporting moderator
  notes                 TEXT,
  UNIQUE (kind, period_label)
);

CREATE TABLE review_step (
  id          INTEGER PRIMARY KEY,
  review_id   INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  step_key    TEXT    NOT NULL,
  done_at     TEXT,
  payload     TEXT,                            -- JSON, step-specific
  UNIQUE (review_id, step_key)
);
```

### Key JSON shapes

The Today payload — note what it structurally **cannot** contain:

```jsonc
// GET /api/today
{
	"date": "2026-08-16",
	"band": { "low": 38000, "high": 46000 }, // minor units; NO exact allowance
	"currency": { "code": "PHP", "symbol": "₱", "minorUnits": 2 },
	"streak": { "current": 23, "longest": 41, "loggedToday": false },
	"waitingRipe": [
		// 72-hour items whose wait is up
		{ "id": 7, "label": "mechanical keyboard", "amountMinor": 320000 }
	],
	"upcomingIrregular": {
		// only if within 7 days
		"label": "Semester enrolment",
		"dueOn": "2026-08-21",
		"funded": true
	},
	"ritualDue": "daily" // daily | weekly | monthly | null
	// Deliberately absent: any account balance, any category total,
	// any "remaining this period" figure, any period-to-date sum.
}
```

The weekly review summary — the shareable one-liner from **F7**:

```jsonc
// GET /api/review/2026-W33/summary
{
	"line": "Week 33: spent ₱3,240 · unplanned 22% · buffer 3.1 weeks · streak 23",
	"metrics": {
		"totalSpentMinor": 324000,
		"unplannedRatioBp": 2200,
		"bufferWeeksX100": 310,
		"coverageRatioBp": 11400,
		"saveRateBp": 1180,
		"deltaVsPrior": { "totalSpentMinor": -18000, "unplannedRatioBp": -400 }
	},
	"topThree": [
		// review step 3 — "would I do that again?"
		{ "id": 812, "amountMinor": 89000, "category": "stuff", "planned": false },
		{ "id": 799, "amountMinor": 62000, "category": "social", "planned": true },
		{ "id": 805, "amountMinor": 45000, "category": "food_out", "planned": false }
	]
}
```

---

## Spec 6 — Core Algorithms

### 6.1 Daily allowance

```
function dailyAllowance(period, settings):
    base = period.spend_alloc_minor / period.days
    allowance = round(base * (1 - settings.haircut_pct/100))
    return allowance

function displayBand(allowance, settings):
    step = settings.rounding_step
    low  = floorTo(allowance * (1 - settings.band_pct/100), step)
    high = ceilTo (allowance * (1 + settings.band_pct/100), step)
    return { low, high }
```

Note there is **no `daysRemaining` parameter**. This is the point. `spend_alloc / days_remaining` is the formula that produces end-of-period acceleration (**F5**) and it must not exist _for periods_. The single legitimate use is Spec §6.1b below; the two functions must stay separate and each must carry a comment pointing at the other, or someone will eventually "fix" one of them.

### 6.1b Trip daily figure — the deliberate inversion

```
// SEE ALSO dailyAllowance(): that function must NEVER divide by days
// remaining. This one must. The difference is the boundary condition —
// a trip has a hard end and no next period to borrow from, so spending
// the envelope to ~zero on the final day is correct, not a failure.
function tripDailyFigure(trip, today):
    spentSoFar = Σ txn.amount_minor where trip_id = trip.id
    remaining  = trip.envelope_minor + trip.buffer_draw_minor - spentSoFar
    daysLeft   = max(1, daysBetween(today, trip.ends_on) + 1)   // inclusive
    if remaining <= 0: return { figure: 0, over: -remaining }
    return { figure: floor(remaining / daysLeft), over: 0 }
```

No haircut is applied. The 15% haircut exists to create a silent safety margin that sweeps to Irregulars at period close (**F5**); a trip has no next period to sweep into, and a padded trip figure just means coming home with money stranded in an envelope you'll disband. The padding for trips lives at the _estimate_ stage instead — the mandatory +25% on the irregular (**F10**) — which is the right place for it.

Recomputed each morning rather than fixed, because trip spending is genuinely front-loaded (flights, deposits) and a fixed daily figure would read as failure on day one and false comfort on day six.

### 6.1c Income schedule projection

The function that makes two clocks work. Project actual arrival dates onto a real calendar; never convert via an annual figure.

```
function projectArrivals(source, from, to):
    switch source.cadence:
      case 'daily':       every date in [from, to]
      case 'weekly':      every date in [from,to] where dow == source.day_of_week
      case 'biweekly':    every date d in [from,to] where
                            daysBetween(source.anchor_date, d) % 14 == 0
      case 'semimonthly': for each month in range, the days in source.days_of_month
                            (clamp to month length; '99' = last day)
      case 'monthly':     same, single day, same clamping
      case 'irregular':   []            // no dates — use baseline_minor instead

function expectedIncome(period):
    total = 0
    for src in activeSources():
        if src.cadence == 'irregular':
            // Rule 1: budget to the FLOOR, not the mean
            total += prorate(src.baseline_minor, period)
        else:
            total += projectArrivals(src, period.starts_on, period.ends_on).length
                     * src.expected_minor
    return total
```

**Conversion table — for display only, never for allocation.** Allocation always goes through `projectArrivals`.

| Cadence      | Arrivals/yr | → monthly equivalent |
| ------------ | ----------- | -------------------- |
| Daily        | 365         | × 30.44              |
| Weekly       | 52          | × 4.333              |
| Bi-weekly    | **26**      | × 2.167              |
| Semi-monthly | **24**      | × 2 exactly          |
| Monthly      | 12          | × 1                  |

```
function isExtraArrivalPeriod(period):
    // The three-paycheck month. Flag it, don't absorb it.
    for src in activeSources() where src.cadence in ('biweekly','weekly'):
        n = projectArrivals(src, period.starts_on, period.ends_on).length
        if n > typicalCount(src, period.kind): return true
    return false
```

When true, the period is budgeted at the **typical** count and the extra arrival is routed through the windfall rule (Rule 4, 50/50) on receipt. `period.is_extra_arrival` records it so the >25% swing gate (Spec §4.1) can name the cause rather than just flagging an anomaly.

```
function buildTranches(period, settings):
    if settings.tranche_kind != 'weekly': return []
    weeks = ceil(period.days / 7)
    base  = floor(period.spend_alloc_minor / weeks)
    // Remainder goes to the FIRST tranche, not the last — a short final week
    // is a good failure; running out on day 3 of the last week is not.
    return [{seq:1, amount: base + (period.spend_alloc_minor - base*weeks)},
            ...rest at base]
```

### 6.2 Irregulars accrual

```
function requiredAccrualPerPeriod(today, periodsPerYear):
    total = 0
    for inst in instances where status in ('projected','due')
                          and due_on <= today + 365d:
        periodsLeft = max(1, ceil(daysUntil(inst.due_on) / daysPerPeriod))
        total += inst.expected_minor / periodsLeft
    return round(total)

function coverageRatio(today):
    due90 = Σ inst.expected_minor for inst due within 90 days, unsettled
    if due90 == 0: return INFINITY
    return irregularsBalance() / due90
```

Accrual is recomputed each period rather than fixed at setup, so a newly-added irregular self-corrects: adding a large cost due in two months automatically raises the next two periods' accrual instead of quietly under-funding.

### 6.3 Payoff order — the price switch

Implements the plan's debt sub-rule. This is the honest version of snowball-vs-avalanche: compute the price of the motivation, then decide.

```
function payoffPlan(debts, monthlyExtra, spendAllocation):
    avalanche = simulate(debts, monthlyExtra, orderBy = apr DESC)
    snowball  = simulate(debts, monthlyExtra, orderBy = balance ASC)

    price      = snowball.totalInterest - avalanche.totalInterest
    monthsCost = snowball.months - avalanche.months

    if price <= spendAllocation:
        return { order: snowball.order, mode: 'snowball',
                 rationale: 'motivation costs ' + price + ', under one period of Spend' }

    // hybrid: bank exactly one subgoal completion, then optimise (F12)
    smallest = minBy(debts, d => d.balance_minor)
    rest     = debts without smallest, ordered by apr DESC
    hybrid   = simulate([smallest, ...rest], monthlyExtra)
    return { order: hybrid.order, mode: 'hybrid',
             rationale: 'snowball costs ' + price + ' (> one period of Spend); '
                      + 'clearing smallest first costs '
                      + (hybrid.totalInterest - avalanche.totalInterest) }

// simulate() = standard avalanche/snowball amortisation:
//   each month, pay minimums on all, throw everything remaining at debts[0],
//   roll a cleared debt's payment into the next. Returns { months,
//   totalInterest, order, schedule[] }.
```

Always display all three numbers — avalanche cost, snowball cost, hybrid cost — alongside the recommendation. The user is entitled to buy the motivation knowingly.

### 6.4 Metrics (Method Part VIII)

```
logAdherence(range)   = count(log_day in range) / daysIn(range)   // trips included
unplannedRatio(range) = Σ txn.amount where planned=0 / Σ txn.amount
bufferWeeks()         = buffer.balance / weeklyTakeHome()
coverageRatio()       = Spec §6.2
saveRate(range)       = Σ allocation to (buffer, grow) / Σ income
```

**All txn-based metrics carry `AND trip_id IS NULL` as a query-layer default** (Spec §4.5). Implement it once, in the shared txn selector every metric composes from — not as a filter each metric remembers to apply. Two weeks at 4× normal spend will otherwise smear a 12-week rolling average into uselessness and make a working system look broken for a quarter. Log adherence is the exception: trip days count normally, because the streak's job is to keep the app open.

`weeklyTakeHome()` in irregular-income mode uses the **minimum** of the last three months' income ÷ 4.33, per Rule 1 — not the mean. Budgeting to the mean of a volatile income is how the buffer gets raided.

---

## Spec 7 — API Surface

SvelteKit form actions for all mutations (progressive enhancement, works without JS); a small JSON API for the offline outbox and the PWA shell.

```
GET   /                        → Today view (SSR)
POST  /?/logTxn                → create txn (accepts client_uuid for idempotency)
POST  /?/logNothing            → close today with zero entries
POST  /?/addWaitItem           → 72-hour list

GET   /api/today               → the withheld payload above
POST  /api/sync                → batch outbox flush → { applied[], conflicts[] }

GET   /review                  → current week's wizard, resumable at last step
POST  /review/?/step           → persist one step's payload
POST  /review/?/complete       → finalise, snapshot metrics, emit summary line
GET   /api/review/:label/summary

GET   /accounts                → Money Map (Review-class)
POST  /accounts/?/assertBalance
POST  /accounts/?/transfer     → 422 if from is a savings account and iou_reason empty

GET   /irregulars              → calendar + ledger
POST  /irregulars/?/upsert
POST  /irregulars/?/settle     → { instanceId, actualMinor, settledOn }
POST  /irregulars/?/reconcile  → forced 3-way on overdue instances

GET   /income                  → sources, schedule, history, split preview
POST  /income/?/upsertSource   → declare/edit a source and its cadence
POST  /income/?/record         → record an arrival; reconciles, does NOT
                                 recompute the open period's daily number
POST  /income/?/windfall       → applies the 50/50 escalator split
POST  /income/?/rebaseline     → recompute irregular sources' MIN-of-3-months
GET   /api/income/forecast     → projected arrivals for the next N periods

GET   /periods                 → history; open period + its tranches
POST  /periods/?/open          → build from expectedIncome() + buildTranches()
POST  /periods/?/releaseTranche
POST  /periods/?/close         → reconcile actual vs expected, sweep surplus

GET   /trips                   → list + the active trip's envelope burn-down
POST  /trips/?/declare         → creates trip (planned) + its one_off irregular
POST  /trips/?/activate        → status→active; day boundary moves to trip_tz
POST  /trips/?/setRate         → edit fx_rate_to_home; recomputes that trip only
POST  /trips/?/coverShortfall  → 422 unless iou_reason present (Rule 3)
POST  /trips/?/settle          → { actualMinor }; restores home tz, feeds Spec §8.4.6

GET   /debt                    → payoff plan with all three costs
POST  /debt/?/upsert
POST  /debt/?/payment

GET   /rules                   → if-then plans + wait list
POST  /rules/?/upsert
POST  /rules/?/fired           → increments the counter; feeds the quarterly audit

GET   /trends                  → the five metrics over time
GET   /api/export.json         → full dump
GET   /api/export.csv          → txn + review, flat
POST  /api/import              → restore from export

GET   /setup                   → 7-day wizard, resumable
GET   /settings
```

---

## Spec 8 — Frontend — the dashboard, screen by screen

This is the section that carries the design thesis. Every widget below names its **form** per the data-viz rules (stat tile vs chart vs table), and the visual specs reference the validated palette in Spec §8.6.

### 8.0 Design skills — install before writing any UI

_(Repo URLs are user-supplied and unverified against this document — confirm each resolves before relying on it.)_

**Why this is not decoration.** The top metric in Spec §11 is log adherence, and adherence is downstream of whether the user _wants_ to open the app at 11pm. An ugly, awkward or slow interface is an adherence bug wearing a cosmetic disguise. Visual quality here is a behavioural intervention, funded by the same reasoning as everything else in Spec §4.

**The conflict rule, which matters more than the skills themselves.** These skills are trained on dashboards that compete on richness — dense grids, many tiles, live figures, generous information. This app's entire thesis is the opposite (Spec §4.2). So:

> Use the design skills for **craft** — typography, spacing, hierarchy, motion, component quality, colour discipline, states. Never for **density**. Where any skill's guidance conflicts with the withholding layer (Spec §4.2) or the charting non-negotiables (Spec §8.6), **this spec wins, every time.**

If a skill suggests adding a balance tile, a KPI row, or a "quick stats" strip to the Today screen, that suggestion is correct in general and wrong here. Reject it and note why in the commit.

### 8.0b Design principles for this app specifically

Ten rules that make "purposeful, easy to understand, good to look at" concrete enough to build against.

1. **Two visual registers, obviously different.** DAILY-class screens (Today, Log) are calm, sparse, near-empty — one number, one input, lots of air. REVIEW-class screens are dense, structured and information-rich. The difference must be legible in half a second, without reading a word, so the user always knows which mode they're in. This makes the withholding layer a _visible design language_ rather than an invisible invariant, which is what stops it eroding.

2. **The hero is the product.** The daily band at ≥48px, with nothing competing for it. If your eye lands anywhere else first on Today, the screen is wrong.

3. **No dashboard chrome on Today.** No cards, no tiles, no grid, no panel borders. A card is a visual promise that there are many things here; Today has one thing. Cards are permitted on REVIEW screens only.

4. **Thumb-first, one-handed, in the dark.** The nightly log happens in bed. Primary actions live in the bottom third. Numeric keypad, never a text input. Category chips ≥44px and spaced so they're hittable without looking. Nothing critical in a top corner.

5. **Dark mode is the primary mode, not the alternate.** The main ritual is at 11pm. Author it first, against the dark surface, with its own steps (Spec §8.6) — never as an inverted afterthought.

6. **Motion is feedback, never decoration.** Exactly three animations earn their place: entry saved, streak incremented, tranche released. All under 200ms, all respecting `prefers-reduced-motion`. No page transitions, no parallax, no skeleton shimmer on a local SQLite read that returns in 3ms.

7. **Speed is a feature of the ritual.** Target under 20s from app-open to entry-saved (Spec §11, G1). That budget is spent on _the user's decisions_, not on your framework. No spinner should ever be visible on a local read.

8. **Numbers get typographic care.** Proportional figures for the hero and stat values; `tabular-nums` reserved for columns that must align — table rows, axis ticks. Currency symbol de-emphasised relative to the figure. Never letterspace numerals.

9. **Empty states are the first-run experience.** Trends at week one is blank, and that's correct, not broken. Every empty state says what will fill it and when — "your first trend appears after two weekly reviews" — rather than showing a sad illustration or a zeroed chart.

10. **Accessibility floor, non-negotiable:** 44px minimum hit targets, 4.5:1 contrast on body text, usable at 200% zoom, full keyboard operation on desktop, and meaning never carried by colour alone (Spec §8.6). This app holds someone's financial life; it does not get to be exclusionary about who can read it.

**One deliberate aesthetic stance:** this should look like a well-made instrument, not a fintech marketing site. No gradients-as-decoration, no glassmorphism, no illustrated mascots, no motivational copy. The user is being asked to tell the truth about their spending every night — a serious, quiet, precise interface respects that, and a playful one undermines it.

### 8.1 Screen 1 — **Today** `/` _(DAILY class — the withholding layer applies)_

The default route and the only screen you see 95% of the time. **Purpose: tell you today's number and take your log entry.** Nothing else.

| #   | Header / widget   | Form                                      | Content                                                            | Notes                                                                                                                                                                                                                                                      |
| --- | ----------------- | ----------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | _(no page title)_ | **Hero figure**                           | `₱380 – ₱460` at ≥48px                                             | The band, never a precise figure. No label above it beyond a muted "today".                                                                                                                                                                                |
| 1.2 | Log strip         | Inline form                               | Amount keypad → 8 category chips → planned/unplanned toggle → Save | Always visible, never behind a tap. Amount field autofocused.                                                                                                                                                                                              |
| 1.3 | Today's entries   | Compact list                              | Chronological, amount + category chip, swipe-to-delete             | Shows _today's_ entries only. No running total — that's a remaining-balance proxy.                                                                                                                                                                         |
| 1.4 | Streak            | **Stat tile** (value + 28-cell dot strip) | `23 days` + a 28-day filled/empty strip                            | The dot strip is the physical record from **F7**. Not a chart.                                                                                                                                                                                             |
| 1.5 | Ripe waits        | Alert card                                | "Your 72 hours are up on: mechanical keyboard" → Buy / Drop        | Only renders when something is ripe.                                                                                                                                                                                                                       |
| 1.6 | Horizon           | Single line                               | "Enrolment fee due in 5 days — funded ✓"                           | Only within 7 days. Status icon + label, never colour alone.                                                                                                                                                                                               |
| 1.7 | Ritual nudge      | Button                                    | "Weekly review is due → "                                          | Only on/after review day.                                                                                                                                                                                                                                  |
| 1.8 | Pending action    | One line                                  | "2 transfers not yet made → " or "Tranche 3 releases today → "     | Only when an `allocation` or `tranche` is unexecuted past its date. This is the sole exception to the no-additions rule, and it earns it: an unexecuted split means every number on this screen is describing money that isn't where the app thinks it is. |

**Nothing else may be added to this screen.** Write that in the repo's `CONTRIBUTING.md`. The pressure to add "just the Spend balance" will be constant and must lose every time.

**Trip variant.** While a trip is active the same screen swaps four things and changes nothing else:

| Widget        | Home                            | On a trip                                                                                                                                              |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.1 Hero      | Band from the period allocation | `tripDailyFigure()` — a **precise** figure, not a band, plus a thin envelope burn-down meter beneath it                                                |
| 1.2 Log strip | Home currency                   | Trip currency keypad; home-currency equivalent shown small beneath as you type — the conversion is the friction the unfamiliar notes removed (**F11**) |
| 1.3 Entries   | Today's entries                 | Same, with the local amount primary and home equivalent muted                                                                                          |
| —             | —                               | A single muted line: `Day 4 of 11 · ¥38,200 left`                                                                                                      |

The hero is precise here rather than banded for the same reason it divides by days remaining — see Spec §6.1b. Everything the withholding layer hides at home stays hidden: no account balances, no category totals, no period figures.

### 8.2 Screen 2 — **Review** `/review` _(REVIEW class — everything unlocks)_

A six-step wizard mapping 1:1 to Method Part III's weekly ritual. One step per screen, resumable, ~15 minutes.

| Step | Header                     | Form                                                                                                      | Content                                                                                                                   |
| ---- | -------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| R1   | **Log the four balances**  | 4 number inputs + prior-value ghosts                                                                      | Spend / Irregulars / Buffer / Debt. Manual assertion is the point — typing the number is doing the work (**F7**).         |
| R2   | **This week's actuals**    | Horizontal **bar chart**, 8 categories, sorted desc, sequential blue + **unplanned ratio** as a **meter** | Bars are magnitude → one hue, not eight (see Spec §8.6). Meter track shows the ratio against last week's value as a tick. |
| R3   | **Top three transactions** | 3 cards, one question each                                                                                | "Would I do that again?" → Yes / No / Meh. Answers persist to `review_step.payload` and feed the quarterly audit.         |
| R4   | **Week ahead**             | Calendar strip (7 cells) + irregular list                                                                 | Anything costing money in the next 7 days; one-tap "move to Spend, tagged".                                               |
| R5   | **Adjust the number**      | Slider + live band preview                                                                                | Mid-period adjustment is a documented anti-overspend intervention (**F5**). Creates a superseding period.                 |
| R6   | **Send it**                | Generated one-liner + copy button + share sheet                                                           | Sets `review.shared_at`. This is the public-reporting moderator and it is one tap.                                        |

Completing R6 writes the `review` row and snapshots all five metrics.

### 8.3 Screen 3 — **Money Map** `/accounts` _(REVIEW class)_

| #   | Header / widget    | Form                                        | Content                                                                                                                                         |
| --- | ------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Phase banner       | **Stat tile** + progress **meter**          | "Phase 1 — Six weeks · 3.1 / 6.0 weeks". Meter, not a pie, not a donut.                                                                         |
| 3.2 | The five accounts  | Table (not cards)                           | Name · institution · balance · last asserted · committed flag · card flag. A table because five rows of five attributes is a table.             |
| 3.3 | Flow diagram       | Static **Sankey-ish ASCII/SVG**, one period | Inflow → the five, with this period's allocation amounts. Renders the split as a picture once, so the mental model sticks.                      |
| 3.4 | Transfer checklist | Checklist                                   | Unexecuted `allocation` rows for the open period: "Move ₱X from Inflow to Buffer" ✓. The manual-bank fallback.                                  |
| 3.5 | Open IOUs          | Table                                       | Rule 3's list. Date · amount · reason · repay-by · overdue flag. **Reading four in a row is the mechanism** — do not summarise it into a count. |
| 3.6 | Goals              | List of **meters**                          | Named goals with concrete labels + optional image (**F4**). Fine partitioning belongs here and only here.                                       |

### 8.4 Screen 4 — **Irregulars** `/irregulars` _(REVIEW class)_

| #   | Header / widget   | Form                                          | Content                                                                                                                                              |
| --- | ----------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Coverage          | **Hero figure** + status                      | `1.14×` coverage, with status icon + label ("funded" / "short by ₱X"). Leads the page; below 1.0 it takes over the whole screen.                     |
| 4.2 | Next 12 months    | **Column chart**, monthly, sequential blue    | Expected outflow per month. Reveals the two spikes you'd otherwise forget. Single series → no legend, title names it.                                |
| 4.3 | Accrual line      | **Line chart**, 2 series: accrued vs required | The only 2-series chart in the app. Categorical slots 1 & 2, both direct-labelled. **One y-axis** — both are the same unit.                          |
| 4.4 | Upcoming          | Table                                         | Label · due · expected · funded? · [Settle]                                                                                                          |
| 4.5 | Definitions       | Table + editor                                | Cadence, amount, padding %, estimate flag                                                                                                            |
| 4.6 | Estimate accuracy | **Dumbbell chart**                            | Expected → actual per settled instance, last 12 months. This is your personal calibration on **F10** and it's the most interesting chart in the app. |
| 4.7 | Annual rebuild    | Wizard                                        | The event-by-event checklist from Method Part III, with the +25% applied at the end and shown explicitly.                                            |

### 8.5 Screens 5–12

| Screen       | Route       | Headers / widgets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trends**   | `/trends`   | Five **stat tiles with sparklines** (adherence, unplanned ratio, buffer weeks, coverage, save rate) in a KPI row; below, one **small-multiples grid** of the same five as lines over 12 weeks — _not_ five series on one chart. Below that, a category **heatmap** (8 categories × 12 weeks, sequential blue) for spotting drift.                                                                                                                                                                                                                              |
| **Trips**    | `/trips`    | _(REVIEW class.)_ Active trip: **hero figure** for envelope remaining + a **burn-down line chart** — actual cumulative spend vs the straight-line pace, two series, slots 1–2, direct-labelled, one y-axis. Below it, a per-day **column chart** of trip spend. Planned trips: a funding **meter** each (`envelope ÷ expected`) with the 14-day check surfaced as a status row — icon + label, never colour alone. Past trips: a table of estimated vs actual, which is the same data feeding Spec §8.4.6's dumbbell. Rate editor and settle action live here. |
| **Debt**     | `/debt`     | Payoff-plan card showing avalanche / snowball / hybrid costs side by side as a 3-row table with the recommendation marked; a **line chart** of projected balance under the chosen order vs actual; per-debt table with APR, balance, minimum.                                                                                                                                                                                                                                                                                                                  |
| **Rules**    | `/rules`    | If-then list grouped by the five categories from Method Part V, each with a fired-count; the 72-hour list (waiting / ripe / resolved), with the drop-rate shown as a single **stat tile** — seeing "68% of items dropped" is the argument for the rule.                                                                                                                                                                                                                                                                                                        |
| **Income**   | `/income`   | Sources table (label · cadence · anchor · expected per arrival · variable flag). A **12-month arrival calendar strip** with three-paycheck months marked — the single most useful widget here, because seeing the two fat months a year in advance is what stops them being spent as surprises. Split preview ("if I record X…"); windfall recorder with the 50/50 escalator; for irregular sources, a **column chart** of the last 12 months with the _minimum_ drawn as the baseline line and the mean deliberately **not** drawn.                           |
| **Periods**  | `/periods`  | Open period: allocation breakdown, tranche release schedule with executed/pending state, expected-vs-actual income to date. History: one row per closed period with swept surplus. Superseded periods shown indented under the one that replaced them, so a mid-period adjustment reads as an edit rather than a gap.                                                                                                                                                                                                                                          |
| **Setup**    | `/setup`    | The 7-day wizard from Method Part VI, one day per step, resumable, with day 2's 90-day calibration importing a CSV and day 3's irregulars inventory as a checklist.                                                                                                                                                                                                                                                                                                                                                                                            |
| **Settings** | `/settings` | Currency, period kind, income mode, haircut %, band %, nudge times, timezone, export/import, backup status. Haircut is exposed and editable — a hidden 15% haircut discovered later reads as the app lying to you.                                                                                                                                                                                                                                                                                                                                             |

### 8.6 Visual & charting rules

Non-negotiables, applied from the data-viz method:

- **Sequential (one hue, blue) is the default.** Category bars are _magnitude_, not _identity_ — eight colours across eight categories would be the classic mistake. One hue, sorted descending.
- **Categorical hues only where series identity is the subject** — that's exactly two places: R2's accrued-vs-required line and the debt projected-vs-actual line. Two series each, slots 1 and 2, direct-labelled, legend present.
- **Never a dual axis.** If two measures don't share a unit, they get two charts.
- **Colour never carries meaning alone.** Funded/short, over/under, good/bad all ship with an icon and a text label.
- **Dark mode is authored, not inverted** — its own steps against the dark surface.
- Every chart has a **table view** toggle, which doubles as the accessibility fallback and the "let me just see the numbers" escape hatch.

Palette (validated default; substitute your own and re-run the validator):

| Role              | Light                 | Dark                    |
| ----------------- | --------------------- | ----------------------- |
| Chart surface     | `#fcfcfb`             | `#1a1a19`               |
| Primary ink       | `#0b0b0b`             | `#ffffff`               |
| Secondary ink     | `#52514e`             | `#c3c2b7`               |
| Muted (axis)      | `#898781`             | `#898781`               |
| Gridline          | `#e1e0d9`             | `#2c2c2a`               |
| Series 1 (blue)   | `#2a78d6`             | `#3987e5`               |
| Series 2 (orange) | `#eb6834`             | `#d95926`               |
| Sequential ramp   | `#cde2fb` → `#0d366b` | same ramp, dark-stepped |
| Status good       | `#0ca30c`             | `#0ca30c`               |
| Status warning    | `#fab219`             | `#fab219`               |
| Status critical   | `#d03b3b`             | `#d03b3b`               |

Charting library: **Observable Plot** for the static charts (declarative, small, no React dependency) with hand-rolled SVG for the meters, sparklines and the dot strip — those are ten lines each and a chart library makes them worse. Skip Chart.js and Recharts; both pull more weight than this app needs.

### 8.7 PWA & offline

The nightly log must work on a phone at 11pm with no signal (**G6**), so:

- Service worker caches the app shell; writes go to an **IndexedDB outbox** keyed by `client_uuid` and flush via `POST /api/sync`. Server dedupes on `client_uuid`, so a double-flush is harmless.
- Conflict policy: last-write-wins on `txn` (they're append-only in practice), and the outbox never queues anything but txn creates and wait-item adds — no queued edits, no merge logic.
- **iOS caveats, verified as a class of problem rather than a specific version behaviour:** Safari PWAs must be installed to the home screen before web push works at all, and storage for non-installed sites can be evicted after a period of inactivity. Background Sync is not reliably available. **Design consequence:** never treat the outbox as durable storage — flush aggressively on any foreground event, and surface an explicit "N entries not yet synced" indicator rather than assuming. Verify current Safari behaviour on your own device during Phase 1; this area changes with every iOS release and any spec statement about it is stale on arrival.
- Nudges: prefer a **local calendar/system reminder** the user sets during setup over web push. It's more reliable across platforms and it costs zero infrastructure. Web push is a Phase 4 nicety.

---

## Spec 9 — Tech Stack & Deployment Tiers

### Recommended stack

| Layer       | Choice                                                             | Why this and not the obvious alternative                                                                                                                                       |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime     | **Node.js 26 LTS**                                                 | Active LTS as of Aug 2026; security support to Apr 2029. Node 24's active support ends Oct 2026 — don't start there.                                                           |
| Framework   | **SvelteKit 2 / Svelte 5**, `adapter-node`                         | Form actions give working mutations without client JS, which is exactly right for a 3-tap log form. Next.js 16 is fine but heavier for a single-user app with no need for RSC. |
| DB          | **SQLite** (WAL) via `better-sqlite3`                              | Synchronous, in-process, no daemon. For one user writing ~10 rows/day, anything else is a liability with an uptime requirement.                                                |
| Query layer | **Drizzle ORM**                                                    | Typed schema, real SQL migrations you can read. Prisma's engine binary is dead weight here.                                                                                    |
| Styling     | **Tailwind CSS v4** via `@tailwindcss/vite`                        | CSS-first config, no PostCSS chain.                                                                                                                                            |
| Charts      | **Observable Plot** + hand-rolled SVG                              | See Spec §8.6.                                                                                                                                                                 |
| Scheduling  | `node-cron` in-process                                             | A separate scheduler service for four idempotent daily jobs is over-engineering.                                                                                               |
| Packaging   | Single **Docker** image, multi-stage, distroless or `node:26-slim` | One `docker compose up`. Volume-mount `./data`.                                                                                                                                |
| Network     | **Tailscale** (or LAN-only)                                        | See tier table.                                                                                                                                                                |

**Verify before committing (checked 2026-08-16, all move):** Node LTS status ([endoflife.date](https://endoflife.date/nodejs)), Tailscale Personal plan terms ([tailscale.com/pricing](https://tailscale.com/pricing)), Oracle Always Free limits ([see below](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)), Cloudflare D1 free limits ([developers.cloudflare.com](https://developers.cloudflare.com/d1/platform/pricing/)).

### Deployment tiers

**Tier A — Home machine or Raspberry Pi + Tailscale · $0/mo · RECOMMENDED**

| Layer   | Choice                                                     | Cost                  |
| ------- | ---------------------------------------------------------- | --------------------- |
| Compute | A Pi 4/5, an old laptop, or a spare desktop                | electricity, ~$1–3/mo |
| Network | Tailscale Personal — up to 6 users, unlimited user devices | $0                    |
| TLS     | Tailscale HTTPS (`tailscale cert`) or MagicDNS             | $0                    |
| Backup  | `VACUUM INTO` nightly → rclone to any cloud drive          | $0                    |

_Constraint it imposes:_ nothing is reachable when your home internet is down and you're away. For a personal finance log this is acceptable — the outbox queues. **Licence note:** Tailscale's Personal plan is explicitly non-commercial; fine here, but if this ever becomes a product, that tier is off the table.

**Tier B — Oracle Cloud Always Free (ARM) + Tailscale · $0/mo · with a warning**

| Layer   | Choice                                                                                    | Cost |
| ------- | ----------------------------------------------------------------------------------------- | ---- |
| Compute | Ampere A1 — **now 2 OCPU / 12 GB**, halved from 4/24 on 15 June 2026 with no announcement | $0   |
| Storage | Boot volume within the always-free block allowance                                        | $0   |
| Network | Tailscale; no public ingress                                                              | $0   |

_Constraint it imposes:_ Oracle silently reduced this tier and, per reporting, terminated resources above the new limit may not be recreatable. Capacity for A1 instances is also chronically unavailable in popular regions. **Do not build a dependency you can't move in an afternoon** — which, since the whole app is one container plus one file, you can. Treat Tier B as a convenience, not a foundation.

**Tier C — Cloudflare Workers + D1 · $0/mo · only if you want zero ops**

| Layer   | Choice  | Free limits (verified 2026-08-16)                     |
| ------- | ------- | ----------------------------------------------------- |
| Compute | Workers | free plan request limits apply                        |
| DB      | D1      | 5M rows read/day, 100k rows written/day, 5 GB storage |

_Constraint it imposes:_ this is not a port, it is a **rewrite** — no `better-sqlite3`, no in-process cron (Cron Triggers instead), no filesystem, no synchronous DB calls. The free limits are enormous relative to this app's ~10 writes/day, so the constraint isn't quota, it's that your financial data now lives on someone else's edge and you've traded a 200-line deploy for a platform coupling. **Only pick this if you actively don't want to own a machine.**

### Recommendation

**Tier A.** A single-user financial log has no availability requirement, no scaling story, and a strong privacy argument for staying off the public internet — which also happens to align with where you're heading professionally. One container, one file, one private network. The entire disaster-recovery plan is "copy `split.db` to the new box," and that property is worth more than any managed platform's convenience.

---

## Spec 10 — Cost Model

The interesting thing about this project is that it costs nothing, so the cost model's job is to prove that and to bound the storage claim.

| Unit                              | Arithmetic                                  | Result               |
| --------------------------------- | ------------------------------------------- | -------------------- |
| Transactions                      | 8/day × 365 = 2,920 rows/yr × ~180 B        | **~0.5 MB/yr**       |
| Log days                          | 365 rows/yr × ~60 B                         | ~22 KB/yr            |
| Irregular instances               | ~30 definitions × 24 mo projection × ~120 B | ~86 KB, steady state |
| Reviews                           | 52 + 12 + 4 + 1 = 69/yr × ~400 B            | ~28 KB/yr            |
| Indexes + WAL overhead            | ~1.6× base                                  | —                    |
| **Total DB, 10 years**            | (0.5 + 0.05) MB/yr × 10 × 1.6               | **~9 MB**            |
| Nightly backups, 30-day retention | 9 MB × 30, gzipped ~0.3×                    | **~80 MB**           |
| Container image                   | `node:26-slim` + deps                       | ~180 MB              |
| Bandwidth                         | Single user, PWA-cached shell               | negligible           |

| Tier             | Monthly                                                     |
| ---------------- | ----------------------------------------------------------- |
| A — Pi at home   | **$0** + ~$1–3 electricity                                  |
| B — Oracle A1    | **$0** (subject to Spec §9's warning)                       |
| C — Workers + D1 | **$0** (this app uses ~0.2% of the D1 free write allowance) |

No LLM calls. No third-party APIs. No paid dependencies. The only way this project costs money is if you put it on a platform with a hobby tier that later gets withdrawn — which is the argument for Tier A.

_Prices and free-tier limits verified 2026-08-16 and all of them move. Re-check before committing to Tiers B or C._

---

## Spec 11 — Quality Evaluation

The app's quality is not measured in uptime. It's measured in whether the ritual survives.

| Metric                 | Definition                                 | Target                    | Where it lives         |
| ---------------------- | ------------------------------------------ | ------------------------- | ---------------------- |
| **Log adherence**      | `log_day` rows ÷ days elapsed              | > 85% by week 4           | Trends                 |
| **Entry latency**      | median `entered_at` − app-open             | < 20s                     | instrument in Phase 1  |
| **Review completion**  | weeks with a completed `review` ÷ weeks    | > 85%                     | Trends                 |
| **Share rate**         | reviews with `shared_at` ÷ reviews         | > 60%                     | Trends                 |
| **Coverage stability** | share of days with coverage ≥ 1.0          | > 95% after month 3       | Irregulars             |
| **Estimate error**     | median \|actual − expected\| ÷ expected    | shrinking YoY             | Irregulars Spec §8.4.6 |
| **Unplanned ratio**    | the behavioural outcome, not an app metric | 40–50% → < 25% by month 3 | Trends                 |

**Golden test set:** a seeded fixture DB covering the ugly cases — a period superseded mid-week; an income event voided after allocations were executed; an irregular rescheduled twice; a debt paid off exactly on a payment date; a 53-week year; a DST transition on a rollover night; an offline outbox flushing 40 entries with three duplicates; a trip crossing the international date line eastward and westward; a trip whose envelope is overspent on day 3 of 10; a trip declared, funded, then cancelled; a seeded 2-week trip asserting the 12-week unplanned ratio is **unchanged**; a bi-weekly source over a full year yielding exactly 26 arrivals and exactly two extra-arrival months; a semi-monthly source on the 30th across February; three concurrent sources on different cadences in one period; a zero-decimal trip currency round-tripping through entry, storage and display; and a rate edit leaving local amounts byte-identical. Every one of these is a real bug you will otherwise ship.

**If a metric can't be gamed, it isn't measuring adherence.** Log adherence is trivially gamed by filing empty days — which is _fine and intended_, because the streak's job is to keep the app open nightly, not to be an honest spending record. Don't "fix" this.

---

## Spec 12 — Risks & Failure Modes

| Risk                                                                                                                                                                                                                                             | Severity   | Mitigation                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Over-engineering before shipping.** You build the trends heatmap, the Sankey and the dumbbell chart before logging a single real transaction. This is the most likely way the project fails.                                                   | **High**   | Phase 1 is Today + Log + SQLite and nothing else. No chart library installed until Phase 3. Enforce by making Phase 1 a separate, mergeable milestone.                                                                             |
| **Feature creep into the Today screen.** "Just the Spend balance" gets added in month two and the entire evidential basis of the design is gone.                                                                                                 | **High**   | The type-level guard in Spec §4.2. `todayView()`'s return type has no balance field. Make it a compile error, not a code review.                                                                                                   |
| **The design skills win the argument.** They're trained on dense, rich dashboards and will confidently suggest a KPI row or stat grid on Today. Their advice is correct in general and wrong here, which is the hardest kind of wrong to resist. | **High**   | The conflict rule in Spec §8.0: skills govern craft, this spec governs density. Every rejected suggestion gets a one-line note in the commit, so the reasoning survives past the moment.                                           |
| **Polish substitutes for progress.** The design skills make the UI enjoyable to work on, and Phase 1 quietly becomes six weeks of refining the hero's kerning.                                                                                   | **Medium** | Phase 1 is done when you can log a transaction and see tomorrow's number — not when it looks finished. Ship it ugly-but-good rather than beautiful-but-late; Spec §8.0b is a standard for the built thing, not a gate on shipping. |
| **The user stops logging and the app becomes a museum.**                                                                                                                                                                                         | **High**   | Phase 0 tests this _before_ code exists. Forgiving streak logic, no backfill flow, one-tap zero-day.                                                                                                                               |
| **Irregulars ledger drifts from reality** because instances stop getting settled — app reports healthy coverage while the real account is empty.                                                                                                 | **High**   | Forced three-way reconciliation in the monthly ritual (Spec §4.3). Never allow "dismiss".                                                                                                                                          |
| **Data loss.** One SQLite file on a Pi with no backup.                                                                                                                                                                                           | **High**   | `VACUUM INTO` nightly + rclone off-box + `GET /api/export.json`. Test the _restore_ in Phase 2, not the backup. An untested backup is not a backup.                                                                                |
| **Financial data exposed.** A budgeting app on a public IP with a single password is a bad idea.                                                                                                                                                 | **High**   | No WAN ingress in Tier A/B. Tailscale ACL. If you ever expose it, that's a different threat model and a different spec.                                                                                                            |
| **A trip poisons the metrics.** Two weeks at 4× normal spend smears the rolling averages and the system looks broken for a quarter — the most likely way travel kills adherence.                                                                 | **High**   | Query-layer `trip_id IS NULL` default (Spec §4.5), not a per-metric filter. Golden test asserts a seeded trip leaves the 12-week unplanned ratio unchanged.                                                                        |
| **Trip declared but never funded** — booked in March, envelope empty in June, and it silently eats two periods of Spend.                                                                                                                         | **Medium** | The 14-day funding check with three forced options and no dismiss. A `planned` trip with no linked `irregular_instance` is a validation error at declare time, not a warning.                                                      |
| **Bi-weekly modelled as 24 arrivals** (or any cadence converted via ÷12 instead of calendar projection). Silent ~8% error, and the three-paycheck month reads as a windfall in the wrong months.                                                 | **High**   | `projectArrivals()` is the only path to an allocation. Golden test: a bi-weekly source over a full year yields exactly 26 arrivals and flags exactly two extra-arrival months. Treat any `× 12` on an income figure as a bug.      |
| **Zero-decimal currency fat-finger.** `trip.local_minor_units` inherits 2 from settings, user types ¥1000 and logs ¥100000. First purchase abroad, unfamiliar currency, no intuition to catch it.                                                | **High**   | `local_minor_units` required at trip creation, keypad suppresses the decimal point when 0, and an entry >10× the trip daily figure prompts a confirm.                                                                              |
| **Rate edit rewrites history** because home-currency amounts were stored as source of truth instead of derived.                                                                                                                                  | **Medium** | `amount_local_minor` is authoritative for trip txns; home amounts recompute. Golden test asserts local amounts are byte-identical after a rate edit.                                                                               |
| **Arrivals silently move the daily number**, reintroducing mid-period drift.                                                                                                                                                                     | **Medium** | `POST /income/?/record` has no write path to `period.daily_allowance_minor`. Only `/periods/?/open` writes it.                                                                                                                     |
| **Timezone bugs at the trip boundary** — a day logged twice or skipped when the day boundary moves to `trip_tz`.                                                                                                                                 | **Medium** | `log_day` keyed on a date string is the sole streak authority, so 23- and 25-hour days are ordinary rows. Golden test covers an eastward and a westward crossing.                                                                  |
| **`tripDailyFigure()` and `dailyAllowance()` get "unified"** by a future refactor that notices they're nearly the same function, silently reintroducing end-of-period acceleration.                                                              | **Medium** | Cross-referencing comments on both (Spec §6.1, Spec §6.1b) plus a test asserting `dailyAllowance` output is invariant to the day of the period.                                                                                    |
| **Money stored as floats.** Silent, cumulative, and discovered a year in.                                                                                                                                                                        | **Medium** | Integer minor units everywhere, enforced by the Drizzle schema; a lint rule banning `parseFloat` in `src/lib/money`.                                                                                                               |
| **Timezone and DST bugs at period rollover.** A period that's 23 or 25 hours long, or a day logged twice.                                                                                                                                        | **Medium** | Store dates as local `YYYY-MM-DD` strings, never as UTC timestamps, for anything user-facing. Golden test covers a DST night.                                                                                                      |
| **iOS PWA storage eviction** loses queued offline entries.                                                                                                                                                                                       | **Medium** | Flush on every foreground; visible unsynced count; never treat IndexedDB as durable.                                                                                                                                               |
| **Oracle free tier shrinks again** (it did, silently, in June 2026) and the instance won't restart.                                                                                                                                              | **Medium** | Tier A as the default. Keep the whole thing to one container + one file so migration is an afternoon.                                                                                                                              |
| **The 15% haircut feels like the app lying to you** once you notice money accumulating.                                                                                                                                                          | **Low**    | Expose it in Settings, show the swept surplus explicitly at period close, explain it once during setup.                                                                                                                            |
| **Single-user assumption breaks** if a partner wants in.                                                                                                                                                                                         | **Low**    | Accept it. Adding multi-tenancy later is a rewrite of the auth boundary, and pre-building it costs you Phase 1.                                                                                                                    |

---

## Spec 13 — Roadmap

Estimates assume evenings and weekends, and are deliberately larger than feels comfortable.

### Phase 0 — Spike (2–3 weeks, no code) ⚠️ do not skip

**The riskiest assumption in this entire project is not technical.** It is that you will log every night. If that's false, the best-architected app in the world is a museum piece, and you'd have spent two months finding out.

Test it with **zero code**: a note on your phone, or a three-column spreadsheet — date, amount, category, planned/unplanned. Nightly, for 21 days. Also hand-run one weekly review on paper and send the one-liner to someone.

**Kill criterion:** if adherence is below 60% over 21 days, **do not build the app**. The ritual is wrong, not the tooling — move the cue (Spec § Method Part III: event-anchored, not time-anchored), shorten the entry, or drop to a 3-category taxonomy, and re-run the 21 days. An app cannot fix a ritual you won't perform; it can only make an unperformed ritual more expensive.

**Secondary output:** those 21 days of real data become your Phase 1 seed fixture and your day-2 calibration, so the spike is not throwaway even when it passes.

### Phase 1 — Walking skeleton (2–3 weeks)

**First: install the design skills (Spec §8.0) and read them before the first component.** Retrofitting craft onto a built UI costs more than doing it once, and Phase 1's Today screen is the screen you'll look at every night for the next year — it's the one that most deserves the attention.

Today screen + log form + SQLite + one manually-created period. No charts, no review wizard, no irregulars, no auth beyond being on your own network. The daily band computed from a hand-entered `spend_allocation`.

**Ship this and use it for three weeks before writing another line.** If Phase 1 alone carries you for three weeks, that is the strongest possible signal about what to build next — and it will not be what you currently think.

### Phase 2 — The ritual layer (2–3 weeks)

Weekly review wizard (all six steps), the `review` table and metric snapshots, the shareable one-liner, streak logic, period rollover and the nightly job runner. Backup + tested restore. This is the phase that makes the system _work_, per **F7**.

### Phase 3 — Irregulars & phases (3–4 weeks)

The irregulars engine, coverage ratio, reconciliation prompt, the phase engine, the Money Map with IOUs. This is the highest-value phase after Phase 2 and the most logic-heavy. Charts arrive here — Observable Plot goes in now, not earlier.

**Ship the metric quarantine in this phase even though Trip Mode isn't built.** `trip_id` goes on `txn` and `AND trip_id IS NULL` goes into the shared selector now, while there are three metric queries instead of fifteen. Retrofitting it after the trends grid exists means auditing every query and re-deriving historical numbers. The column stays null until Phase 4; the discipline is what you're installing.

### Phase 4 — Trips, debt, trends & polish (3–4 weeks)

Trip Mode end to end (Spec §4.5) — declare, funding check, activate, trip-currency logging, settle — plus the Trips screen. Payoff price switch, the trends grid and heatmap, the dumbbell calibration chart, PWA offline outbox, rules and 72-hour list, the setup wizard, export/import.

Trip Mode sits here rather than earlier for a reason: it depends on the irregulars engine (Phase 3) for funding, and it is the one subsystem you can safely skip on your first trip by just tagging the spend and moving on. But if a trip is coming up inside the next three months, promote the declare → fund → settle path ahead of the charts. The funding check is the part that earns its keep; the burn-down chart is decoration.

### Phase 5 — Only if still using it after six months

Web push, the annual rebuild wizard, dark mode authoring, whatever the last six months proved you actually needed. **Not before.** Six months of use is the qualification for this phase; nothing else is.

**Total to a genuinely complete system: ~12–16 weeks of evenings.** Phase 1 alone is 2–3 weeks and is genuinely useful, which is the entire point of the phasing.

---

## Spec 14 — Open Questions

Decide these before Phase 1.

**Q1 — Single-user local, or multi-user with accounts?**
_Suggested default: single-user, no login, network-isolated._ You asked for a personal dashboard, and every line of this spec assumes it. Multi-tenancy is not a feature you add later — it's a rewrite of the data model's ownership column and the entire auth boundary. If there's any real chance a partner or a friend uses it, say so now, because it changes Spec §5 fundamentally.

**Q2 — Manual-only, or a bank/e-wallet import path eventually?**
_Suggested default: manual only, permanently, with CSV import restricted to the day-2 historical calibration._ **F6** says automated tracking lowers the self-awareness that produces the behaviour change — so this is a deliberate design position, not a limitation. If you disagree, the compromise is: import for the _90-day calibration_ and for _reconciliation only_, never for the daily log.

**Q3 — Does the app hold balances at all, or only allocations?**
_Suggested default: hold user-asserted balances, updated weekly at Review step R1._ The alternative — deriving balances from logged flows — sounds cleaner and will drift within a month, because you will not log every bank fee. Manual weekly assertion is both more accurate and, per **F7**, part of the intervention.

**Q4 — One home currency, plus per-trip currency at a locked rate?**
_Suggested default: yes — one home currency for all accounts and periods, with a trip carrying its own currency at a single rate frozen at trip start (Spec §4.5)._ This buys travel support for one `REAL` column and no external dependency. Full multi-currency — an FX source, historical rates per period, "which currency is my buffer in" — is a genuine subsystem and only worth it if you're actually _earning_ in two currencies, which is a different question from spending in two.

**Q5 — Does Phase 1 ship the withholding layer, or is it a Phase 2 refinement?**
_Suggested default: Phase 1, as a type-level guard._ It is three lines of type definition on day one and a painful refactor in month three, and it is the thesis of the whole design. Building the Today screen with balances on it "just for now" is how the thesis quietly loses.

---

## Spec Appendix A — Seed data

Ship the app with these pre-populated so setup isn't a blank page:

- **8 categories** — fixed, not user-editable (Method Part II). Making them editable is how you end up with forty.
- **6 accounts** — Inflow, Bills, Spend, Irregulars, Buffer, Grow. Grow archived until Phase 3.
- **~18 default if-then rules** — the full Part V list, editable, grouped into the five categories. Pre-populating these matters: **F8** is the highest effect size in the plan (d = 0.65) and a blank rules page gets zero rules written.
- **~24 candidate irregulars** — the Part III annual inventory as unchecked suggestions, so day 3 is a review rather than a recall task. Recall is exactly what **F10** says fails.

## Spec Appendix B — Source of every design constraint

| Constraint in this spec                                         | Plan finding | What it prevents                                                                 |
| --------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------- |
| No live remaining balance; band not figure                      | F5           | End-of-period spending acceleration                                              |
| Spending pool undivided; savings finely partitioned             | F5, F4       | Mental-accounting justification; flat savings                                    |
| Manual entry required; no bank sync                             | F6           | Attention loss from automated aggregation                                        |
| `review` row + share button                                     | F7           | Unmonitored, unrecorded, private progress (d = 0.40)                             |
| Pre-seeded if-then rules                                        | F8           | Intention–action gap (d = 0.65)                                                  |
| Daily band, never monthly total                                 | F9           | 4× lower engagement; income-based participation gap                              |
| Mandatory +25% padding; irregulars engine                       | F10          | The ~30% underestimate; exceptional-expense blindness                            |
| Spend account is debit-only in setup copy                       | F11          | Up to 100% willingness-to-pay premium                                            |
| Weekly tranches on a monthly period                             | F4           | A month of Spend physically reachable in one impulse                             |
| Arrivals never move the open period's daily number              | F5           | Mid-period drift and end-of-period acceleration                                  |
| Irregular sources budgeted at MIN of 3 months, mean never shown | F10          | Budgeting to an average you hit half the time                                    |
| Trip = funded irregular, not a spending period                  | F10          | Travel excluded from the budget as a "one-off" while being perfectly predictable |
| Trip currency conversion shown live while typing                | F11          | Weakened pain of paying in unfamiliar currency                                   |
| Trip spend quarantined from ongoing metrics                     | F5, F10      | A two-week 4× smear making three months of trends unreadable                     |
| Payoff price switch, not a doctrine                             | F12          | Paying for motivation without knowing the price                                  |
| Quarterly audit as a first-class ritual                         | F13          | Effect decay after ~6 months                                                     |
| Phase 1 exit = 6 weeks, not 6 months                            | F14          | An unreachable first milestone                                                   |
| Immutable period snapshots                                      | F5           | `balance ÷ days_remaining` ever existing in the code                             |

## Spec Appendix C — Verification log

Volatile claims in this spec, with what was checked and when. Re-check anything here before you rely on it.

| Claim                                                                            | Source                                                                                                                                                                                                                 | Checked    |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Node 26 is Active LTS; 24's active support ends Oct 2026                         | [endoflife.date/nodejs](https://endoflife.date/nodejs)                                                                                                                                                                 | 2026-08-16 |
| Tailscale Personal: 6 users, unlimited user devices, non-commercial only         | [tailscale.com/pricing](https://tailscale.com/pricing)                                                                                                                                                                 | 2026-08-16 |
| Oracle Always Free A1 cut 4 OCPU/24 GB → 2 OCPU/12 GB on 2026-06-15, unannounced | [InfoQ](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/), [TerminalBytes](https://terminalbytes.com/oracle-cloud-free-tier-changes-2026/)                                                            | 2026-08-16 |
| Cloudflare D1 free: 5M rows read/day, 100k written/day, 5 GB                     | [developers.cloudflare.com/d1/platform/pricing](https://developers.cloudflare.com/d1/platform/pricing/)                                                                                                                | 2026-08-16 |
| Tailwind v4 installs via `@tailwindcss/vite`, no PostCSS chain                   | [npm @tailwindcss/vite](https://www.npmjs.com/package/@tailwindcss/vite), [tailwindcss.com/blog/tailwindcss-v4](https://tailwindcss.com/blog/tailwindcss-v4)                                                           | 2026-08-16 |
| iOS PWA push requires home-screen install; storage eviction on inactivity        | [MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide), [MobiLoud](https://www.mobiloud.com/blog/progressive-web-apps-ios) — **secondary sources; verify on-device in Phase 1** | 2026-08-16 |
| Drizzle supports SQLite with push migrations                                     | [orm.drizzle.team](https://orm.drizzle.team/docs/sqlite/get-started-sqlite)                                                                                                                                            | 2026-08-16 |
| The four design-skill repos in Spec §8.0 exist and expose those skill names      | **user-supplied, NOT verified** — confirm each URL resolves and the `--skill` name matches before relying on it                                                                                                        | —          |

---

# APPENDIX — Research sources

_Every finding cited as F1–F14 in Method Part I traces to one of these._

**Rules of thumb vs. formal accounting**

- Drexler, A., Fischer, G. & Schoar, A. (2014). [Keeping It Simple: Financial Literacy and Rules of Thumb](https://www.povertyactionlab.org/sites/default/files/research-paper/124_303%20Rules%20of%20Thumb%20AEJ%20Apr2014.pdf). _American Economic Journal: Applied Economics_, 6(2), 1–31. ([AEA listing](https://www.aeaweb.org/articles?id=10.1257/app.6.2.1))

**Defaults and automatic escalation**

- Madrian, B. & Shea, D. (2001). [The Power of Suggestion: Inertia in 401(k) Participation and Savings Behavior](https://www.nber.org/papers/w7682). _Quarterly Journal of Economics_, 116(4). ([summary of magnitudes](https://atticusli.com/replication-crisis/defaults-status-quo-anti-example/))
- Thaler, R. & Benartzi, S. (2004). [Save More Tomorrow: Using Behavioral Economics to Increase Employee Saving](https://besci.org/papers/benartzi-thaler-2004). _Journal of Political Economy_, 112(S1).

**Commitment savings**

- Ashraf, N., Karlan, D. & Yin, W. (2006). [Tying Odysseus to the Mast: Evidence from a Commitment Savings Product in the Philippines](https://academic.oup.com/qje/article-abstract/121/2/635/1884028). _QJE_, 121(2). ([J-PAL evaluation summary](https://www.povertyactionlab.org/evaluation/commitment-savings-products-philippines))

**Earmarking and partitioning**

- Soman, D. & Cheema, A. (2011). [Earmarking and Partitioning: Increasing Saving by Low-Income Households](https://www-2.rotman.utoronto.ca/facbios/file/earmarking-jmrPP.pdf). _Journal of Marketing Research_, 48(SPL), S14–S22.

**When budget information backfires**

- Heath, C. & Soll, J. B. (1996). [Mental Budgeting and Consumer Decisions](https://academic.oup.com/jcr/article-abstract/23/1/40/1892763). _Journal of Consumer Research_, 23(1), 40–52. [doi:10.1086/209465](https://doi.org/10.1086/209465). ([full text PDF](https://bear.warrington.ufl.edu/brenner/mar7588/Papers/heath-soll-jcr1996.pdf)) — the peer-reviewed basis for **F5**'s category half. Consumers really do set per-category budgets and really do track against them, and because a budget cannot anticipate the consumption opportunities that actually arrive, the earmark itself causes both over- and under-consumption. 764 citations. This is the citation **F5** should lead with, not the working paper below.
- Pocheptsova Ghosh, A. & Huang, L. (2022). _Dynamic Budget Monitoring: When Access to Budget Feedback Leads to Increase in Spending._ Think Forward Initiative / CEPR technical report. ([report PDF](https://cepr.org/system/files/2022-08/Dynamic%20Budget%20Monitoring%20-%20When%20Access%20to%20Budget%20Feedback%20Leads%20to%20Increase%20in%20Spending%20-%20Anastasiya%20Pocheptsova%20Ghosh%20&%20Liang%20Huang.pdf) · [plain-language summary](https://www.behavioraleconomics.com/the-budgeting-app-trap-when-spending-information-backfires/)) — three field studies and two lab experiments; app users overspent their budgets by roughly 26–33%, and of the six remedies tested, showing a **range** helped and **subdividing the budget** backfired.
  **Status, stated plainly: this is a working paper, not a peer-reviewed article.** It is the single most load-bearing citation in this document — §4.2's entire withholding layer rests on it — and it carries the least evidentiary weight of anything cited here. Heath & Soll (peer-reviewed, 764 citations) independently supports the category half; the _range-instead-of-a-number_ half has this source and no other. Treat Rule 2 as the design bet it is.

**Manual entry, and why the typing is the mechanism**

- Soman, D. (2001). [Effects of Payment Mechanism on Spending Behavior: The Role of Rehearsal and Immediacy of Payments](https://academic.oup.com/jcr/article-abstract/27/4/460/1810425). _Journal of Consumer Research_, 27(4), 460–474. [doi:10.1086/319621](https://doi.org/10.1086/319621). ([full text PDF](https://www-2.rotman.utoronto.ca/facbios/file/paymechjcr.pdf)) — 466 citations. Past payments suppress the next purchase **only when the payment mechanism made the consumer write the amount down** (rehearsal) and when wealth was depleted immediately rather than on a delay. This is the direct evidence for Invariant 3 and for R1's typed balances: the recording step is not bookkeeping overhead attached to the intervention, it _is_ the intervention, and an automatic bank feed removes precisely the rehearsal that does the work.

**Manual vs. automated tracking**

- Zhang, Y. (2023). [How Does Expense-Tracking Inform Financial Behaviors?](https://www.consumerinterests.org/assets/docs/CIA/CIA2023/ZhangYilingCIA2023.pdf) Consumer Interests Annual.

**Progress monitoring**

- Harkin, B. et al. (2016). [Does Monitoring Goal Progress Promote Goal Attainment? A Meta-Analysis of the Experimental Evidence](https://eprints.whiterose.ac.uk/id/eprint/87431/). _Psychological Bulletin_, 142(2). ([PubMed](https://pubmed.ncbi.nlm.nih.gov/26479070/))

**Implementation intentions**

- Gollwitzer, P. & Sheeran, P. (2006). [Implementation Intentions and Goal Achievement: A Meta-Analysis of Effects and Processes](https://www.sciencedirect.com/science/chapter/bookseries/abs/pii/S0065260106380021). _Advances in Experimental Social Psychology_, 38. ([effect-size summary](https://goalsandprogress.com/implementation-intentions-gollwitzer-how-to/))

**Temporal framing of savings targets**

- Hershfield, H., Shu, S. & Benartzi, S. (2020). [Temporal Reframing and Participation in a Savings Program: A Field Experiment](https://pubsonline.informs.org/doi/10.1287/mksc.2019.1177). _Marketing Science_, 39(6). ([full text PDF](https://www.halhershfield.com/s/Hershfield_Shu_Benartzi_Temporal-Reframing-and-Participation-in-a-Savings-Program_2019.pdf))

**Expense prediction bias**

- Sussman, A. & Alter, A. (2012). [The Exception Is the Rule: Underestimating and Overspending on Exceptional Expenses](https://ideas.repec.org/a/oup/jconrs/doi10.1086-665833.html). _Journal of Consumer Research_, 39(4), 800–814.
- Peetz, J. & Buehler, R. (2009). [Is There a Budget Fallacy? The Role of Savings Goals in the Prediction of Personal Spending](https://pubmed.ncbi.nlm.nih.gov/19713568/). _PSPB_.
- [Predictions on the Go: Prevalence of Spontaneous Spending Predictions](https://www.cambridge.org/core/journals/judgment-and-decision-making/article/predictions-on-the-go-prevalence-of-spontaneous-spending-predictions/0192B33486058C158E573D7DC797B8AC). _Judgment and Decision Making_.

**Pain of paying**

- Prelec, D. & Simester, D. (2001). [Always Leave Home Without It: A Further Investigation of the Credit-Card Effect on Willingness to Pay](https://link.springer.com/article/10.1023/A:1008196717017). _Marketing Letters_, 12(1).

**Debt payoff ordering**

- Brown, A. L. & Lahey, J. N. (2015). [Small Victories: Creating Intrinsic Motivation in Task Completion and Debt Repayment](https://journals.sagepub.com/doi/10.1509/jmr.14.0281). _Journal of Marketing Research_, 52(6). ([working paper PDF](https://files.consumerfinance.gov/f/documents/P2d_-_Brown_-_Small_Victories.pdf) · [NBER w20125](https://www.nber.org/papers/w20125))
- Hamilton, S. (2023). [Two Steps Forward, One Step Back? Quantifying the Pecuniary Costs of Debt Account Aversion and the Debt Snowball](https://onlinelibrary.wiley.com/doi/full/10.1002/soej.12612). _Southern Economic Journal_.

**Does financial education work at all**

- Kaiser, T., Lusardi, A., Menkhoff, L. & Urban, C. (2022). [Financial Education Affects Financial Knowledge and Downstream Behaviors](https://www.nber.org/system/files/working_papers/w27057/w27057.pdf). _Journal of Financial Economics_, 145(2), 255–272.
- Fernandes, D., Lynch, J. & Netemeyer, R. (2014). [Financial Literacy, Financial Education, and Downstream Financial Behaviors](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2333898). _Management Science_, 60(8).

**How much buffer you actually need**

- Farrell, D., Greig, F. & Yu, C. (2019). [Weathering Volatility 2.0: A Monthly Stress Test to Guide Savings](https://www.jpmorganchase.com/content/dam/jpmc/jpmorgan-chase-and-co/institute/pdf/institute-volatility-cash-buffer-report.pdf). JPMorgan Chase Institute.
- Federal Reserve (2026). [Report on the Economic Well-Being of U.S. Households in 2025 — Savings and Investments](https://www.federalreserve.gov/publications/2026-economic-well-being-of-us-households-in-2025-savings-investments.htm).

**The 50/30/20 origin**

- Warren, E. & Tyagi, A. W. (2005). _All Your Worth: The Ultimate Lifetime Money Plan._ ([overview](https://www.quicken.com/blog/how-budget-your-money-elizabeth-warrens-50-20-30-rule/))
