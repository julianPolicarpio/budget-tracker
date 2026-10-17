/**
 * The nightly job runner (Spec §3).
 *
 * In-process cron, not a separate service. Four idempotent daily jobs do not
 * justify a queue, a worker or a scheduler container — see Spec §12's
 * over-engineering row.
 *
 * Every job is **idempotent and keyed by the local date**, because a home
 * server reboots and a cron tick gets skipped. A missed run is caught up at
 * startup; a double run is a no-op. Both properties come from `job_run`, not
 * from hoping the process stays alive.
 */

import cron from 'node-cron';
import { and, eq } from 'drizzle-orm';
import { forUser, schema, sqlite } from './db';
import { runBackup } from './backup';
import { runRollover } from './rollover';
import { materialise } from './irregulars';
import { proposePhaseChange } from './phases';
import { pendingAlerts, recordAlert } from './subscriptions';
import { notify } from './notify';
import { localToday } from './clock';
import { loadSettings } from './today';
import { reapDemoUsers } from './demo';
import { dirname, join } from 'node:path';
import { demoModeEnabled } from '../../../scripts/demo-guard.js';

export type JobKey = 'rollover' | 'irregulars' | 'backup';

const JOB_KEYS = ['rollover', 'irregulars', 'backup'] as const satisfies readonly JobKey[];

/**
 * The date-keyed jobs this process runs. A public demo has no reason to write
 * backups next to its database, and runBackup also prunes that directory, so
 * demo mode drops the backup and keeps rollover and irregulars.
 */
export function scheduledJobKeys(env: NodeJS.ProcessEnv = process.env): JobKey[] {
	return demoModeEnabled(env) ? JOB_KEYS.filter((k) => k !== 'backup') : [...JOB_KEYS];
}

/** How often to re-ask whether a date-keyed job still owes a run. */
const CATCH_UP_INTERVAL_MS = 15 * 60_000;

const BACKUP_DIR = join(dirname(process.env.DATABASE_URL ?? 'data/split.db'), 'backups');

/**
 * Every account that can still own work — the nightly sweep is per user now
 * (Spec §3.2), so this is the one place that enumerates "everyone". A raw
 * SQL query, not the unscoped Drizzle handle: it is the one legitimately
 * global read this module needs, since asking "which users exist" cannot
 * itself be scoped to a user.
 */
function liveUserIds(): number[] {
	return (
		sqlite.prepare(`SELECT id FROM app_user WHERE deleted_at IS NULL`).all() as { id: number }[]
	).map((r) => r.id);
}

function alreadyRan(userId: number, jobKey: JobKey, forDate: string): boolean {
	const { db, owns } = forUser(userId);
	return (
		db
			.select()
			.from(schema.jobRun)
			.where(
				and(owns(schema.jobRun), eq(schema.jobRun.jobKey, jobKey), eq(schema.jobRun.ranFor, forDate))
			)
			.get() !== undefined
	);
}

function recordRun(userId: number, jobKey: JobKey, forDate: string, detail: string, now: Date): void {
	const { db } = forUser(userId);
	db.insert(schema.jobRun)
		.values({ jobKey, ranFor: forDate, ranAt: now.toISOString(), detail, userId })
		.onConflictDoNothing()
		.run();
}

/**
 * Run one job for every live user, unless a given user's copy already ran
 * today. Returns the detail of the last user actually run, or null if nobody
 * had work outstanding — same contract as the single-user version had, which
 * is exactly what a one-user database (every test harness) still sees.
 */
export function runJob(jobKey: JobKey, now: Date = new Date()): string | null {
	let lastDetail: string | null = null;

	for (const userId of liveUserIds()) {
		const settings = loadSettings(userId);
		if (!settings) continue;

		const forDate = localToday(settings.timezone, now);
		if (alreadyRan(userId, jobKey, forDate)) continue;

		let detail: string;
		if (jobKey === 'rollover') {
			const r = runRollover(userId, forDate, settings, now);
			detail = `closed ${r.closed.length}, opened ${r.opened.length}`;
		} else if (jobKey === 'irregulars') {
			// Project instances 24 months forward, then check whether the current
			// phase's exit has cleared. The phase check only ever *proposes*.
			const written = materialise(userId, forDate, now);
			const proposal = proposePhaseChange(userId, settings, forDate);
			detail = `materialised ${written}` + (proposal ? `, proposed phase ${proposal.toPhase}` : '');
		} else {
			// The backup is of the one shared SQLite file, not of a user's data —
			// still recorded per user so job_run's key matches every other job.
			const b = runBackup(sqlite, BACKUP_DIR, forDate);
			detail = `${b.bytes} bytes, pruned ${b.pruned.length}`;
		}

		recordRun(userId, jobKey, forDate, detail, now);
		lastDetail = detail;
	}

	return lastDetail;
}

/**
 * Deliver any subscription deadline that has entered its warning window.
 *
 * Deliberately NOT a `JobKey`. The three date-keyed jobs ask "did I already
 * run for today's date", which is exactly right for work that must happen once
 * per day and is worthless if late — a rollover for a date that has passed has
 * been overtaken by events. It is exactly wrong for a deadline warning: a Mac
 * asleep across the target date would mark nothing, ask nothing, and the alert
 * would never fire at all.
 *
 * So the state lives on the subscription row and this re-asks every sweep
 * until the OS has actually accepted the notification. A twelve-month-out
 * deadline then only fails if the server is down for the whole lead window.
 */
