import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { forUser, schema } from '$lib/server/db';
import { loadSettings } from '$lib/server/today';
import { localToday, addDays } from '$lib/server/clock';
import { weekOf } from '$lib/server/week';
import { weekActuals } from '$lib/server/metrics';
import { CATEGORIES } from '$lib/categories';
import type { PageServerLoad } from './$types';

const WEEKS = 12;

export const load: PageServerLoad = ({ locals }) => {
	const settings = loadSettings(locals.userId);
	if (!settings) return { ready: false as const };

	const { db, owns } = forUser(locals.userId);
	const today = localToday(settings.timezone);

	// The five metrics come off the completed review rows — the artefact is the
	// record, so the trends read from it rather than recomputing history.
	const reviews = db
		.select()
		.from(schema.review)
		.where(and(owns(schema.review), eq(schema.review.kind, 'weekly'), isNotNull(schema.review.completedAt)))
		.orderBy(asc(schema.review.endsOn))
		.all()
		.slice(-WEEKS);

	// The heatmap goes through weekActuals(), so it inherits the trip
	// quarantine like every other metric.
	const thisWeek = weekOf(today, settings.weekStartsOn);
	const heatmap = Array.from({ length: WEEKS }, (_, i) => {
		const start = addDays(thisWeek.startsOn, -7 * (WEEKS - 1 - i));
		const week = weekOf(start, settings.weekStartsOn);
		const actuals = weekActuals(locals.userId, { from: week.startsOn, to: week.endsOn });
		return {
			label: week.label,
			endsOn: week.endsOn,
			byCategory: Object.fromEntries(actuals.byCategory.map((c) => [c.key, c.minor])),
			totalMinor: actuals.totalMinor
		};
	});

	return {
		ready: true as const,
		categories: CATEGORIES.map((c) => ({ ...c })),
		series: reviews.map((r) => ({
			label: r.periodLabel,
			endsOn: r.endsOn,
			adherenceBp: r.logAdherenceBp,
			unplannedRatioBp: r.unplannedRatioBp,
			bufferWeeksX100: r.bufferWeeksX100,
			coverageRatioBp: r.coverageRatioBp,
			saveRateBp: r.saveRateBp,
			totalSpentMinor: r.totalSpentMinor
		})),
		heatmap,
		reviewCount: reviews.length,
		sharedCount: reviews.filter((r) => r.sharedAt !== null).length,
		currency: {
			code: settings.currencyCode,
			symbol: settings.currencySymbol,
			minorUnits: settings.minorUnits
		}
	};
};
