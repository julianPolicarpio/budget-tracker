import { error, json } from '@sveltejs/kit';
import { loadSettings } from '$lib/server/today';
import { deltaVsPrior, priorReview, reviewByLabel } from '$lib/server/review';
import { topThree } from '$lib/server/metrics';
import type { RequestHandler } from './$types';

/** GET /api/review/2026-W33/summary — the shareable one-liner and its metrics. */
export const GET: RequestHandler = ({ params }) => {
	const settings = loadSettings();
	if (!settings) error(409, 'Split is not initialised yet.');

	const review = reviewByLabel(params.label);
	if (!review) error(404, `No review for ${params.label}`);

	return json({
		line: review.summaryLine,
		completedAt: review.completedAt,
		sharedAt: review.sharedAt,
		window: { startsOn: review.startsOn, endsOn: review.endsOn },
		metrics: {
			totalSpentMinor: review.totalSpentMinor,
			unplannedRatioBp: review.unplannedRatioBp,
			bufferWeeksX100: review.bufferWeeksX100,
			logAdherenceBp: review.logAdherenceBp,
			streak: review.streakAtClose,
			// Null, not zero: these need subsystems that arrive in Phase 3.
			coverageRatioBp: review.coverageRatioBp,
			saveRateBp: review.saveRateBp,
			deltaVsPrior: deltaVsPrior(review, priorReview(review))
		},
		balances: {
			spendMinor: review.spendBalanceMinor,
			irregularsMinor: review.irregularsMinor,
			bufferMinor: review.bufferMinor,
			debtTotalMinor: review.debtTotalMinor
		},
		topThree: topThree({ from: review.startsOn, to: review.endsOn })
	});
};