export async function runSubscriptionAlerts(now: Date = new Date()): Promise<number> {
	let delivered = 0;

	for (const userId of liveUserIds()) {
		const settings = loadSettings(userId);
		if (!settings) continue;

		const today = localToday(settings.timezone, now);

		for (const { sub, stage, daysLeft } of pendingAlerts(userId, today)) {
			const when = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
			const ok = await notify({
				title: stage === 2 ? `Last call: ${sub.label}` : `${sub.label} renews ${when}`,
				subtitle: sub.vendor ?? undefined,
				// No amount. The decision is keep-or-cancel; quoting the price here
				// invites haggling with yourself instead of answering the question.
				body:
					sub.trialEndsOn !== null
						? `Free trial ends ${when}. Cancel before then or it starts billing.`
						: `Renews ${when}. Keep it or cancel it — decide now, not later.`
			});

			// Only on success: a failed notify leaves the row untouched so the next
			// sweep tries again.
			if (ok) {
				recordAlert(userId, sub.id, stage, now);
				delivered++;
			}
		}
	}
	return delivered;
}

let started = false;

/**
 * Start the scheduler. Safe to call more than once — dev server restarts
 * would otherwise stack duplicate cron registrations.
 *
 * Nudges (21:00 log, Sunday review) are not here. Spec §8.7 prefers a local
 * calendar reminder the user sets during setup: more reliable across
 * platforms, zero infrastructure, and it survives the server being off. Web
 * push is a Phase 5 nicety.
 */
export function startScheduler(): void {
	if (started || process.env.SPLIT_DISABLE_JOBS === '1') return;
	started = true;

	// The cron tick itself is process-wide — node-cron fires on one timezone,
	// then each job below iterates every live user and computes ITS OWN "today"
	// from that user's own settings. User 1's timezone merely decides when the
	// tick fires; it does not scope which users' work runs on it.
	const settings = loadSettings(1);
	const timezone = settings?.timezone ?? 'UTC';
	const keys = scheduledJobKeys();

	// Catch up anything missed while the process was down, before scheduling.
	for (const key of keys) {
		try {
			const detail = runJob(key);
			if (detail) console.log(`[jobs] catch-up ${key}: ${detail}`);
		} catch (err) {
			console.error(`[jobs] catch-up ${key} failed:`, err);
		}
	}

	void runSubscriptionAlerts().catch((err) =>
		console.error('[jobs] subscription alerts failed at startup:', err)
	);

	schedule('0 2 * * *', 'rollover', timezone);
	schedule('15 2 * * *', 'irregulars', timezone);
	if (keys.includes('backup')) schedule('0 3 * * *', 'backup', timezone);

	/*
	 * Reaping demo tenants is global, not per-user, so it is scheduled directly
	 * rather than added to JOB_KEYS — that loop runs its body once per live
	 * user, and a sweep that deletes every expired demo would do it N times.
	 *
	 * It also exercises the ON DELETE CASCADE path nightly, which is the same
	 * mechanism backing the account-deletion promise in §3.5. Better to find
	 * that broken here than on someone's first deletion request.
	 */
	cron.schedule('30 3 * * *', () => sweepDemoTenants(), { timezone });

	/*
	 * The sweep that makes the above survive a sleeping machine.
	 *
	 * Catch-up at process start is not enough: a laptop that suspends through
	 * 02:00 never fires that tick and never restarts, so node-cron logs a
	 * "missed execution" and the job — including the nightly backup — simply
	 * does not happen. Observed in production on the second night.
	 *
	 * Every job is idempotent and keyed by the local date, so re-asking costs
	 * one indexed lookup and does nothing until the date actually turns over.
	 */
	sweepDemoTenants();

	setInterval(() => {
		for (const key of keys) {
			try {
				const detail = runJob(key);
				if (detail) console.log(`[jobs] caught up ${key}: ${detail}`);
			} catch (err) {
				console.error(`[jobs] catch-up sweep for ${key} failed:`, err);
			}
		}

		// Row-stated, so this is the retry that makes a once-a-year alert land.
		void runSubscriptionAlerts().catch((err) =>
			console.error('[jobs] subscription alerts failed:', err)
		);
	}, CATCH_UP_INTERVAL_MS).unref();
}

function schedule(expression: string, jobKey: JobKey, timezone: string): void {
	cron.schedule(
		expression,
		() => {
			try {
				const detail = runJob(jobKey);
				if (detail) console.log(`[jobs] ${jobKey}: ${detail}`);
			} catch (err) {
				console.error(`[jobs] ${jobKey} failed:`, err);
			}
		},
		{ timezone }
	);
}


/** Delete expired demo tenants, logging only when something actually went. */
function sweepDemoTenants(): void {
	try {
		const reaped = reapDemoUsers();
		if (reaped > 0) console.log(`[jobs] reaped ${reaped} demo tenant(s)`);
	} catch (err) {
		console.error('[jobs] demo reaper failed:', err);
	}
}
