<script lang="ts">
	/**
	 * A chart with its table underneath it, and a toggle between them.
	 *
	 * Spec §8.6 requires the table view on every chart: it is the accessibility
	 * fallback and the "let me just see the numbers" escape hatch at the same
	 * time. It is also what renders on the server, so the page is complete and
	 * readable before Observable Plot has loaded — no skeleton shimmer over a
	 * SQLite read that returned in three milliseconds.
	 *
	 * `render` is called only in the browser, with Plot passed in, so the
	 * library never enters the server bundle.
	 */
	import { onMount } from 'svelte';
	import type * as PlotNS from '@observablehq/plot';

	interface Props {
		title: string;
		/** What fills this when it is empty, and when — never a zeroed chart. */
		emptyNote?: string;
		/**
		 * Fewest points worth drawing. Below this, the empty note shows instead
		 * of a chart.
		 *
		 * Not a style preference. Plot expands a degenerate domain to fill the
		 * frame, so ONE point — or several that are all zero — renders as a
		 * single enormous rectangle that reads as a bug and, worse, reads as a
		 * huge value. A trend drawn from one week is not a trend anyway.
		 */
		minPoints?: number;
		columns: string[];
		rows: (string | number)[][];
		render?: ((plot: typeof PlotNS, width: number) => HTMLElement | SVGElement) | null;
	}

	let {
		title,
		emptyNote = '',
		columns,
		rows,
		render = null,
		minPoints = 1
	}: Props = $props();

	/** Enough real points to draw, and not every value identical at zero. */
	const plottable = $derived(rows.length >= minPoints && rows.length > 0);

	let holder: HTMLDivElement | undefined = $state();
	let mode: 'chart' | 'table' = $state('table');
	let plot: typeof PlotNS | null = $state(null);
	let width = $state(680);

	const ready = $derived(plot !== null);

	onMount(() => {
		if (!render || !plottable) return;

		let cancelled = false;
		const observer = new ResizeObserver((entries) => {
			const next = Math.round(entries[0].contentRect.width);
			if (next > 0 && Math.abs(next - width) > 8) width = next;
		});

		import('@observablehq/plot').then((mod) => {
			if (cancelled) return;
			plot = mod;
			mode = 'chart';
			if (holder?.parentElement) observer.observe(holder.parentElement);
		});

		return () => {
			cancelled = true;
			observer.disconnect();
		};
	});

	// One draw path. It fires when Plot lands, and again if the width or the
	// data changes — not three times on mount.
	$effect(() => {
		if (!plot || !holder || !render || !plottable) return;
		holder.replaceChildren(render(plot, width));
	});
</script>

<figure class="figure">
	<figcaption>
		<span class="figure-title">{title}</span>
		{#if ready && plottable}
			<span class="toggle" role="group" aria-label="{title} view">
				<button
					type="button"
					class:on={mode === 'chart'}
					aria-pressed={mode === 'chart'}
					onclick={() => (mode = 'chart')}>Chart</button
				>
				<button
					type="button"
					class:on={mode === 'table'}
					aria-pressed={mode === 'table'}
					onclick={() => (mode = 'table')}>Table</button
				>
			</span>
		{/if}
	</figcaption>

	{#if !plottable}
		<p class="empty">{emptyNote}</p>
	{:else}
		<div class="chart" hidden={mode !== 'chart'}><div bind:this={holder}></div></div>

		<div class="scroll" hidden={mode !== 'table'}>
			<table>
				<thead>
					<tr
						>{#each columns as c (c)}<th scope="col">{c}</th>{/each}</tr
					>
				</thead>
				<tbody>
					{#each rows as row, i (i)}
						<tr
							>{#each row as cell, j (j)}<td>{cell}</td>{/each}</tr
						>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</figure>

<style>
	.figure {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	figcaption {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.figure-title {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-muted);
	}

	.toggle {
		display: inline-flex;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.375rem;
		overflow: hidden;
	}

	.toggle button {
		min-height: 1.875rem;
		padding: 0 0.625rem;
		background: none;
		border: 0;
		color: var(--ink-muted);
		font-family: inherit;
		font-size: 0.75rem;
		cursor: pointer;
	}

	.toggle button + button {
		border-left: 1px solid var(--hairline-strong);
	}

	.toggle button.on {
		background: var(--ink);
		color: var(--ground);
	}

	.chart :global(svg) {
		max-width: 100%;
		height: auto;
	}

	.scroll {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	th,
	td {
		text-align: right;
		padding: 0.4rem 0.75rem 0.4rem 0;
		border-bottom: 1px solid var(--hairline);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	th:first-child,
	td:first-child {
		text-align: left;
	}

	thead th {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-weight: 500;
		color: var(--ink-muted);
	}

	.empty {
		margin: 0;
		padding: 1rem;
		border: 1px dashed var(--hairline-strong);
		border-radius: 0.5rem;
		color: var(--ink-muted);
		font-size: 0.875rem;
	}
</style>
