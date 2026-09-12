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
import { db, schema, sqlite } from './db';
import { runBackup } from './backup';
import { runRollover } from './rollover';
import { materialise } from './irregulars';
import { proposePhaseChange } from './phases';
import { pendingAlerts, recordAlert } from './subscriptions';
import { notify } from './notify';
import { localToday } from './clock';
import { loadSettings } from './today';
import { dirname, join } from 'node:path';

export type JobKey = 'rollover' | 'irregulars' | 'backup';

const JOB_KEYS = ['rollover', 'irregulars', 'backup'] as const satisfies readonly JobKey[];

/** How often to re-ask whether a date-keyed job still owes a run. */
const CATCH_UP_INTERVAL_MS = 15 * 60_000;

const BACKUP_DIR = join(dirname(process.env.DATABASE_URL ?? 'data/split.db'), 'backups');

function alreadyRan(jobKey: JobKey, forDate: string): boolean {
	return (
		db
			.select()
			.from(schema.jobRun)
			.where(and(eq(schema.jobRun.jobKey, jobKey), eq(schema.jobRun.ranFor, forDate)))
			.get() !== undefined
	);
}

function recordRun(jobKey: JobKey, forDate: string, detail: string, now: Date): void {
	db.insert(schema.jobRun)
		.values({ jobKey, ranFor: forDate, ranAt: now.toISOString(), detail })
		.onConflictDoNothing()
		.run();
}

/** Run one job for one date, unless it already ran. Returns what it did. */
export function runJob(jobKey: JobKey, now: Date = new Date()): string | null {
	const settings = loadSettings();
	if (!settings) return null;

	const forDate = localToday(settings.timezone, now);
	if (alreadyRan(jobKey, forDate)) return null;

	let detail: string;
	if (jobKey === 'rollover') {
		const r = runRollover(forDate, settings, now);
		detail = `closed ${r.closed.length}, opened ${r.opened.length}`;
	} else if (jobKey === 'irregulars') {
		// Project instances 24 months forward, then check whether the current
		// phase's exit has cleared. The phase check only ever *proposes*.
		const written = materialise(forDate, now);
		const proposal = proposePhaseChange(settings, forDate);
		detail = `materialised ${written}` + (proposal ? `, proposed phase ${proposal.toPhase}` : '');
	} else {
		const b = runBackup(sqlite, BACKUP_DIR, forDate);
		detail = `${b.bytes} bytes, pruned ${b.pruned.length}`;
	}

	recordRun(jobKey, forDate, detail, now);
	return detail;
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
	const settings = loadSettings();
	if (!settings) return 0;

	const today = localToday(settings.timezone, now);
	let delivered = 0;

	for (const { sub, stage, daysLeft } of pendingAlerts(today)) {
		const when =
			daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
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
			recordAlert(sub.id, stage, now);
			delivered++;
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

	const settings = loadSettings();
	const timezone = settings?.timezone ?? 'UTC';

	// Catch up anything missed while the process was down, before scheduling.
	for (const key of JOB_KEYS) {
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
	schedule('0 3 * * *', 'backup', timezone);

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
	setInterval(() => {
		for (const key of JOB_KEYS) {
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
