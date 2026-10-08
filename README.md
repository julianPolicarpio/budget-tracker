# Longhand

Longhand is a manual-entry budgeting app that gives daily spending guidance as a range instead of showing a remaining balance. It is built for someone who wants a brief spending check-in and a more detailed weekly review.

The Today screen keeps the daily decision narrow: enter a purchase, mark a day with nothing to log, and see the spending band set when the period opened. Account balances and exact remaining amounts live outside that screen. The [product background](docs/product-background.md) explains the design choices and links to the longer research spec.

## What it does

- Sets a daily spending band from the period allocation without raising it after an underspend.
- Records purchases manually, including a typed entry path that asks for clarification when the record type is ambiguous.
- Supports income arrivals, fixed bills, savings allocations, and a first-run setup flow.
- Keeps a weekly review, irregular expenses, subscriptions, debt, trips, and account transfers in separate screens.
- Offers a demo through the sign-in page. The demo creates an isolated, prefilled user with 90 days of sample history; it expires after 24 hours.

There is no bank, card, or e-wallet connection. The app is not a bank ledger or accounting system; its daily screen is intentionally less precise than its review and account screens.

## Run locally

Use a current Node.js release compatible with the repository's SvelteKit and Vite versions. From the repository root:

```bash
npm ci
npm run db:migrate
npm run dev -- --host 127.0.0.1
```

On a fresh database, `db:migrate` has migrations to apply. A later run with none pending currently fails while printing status: [`scripts/migrate.js`](scripts/migrate.js) references an undefined `files` variable in that branch (line 25). The migrations may already be applied; this is a reporting-path bug, not evidence that a rerun succeeded. The issue is documented here, not fixed in this README draft.

The migration runner records applied filenames in the database and executes each pending SQL file in its own transaction. Its output is useful for confirming the initial setup; the rerun caveat above still applies.

Open the loopback URL printed by Vite (normally `http://127.0.0.1:5173`). With no `GOOGLE_CLIENT_ID` and a loopback host, requests use the local owner account. Complete the questions at `/setup` to create the first spending period. The default database path is `data/split.db`; set `DATABASE_URL` to a separate SQLite path before migrating and starting if you want an isolated local database. Use the same value for both commands.

The demo button is a form on `/signin` when Google sign-in is configured. Its route accepts `POST /demo`, so a plain link to `/demo` does not start a demo.

### First session

After migration, local single-user mode assigns requests to the seeded owner. Setup asks for currency, timezone, income timing, an estimate for fixed bills, and the spending period. The app then opens the initial period. This differs from the repository's older `db:init` script, which still targets the pre-tenant settings shape; use the current `/setup` flow for a fresh local database.

The application stores amounts as integer minor units. Its database connection enables SQLite WAL and foreign keys. These details matter when inspecting calculations and migrations, but they do not replace checking the numbers against your own records.

### Authentication modes

With `GOOGLE_CLIENT_ID` absent, the local fallback only accepts a loopback `HOST`. With a Google client ID set, the app also expects `GOOGLE_CLIENT_SECRET` and `PUBLIC_ORIGIN`. See the configuration branch in [`auth.ts`](src/lib/server/auth.ts) before setting up a shared deployment. Do not put credentials in the repository.

## Development checks

These commands are defined in [`package.json`](package.json):

```bash
npm run check
npm test
```

`npm test` runs the Vitest suite. Tests that touch the database use temporary paths; the database module rejects test-mode imports without `DATABASE_URL` to avoid opening the default data file. The migration files are in [`migrations/`](migrations/). Do not treat a passing test suite as a security audit.

## Points worth reviewing

| Area | Where to start | What to inspect |
| --- | --- | --- |
| Session lifecycle | [`src/lib/server/auth.ts`](src/lib/server/auth.ts), [`src/hooks.server.ts`](src/hooks.server.ts), [`src/routes/signout/+server.ts`](src/routes/signout/+server.ts) | Random session IDs, stored expiry and renewal, row deletion on sign-out, and cookie attributes. `Secure` is set for HTTPS requests; local HTTP remains usable. |
| Google identity | [`src/lib/server/google-oauth.ts`](src/lib/server/google-oauth.ts), [`src/routes/auth/google/callback/+server.ts`](src/routes/auth/google/callback/+server.ts) | Authorization-code callback and use of Google's subject ID rather than email as the user key. |
| Account isolation | [`src/lib/server/db/index.ts`](src/lib/server/db/index.ts), [`src/lib/server/tenancy.test.ts`](src/lib/server/tenancy.test.ts) | `forUser(userId)` and its `owns(table)` condition, plus the two-user test. The unscoped `unsafeDb` handle is exported for narrow global operations and should be reviewed at each use. |
| Daily view | [`src/lib/server/withholding.ts`](src/lib/server/withholding.ts), [`src/lib/allowance.ts`](src/lib/allowance.ts) | The withholding type and the allowance calculation used to keep an exact balance off Today. |
| Authentication tests | [`src/lib/server/auth.test.ts`](src/lib/server/auth.test.ts) | Session creation, expiry, revocation, Google-user provisioning, and configuration cases. |

Single-user mode attributes every request to the owner, so its loopback gate is a deployment boundary. The schema's `user_id` defaults to the owner on some tables for migration reasons; review `forUser` call sites and any direct `unsafeDb` use rather than treating the column alone as isolation. The two-user test covers selected paths, not a production security audit.

The import route assigns the current session's user ID to imported rows. JSON and CSV export paths query by user ID. Inspect [`src/routes/api/import/+server.ts`](src/routes/api/import/+server.ts) and the export handlers when changing their table lists or queries, because they handle financial records.

Demo accounts use the same user-scoping mechanism as ordinary accounts. Their seed data is generated in [`src/lib/server/demo.ts`](src/lib/server/demo.ts), and a cleanup path removes old demo users. That is useful for trying the interface, but the sample figures are examples rather than budgeting advice.

## Project notes

The research and calculation rules are documented in [`split-combined-spec.md`](split-combined-spec.md). [`CONTRIBUTING.md`](CONTRIBUTING.md) covers the project's working agreements. The older working name `split` remains in paths and environment names.

The [original README](README.original.md) is preserved for its full product narrative and references. It is a historical document: parts of its setup, single-user, and unfinished-feature descriptions predate the current source. Use the paths above for present behavior.

There is no root license file. Check permission with the repository owner before redistributing the code.

This project used AI assistance during development. The code, tests, and documents should be reviewed on their own merits rather than read as a claim that every line was written by one person.
