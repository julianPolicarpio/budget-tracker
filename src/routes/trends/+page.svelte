<script lang="ts">
	import ReviewNav from '$lib/components/ReviewNav.svelte';
	import { formatMoney } from '$lib/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const minorUnits = $derived(data.ready ? data.currency.minorUnits : 2);
	const symbol = $derived(data.ready ? data.currency.symbol : '');

	function money(m: number | null | undefined): string {
		if (m === null || m === undefined) return '—';
		return formatMoney(m, { minorUnits, symbol }).replace(/\.00$/, '');
	}

	/**
	 * The five metrics from Method Part VIII. Each carries its target
	 * trajectory, because a number with no direction is not a metric.
	 */
	const METRICS = [
		{
			key: 'adherenceBp',
			label: 'Log adherence',
			target: '>85% by week 4',
			format: (v: number) => `${Math.round(v / 100)}%`,
			hint: 'Below 70% means the ritual is misplaced — move the cue, do not try harder.'
		},
		{
			key: 'unplannedRatioBp',
			label: 'Impulse spending',
			target: 'falling, <25% by month 3',
			format: (v: number) => `${Math.round(v / 100)}%`,
			hint: 'The direct measure of exceptional-expense blindness losing its grip on you.'
		},
		{
			key: 'bufferWeeksX100',
			label: 'Buffer weeks',
			target: 'rising to 6.0',
			format: (v: number) => (v / 100).toFixed(1),
			hint: 'Six weeks is the empirically derived threshold for the shock that actually happens.'
		},
		{
			key: 'coverageRatioBp',
			label: 'Funded',
			target: '≥1.0 and staying there',
			format: (v: number) => `${(v / 10_000).toFixed(2)}×`,
			hint: 'Below 1.0 is the leading indicator that Buffer is about to be raided.'
		},
		{
			key: 'saveRateBp',
			label: 'Save rate',
			target: 'rising',
			format: (v: number) => `${(v / 100).toFixed(1)}%`,
			hint: 'Needs income rows — a subsystem the roadmap never scheduled.'
		}
	] as const;

	type MetricKey = (typeof METRICS)[number]['key'];

	function values(key: MetricKey): (number | null)[] {
		return data.ready ? data.series.map((s) => s[key]) : [];
	}

	function latest(key: MetricKey): number | null {
		const v = values(key).filter((x): x is number => x !== null);
		return v.length ? v[v.length - 1] : null;
	}

	/** A sparkline is ten lines of SVG; a chart library makes it worse. */
	function sparkPath(key: MetricKey, w = 96, h = 24): string {
		const v = values(key);
		const points = v
			.map((x, i) => ({ i, x }))
			.filter((p): p is { i: number; x: number } => p.x !== null);
		if (points.length < 2) return '';

		const xs = points.map((p) => p.x);
		const min = Math.min(...xs);
		const max = Math.max(...xs);
		const span = max - min || 1;
		const stepX = w / Math.max(1, v.length - 1);

		return points
			.map((p, n) => {
				const x = (p.i * stepX).toFixed(1);
				const y = (h - ((p.x - min) / span) * (h - 2) - 1).toFixed(1);
				return `${n === 0 ? 'M' : 'L'}${x},${y}`;
			})
			.join(' ');
	}

	const maxCell = $derived(
		data.ready
			? Math.max(1, ...data.heatmap.flatMap((w) => Object.values(w.byCategory) as number[]))
			: 1
	);
</script>

<svelte:head><title>Trends · Split</title></svelte:head>

