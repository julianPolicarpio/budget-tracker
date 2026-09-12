/**
 * Local desktop notifications.
 *
 * Not web push. Spec §13 puts web push in the last phase, gated on six months
 * of real use, and Spec §8.7 prefers a local reminder anyway — "more reliable
 * across platforms and it costs zero infrastructure". This is the smallest
 * thing that honours both: one `osascript` call, no dependency, no service
 * worker, no VAPID keys, no subscription endpoint to keep alive for a year.
 *
 * The honest limitation, stated once here so it is not rediscovered in 2027:
 * this only reaches a Mac that is awake with a logged-in GUI session. What
 * makes it survivable is the caller, not this function — alert state lives on
 * the subscription row, so a deadline is re-offered every sweep until it has
 * actually been delivered, rather than being skipped because a date passed
 * while the lid was shut.
 */

import { execFile } from 'node:child_process';

/** AppleScript string literals escape backslash and double-quote, nothing else. */
function osaString(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface Notification {
	title: string;
	subtitle?: string;
	body: string;
}

/**
 * Fire and forget. Resolves true if the notification was handed to the OS.
 *
 * Never throws: a failed notification must not take down the scheduler sweep
 * that called it, and must not mark the alert delivered either — the caller
 * only records the alert when this resolves true, so a failure is retried on
 * the next sweep.
 */
export function notify(n: Notification): Promise<boolean> {
	if (process.platform !== 'darwin' || process.env.SPLIT_DISABLE_NOTIFY === '1') {
		return Promise.resolve(false);
	}

	const parts = [
		`display notification ${osaString(n.body)}`,
		`with title ${osaString(n.title)}`
	];
	if (n.subtitle) parts.push(`subtitle ${osaString(n.subtitle)}`);

	return new Promise((resolve) => {
		execFile('/usr/bin/osascript', ['-e', parts.join(' ')], { timeout: 10_000 }, (err) => {
			if (err) console.error('[notify] failed:', err.message);
			resolve(!err);
		});
	});
}
