import { error } from '@sveltejs/kit';
import { getSubscription } from '$lib/server/subscriptions';
import { loadSettings } from '$lib/server/today';
import { formatMoney } from '$lib/money';
import { buildSubscriptionIcs } from '$lib/server/ics';
import type { RequestHandler } from './$types';

/**
 * GET /subscriptions/:id/reminder.ics — the calendar half of Spec §7.2.
 *
 * Downloaded once and added to the user's own calendar. From then on it
 * fires from their phone: offline, on a dead server, in airplane mode —
 * exactly the failure `notify()`'s osascript call cannot survive, and the
 * one that let a ₱1,100/month trial almost convert unnoticed.
 *
 * `getSubscription()` is already scoped through `forUser()` (Spec §3.2) — a
 * subscription id belonging to another tenant simply does not exist from
 * this caller's point of view, which is what makes the 404 below the
 * tenancy boundary as well as the "not found" case. There is a leak test
 * guarding this class in `tenancy.test.ts`'s "data leaving the app" suite.
 */
export const GET: RequestHandler = ({ params, locals }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) error(404, 'Unknown subscription.');

	const sub = getSubscription(locals.userId, id);
	if (!sub) error(404, 'Unknown subscription.');
	if (sub.cancelByOn === null) {
		// Non-negotiables and anything else with nothing to decide carry no
		// deadline at all (see subscriptions.ts) — there is nothing to remind
		// the user about.
		error(409, 'This subscription has no deadline to remind you about.');
	}

	const settings = loadSettings(locals.userId);
	if (!settings) error(409, 'Split is not initialised yet.');

	const amountLabel = formatMoney(sub.amountMinor, {
		minorUnits: settings.minorUnits,
		symbol: settings.currencySymbol
	});

	const ics = buildSubscriptionIcs({
		// Deterministic and stable across regenerations of the same row, so
		// re-downloading and re-adding it updates one calendar event rather
		// than piling up duplicates.
		uid: `split-subscription-${sub.id}@split.local`,
		label: sub.label,
		amountLabel,
		cancelByOn: sub.cancelByOn,
		isTrial: sub.trialEndsOn !== null
	});

	const filename =
		sub.label
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'subscription';

	return new Response(ics, {
		headers: {
			'Content-Type': 'text/calendar; charset=utf-8',
			'Content-Disposition': `attachment; filename="${filename}-reminder.ics"`
		}
	});
};
