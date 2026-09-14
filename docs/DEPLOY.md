# Deploying Split

Two deployments exist. The first is done. The second needs an account and a
card, which is why it is a runbook rather than a script.

## 1. Your Mac (done, 2026-09-14)

`npm run deploy` builds and restarts the launchd job. Migrations run at startup,
so a process that is up is a process whose schema is current.

Single-user mode, because `GOOGLE_CLIENT_ID` is unset and `HOST` is loopback:
every request is attributed to user 1 and there is no sign-in screen.
`resolveAuthMode()` in `src/lib/server/auth.ts` decides this, and refuses to
start if the bind is *not* loopback while sign-in is unconfigured.

**Before any deploy that includes a migration**, take a snapshot that survives
a bad one:

```bash
sqlite3 data/split.db "VACUUM INTO '/tmp/split-before-deploy.db';"
```

`VACUUM INTO`, never `cp`: the database runs in WAL mode and a file copy takes
the main file without the write-ahead log, silently losing recent writes.

To roll back, `scripts/restore.js` replaces the live file and keeps a safety
copy of what it overwrote.

## 2. A public server (not done — needs you)

Three things cannot be automated from here, because each needs an account and a
payment method:

| Thing | Why it is yours | Rough cost |
|---|---|---|
| A VPS | Requires a card | Oracle Always Free (Singapore, ~40 ms from Manila) if capacity allows, otherwise ~₱150–250/mo |
| A domain | Requires a registrar account | ~₱600–900/yr |
| Google OAuth credentials | Requires signing into your Google account | free |

Everything else is built.

### Why not serverless

`better-sqlite3` holds a WAL file on disk and `node-cron` runs the nightly jobs
in-process. Both need a machine that stays up with a real filesystem. Moving to
Vercel would mean replacing SQLite and the scheduler — that is rebuilding the
app, and it destroys the line the Dockerfile is built around: *the entire
disaster-recovery plan is copy `split.db` to the new box.*

### Getting the OAuth credentials

1. console.cloud.google.com → a new project
2. APIs & Services → OAuth consent screen → External
3. Credentials → Create → OAuth client ID → Web application
4. Authorised redirect URI: `https://your-domain/auth/google/callback`
5. Keep the client ID and secret; they go in the environment below

### Running it

```bash
docker compose up -d
```

with these set:

```
HOST=0.0.0.0                 # correct in a container; the port publish governs reach
PUBLIC_ORIGIN=https://your-domain
ORIGIN=https://your-domain
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
DATABASE_URL=/app/data/split.db
TZ=Asia/Manila
```

All three Google variables together, or none. `resolveAuthMode()` refuses a
half-configured state rather than falling back to something insecure.

TLS in front: Caddy is two lines and renews itself.

### Backups, which now hold other people's money

The nightly job writes to `data/backups/` on the same disk as the database. That
survives a bad migration and nothing else — not a lost VPS, not a dead volume.

```bash
SPLIT_BACKUP_PASSPHRASE='...' npm run backup:offsite
```

One AES-256 file via openssl and PBKDF2. It refuses to run without a passphrase,
deletes the plaintext snapshot even on failure, and ships nothing anywhere —
pipe it wherever it belongs:

```bash
scp "$(SPLIT_BACKUP_PASSPHRASE='...' node scripts/backup-offsite.js --quiet)" \
    you@elsewhere:/backups/
```

Keep the passphrase somewhere that is **not** this server. A passphrase stored
beside the thing it protects protects nothing.

Decryptable by anyone with openssl, with or without this repo:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -in split-2026-09-14.db.enc -out split.db
```

## Before real strangers have accounts

One thing is worth doing that no test can do for you.

The two-tenant leak test in `src/lib/server/tenancy.test.ts` drives every read
path as user A and asserts zero rows of user B come back. It is green. But it is
green against *an enumeration of the read paths*, and an enumeration is only as
complete as whoever wrote it.

Before anyone else's financial history is in this database, read
`src/lib/server/` looking for a query that does not go through `forUser()`, and
add it to that test. The three export and import endpoints were found exactly
that way, after the first sweep called itself finished.