{#if !data.ready}
	<main class="sheet"><p class="eyebrow">Not set up</p></main>
{:else}
	<main class="sheet">
		<header class="masthead">
			<div>
				<p class="eyebrow">Trends</p>
				<h1>Whether it is actually working</h1>
			</div>
		</header>

		<ReviewNav />

		<p class="lede">
			Do not measure success by "did I stick to the budget". These five are real behavioural
			quantities, and they come off your completed weekly reviews rather than being recomputed — the
			artefact is the record.
		</p>

		{#if data.reviewCount === 0}
			<p class="empty">
				Nothing yet. The first points appear after your first completed weekly review, and the lines
				become readable after about four.
			</p>
		{:else}
			<!-- KPI row: value + sparkline, hand-rolled. -->
			<section class="kpis">
				{#each METRICS as m (m.key)}
					{@const v = latest(m.key)}
					{@const path = sparkPath(m.key)}
					<div class="kpi">
						<p class="kpi-label">{m.label}</p>
						<p class="kpi-value">
							{#if v === null}
								<span class="pending">—</span>
							{:else}
								{m.format(v)}
							{/if}
						</p>
						{#if path}
							<svg class="spark" viewBox="0 0 96 24" aria-hidden="true">
								<path d={path} fill="none" stroke="var(--series-1)" stroke-width="1.5" />
							</svg>
						{:else}
							<span class="spark-empty" aria-hidden="true"></span>
						{/if}
						<p class="kpi-target">{m.target}</p>
					</div>
				{/each}
			</section>

			<!--
				Small multiples, not five series on one chart: they do not share a
				unit, and Spec §8.6 forbids a dual axis outright.
			-->
			<section class="block">
				<p class="eyebrow">Twelve weeks, one panel each</p>
				<div class="multiples">
					{#each METRICS as m (m.key)}
						{@const path = sparkPath(m.key, 200, 56)}
						<figure>
							<figcaption>{m.label}</figcaption>
							{#if path}
								<svg viewBox="0 0 200 56" role="img" aria-label="{m.label} over the last weeks">
									<path d={path} fill="none" stroke="var(--series-1)" stroke-width="1.75" />
								</svg>
							{:else}
								<p class="pending">{m.hint}</p>
							{/if}
						</figure>
					{/each}
				</div>
			</section>

			<!-- Category heatmap: sequential blue, one hue, magnitude not identity. -->
			<section class="block">
				<p class="eyebrow">Category drift — 8 categories × {data.heatmap.length} weeks</p>
				<div class="scroll">
					<table class="heat">
						<thead>
							<tr>
								<th scope="col">Category</th>
								{#each data.heatmap as w (w.label)}
									<th scope="col" class="wk">{w.label.slice(-3)}</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each data.categories as c (c.key)}
								<tr>
									<th scope="row">{c.label}</th>
									{#each data.heatmap as w (w.label)}
										{@const v = w.byCategory[c.key] ?? 0}
										<td
											class="cell"
											style="--a: {v / maxCell}"
											title="{c.label}, {w.label}: {money(v)}"
										>
											<span class="sr-only">{money(v)}</span>
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="muted">
					Trip spending is excluded here as it is everywhere else — two weeks at four times normal
					spend would otherwise smear this into uselessness for a quarter.
				</p>
			</section>

			<section class="block">
				<p class="eyebrow">The ritual itself</p>
				<div class="scroll">
					<table>
						<thead>
							<tr>
								<th scope="col">Week</th>
								<th scope="col">Spent</th>
								<th scope="col">Unplanned</th>
								<th scope="col">Adherence</th>
								<th scope="col">Buffer wks</th>
								<th scope="col">Coverage</th>
							</tr>
						</thead>
						<tbody>
							{#each [...data.series].reverse() as s (s.label)}
								<tr>
									<th scope="row">{s.label}</th>
									<td>{money(s.totalSpentMinor)}</td>
									<td
										>{s.unplannedRatioBp === null
											? '—'
											: `${Math.round(s.unplannedRatioBp / 100)}%`}</td
									>
									<td>{s.adherenceBp === null ? '—' : `${Math.round(s.adherenceBp / 100)}%`}</td>
									<td>{s.bufferWeeksX100 === null ? '—' : (s.bufferWeeksX100 / 100).toFixed(1)}</td>
									<td
										>{s.coverageRatioBp === null
											? '—'
											: `${(s.coverageRatioBp / 10_000).toFixed(2)}×`}</td
									>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="muted">
					{data.sharedCount} of {data.reviewCount} reviews were sent to someone. Reporting progress was
					a moderator in the monitoring meta-analysis, and it is the free half.
				</p>
			</section>
		{/if}
	</main>
{/if}

<style>
	.muted {
		color: var(--ink-muted);
		font-size: 0.8125rem;
		margin: 0;
	}

	.block {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.kpis {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
		gap: 0.75rem;
	}

	.kpi {
		padding: 0.875rem;
		border: 1px solid var(--hairline);
		border-radius: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.kpi-label {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-muted);
	}

	.kpi-value {
		margin: 0;
		font-size: 1.5rem;
		font-variant-numeric: proportional-nums;
	}

	.spark,
	.spark-empty {
		display: block;
		height: 24px;
		width: 100%;
	}

	.kpi-target {
		margin: 0;
		font-size: 0.6875rem;
		color: var(--ink-muted);
	}

	.pending {
		color: var(--ink-muted);
		font-size: 0.8125rem;
	}

	.multiples {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: 1rem;
	}

	.multiples figure {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.multiples figcaption {
		font-size: 0.8125rem;
		color: var(--ink-secondary);
	}

	.multiples svg {
		width: 100%;
		height: 56px;
		border-bottom: 1px solid var(--hairline);
	}

	.scroll {
		overflow-x: auto;
	}

	th,
	td {
		text-align: right;
		padding: 0.4rem 0.6rem 0.4rem 0;
		border-bottom: 1px solid var(--hairline);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		font-size: 0.875rem;
	}

	th:first-child,
	td:first-child {
		text-align: left;
	}

	thead th {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		font-weight: 500;
		color: var(--ink-muted);
	}

	tbody th {
		font-weight: 400;
		color: var(--ink-secondary);
	}

	/* One hue, opacity carrying magnitude — never eight colours. */
	.heat .cell {
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		border: 1px solid var(--ground);
		background: color-mix(in srgb, var(--series-1) calc(var(--a) * 100%), var(--surface));
	}

	.heat .wk {
		text-align: center;
	}
</style>
