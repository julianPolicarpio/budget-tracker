import { sqlite } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Transactions and reviews, flat, for a spreadsheet.
 *
 * The JSON export is the backup; this is the "let me just look at it in
 * something else" escape hatch. Money is emitted in major units here because
 * the destination is a human reading a spreadsheet, not a restore.
 */
function csvEscape(v: unknown): string {
	if (v === null || v === undefined) return '';
	const s = String(v);
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const GET: RequestHandler = () => {
	const settings = sqlite.prepare('SELECT minor_units AS m FROM settings WHERE id = 1').get() as
		{ m: number } | undefined;
	const divisor = 10 ** (settings?.m ?? 2);
	const major = (minor: number | null) =>
		minor === null ? '' : (minor / divisor).toFixed(settings?.m ?? 2);

	const lines: string[] = [];

	lines.push('# transactions');
	lines.push('spent_on,amount,category,planned,trip,amount_local,fx_rate,entered_at');
	const txns = sqlite
		.prepare(
			`SELECT t.spent_on, t.amount_minor, t.category, t.planned, t.entered_at,
			        t.amount_local_minor, t.fx_rate_used, tr.label AS trip_label
			 FROM txn t LEFT JOIN trip tr ON tr.id = t.trip_id
			 ORDER BY t.spent_on, t.id`
		)
		.all() as Record<string, string | number | null>[];

	for (const t of txns) {
		lines.push(
			[
				t.spent_on,
				major(t.amount_minor as number),
				t.category,
				t.planned ? 'planned' : 'unplanned',
				t.trip_label ?? '',
				t.amount_local_minor ?? '',
				t.fx_rate_used ?? '',
				t.entered_at
			]
				.map(csvEscape)
				.join(',')
		);
	}

	lines.push('');
	lines.push('# reviews');
	lines.push(
		'period_label,starts_on,ends_on,completed_at,total_spent,unplanned_ratio_pct,' +
			'buffer_weeks,coverage_ratio,log_adherence_pct,streak,shared_at,summary_line'
	);
	const reviews = sqlite
		.prepare(`SELECT * FROM review WHERE completed_at IS NOT NULL ORDER BY ends_on`)
		.all() as Record<string, string | number | null>[];

	for (const r of reviews) {
		lines.push(
			[
				r.period_label,
				r.starts_on,
				r.ends_on,
				r.completed_at,
				major(r.total_spent_minor as number),
				r.unplanned_ratio_bp === null ? '' : ((r.unplanned_ratio_bp as number) / 100).toFixed(1),
				r.buffer_weeks_x100 === null ? '' : ((r.buffer_weeks_x100 as number) / 100).toFixed(2),
				r.coverage_ratio_bp === null ? '' : ((r.coverage_ratio_bp as number) / 10_000).toFixed(2),
				r.log_adherence_bp === null ? '' : ((r.log_adherence_bp as number) / 100).toFixed(1),
				r.streak_at_close,
				r.shared_at,
				r.summary_line
			]
				.map(csvEscape)
				.join(',')
		);
	}

	return new Response(lines.join('\n'), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="split-${new Date().toISOString().slice(0, 10)}.csv"`
		}
	});
};
