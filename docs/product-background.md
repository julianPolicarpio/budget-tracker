# Longhand product background

Longhand starts with a simple choice: entering a purchase by hand is part of the budgeting routine. Today shows a spending band, not a live balance or an exact amount left to spend. The fuller account picture belongs in review screens, where it is needed to plan and reconcile money.

The [original README](../README.original.md) makes a longer argument for these choices and cites research on payment rehearsal, mental budgeting, and feedback from tracking apps. It is preserved as a historical account; some setup, single-user, and unfinished-feature descriptions no longer match the source. The live design record is the repository-root [`split-combined-spec.md`](../split-combined-spec.md), especially Part One and its references. The spec also notes that the range-instead-of-an-exact-number rule draws on a working paper, not a peer-reviewed result. These studies motivated the design; they do not prove this app improves anyone's financial outcomes.

The mechanics reflect that choice. A period's daily allowance is set when it opens. Manual transactions record what happened, while categories help the weekly review rather than imposing separate spending limits. Bills and other commitments are reserved before the daily spending figure is calculated. Trip spending is handled separately so it does not change ordinary spending metrics.

The repository has since evolved beyond its original single-user description. Google sign-in, account-scoped data, and isolated demo users are now implemented. The current [`README.md`](../README.md) describes those paths and points to source and tests for review.
