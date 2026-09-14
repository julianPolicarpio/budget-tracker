<script lang="ts">
	import ReviewNav from '$lib/components/ReviewNav.svelte';
	import { enhance } from '$app/forms';
	import Figure from '$lib/components/Figure.svelte';
	import { CATEGORIES } from '$lib/categories';
	import { CANDIDATES } from '$lib/irregular-candidates';
	import { formatMoney } from '$lib/money';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const minorUnits = $derived(data.ready ? data.currency.minorUnits : 2);
	const symbol = $derived(data.ready ? data.currency.symbol : '');

	function money(m: number | null | undefined): string {
		if (m === null || m === undefined) return '—';
		return formatMoney(m, { minorUnits, symbol }).replace(/\.00$/, '');
	}
	const major = (m: number) => m / 10 ** minorUnits;

	function monthLabel(ym: string): string {
		return new Intl.DateTimeFormat('en-GB', {
			month: 'short',
			year: '2-digit',
			timeZone: 'UTC'
		}).format(new Date(ym + '-01T00:00:00Z'));
	}
	function dayLabel(iso: string): string {
		return new Intl.DateTimeFormat('en-GB', {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			timeZone: 'UTC'
		}).format(new Date(iso + 'T00:00:00Z'));
	}

	const CADENCE_LABELS: Record<string, string> = {
		one_off: 'One-off',
		monthly: 'Monthly',
		quarterly: 'Quarterly',
		semiannual: 'Twice a year',
		annual: 'Yearly',
		every_n_years: 'Every N years'
	};

	// The coverage figure, as a multiple. Null means nothing is due in 90 days —
	// which is not the same as being fully covered, so it never renders as ∞.
	const ratio = $derived(
		data.ready && data.coverage.ratioBp !== null ? data.coverage.ratioBp / 10_000 : null
	);
	const short = $derived(ratio !== null && ratio < 1);

	interface Draft {
		id: number | '';
		label: string;
		amount: string;
		cadence: string;
		cadenceN: number | '';
		nextDueOn: string;
		category: string;
		paddingPct: number;
	}

	const BLANK: Draft = {
		id: '',
		label: '',
		amount: '',
		cadence: 'annual',
		cadenceN: '',
		nextDueOn: '',
		category: '',
		paddingPct: 25
	};

	let showForm = $state(false);
	let draft = $state<Draft>({ ...BLANK });
	let picked = $state('');

	function startNew(patch: Partial<Draft> = {}) {
		draft = { ...BLANK, ...patch };
		showForm = true;
	}

	interface DefinitionRow {
		id: number;
		label: string;
		amountMinor: number;
		cadence: string;
		cadenceN: number | null;
		nextDueOn: string;
		category: string | null;
		paddingPct: number;
	}

	function startEdit(d: DefinitionRow) {
		draft = {
			id: d.id,
			label: d.label,
			amount: String(major(d.amountMinor)),
			cadence: d.cadence,
			cadenceN: d.cadenceN ?? '',
			nextDueOn: d.nextDueOn,
			category: d.category ?? '',
			paddingPct: d.paddingPct
		};
		showForm = true;
	}
</script>

<svelte:head><title>Big bills · Split</title></svelte:head>

{#if !data.ready}
	<main class="sheet">
		<p class="eyebrow">Not set up</p>
		<p>Run <code>npm run db:init</code> first.</p>
	</main>
{:else}
	<main class="sheet">
		<header class="masthead">
			<div>
				<p class="eyebrow">Big bills</p>
				<h1>Lumpy costs, paid for before they land</h1>
			</div>
		</header>

		<ReviewNav />

		{#if form?.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}

		<!--
			Reconciliation (Spec §4.3). This is the failure that kills the system
			quietly: instances stop being marked, the ledger drifts, and the app
			keeps reporting healthy coverage while the account is empty. Forced
			three-way choice, no dismiss, above everything else.
		-->
		{#if data.overdue.length > 0}
			<section class="card reconcile">
				<p class="eyebrow">Reconcile — {data.overdue.length} due and unmarked</p>
				<p class="lede">
					Each of these was due and never marked. Paid, skipped, or rescheduled — there is no fourth
					option, because the alternative is a ledger that quietly stops matching your bank.
				</p>
				{#each data.overdue as inst (inst.id)}
					<form method="POST" action="?/reconcile" use:enhance class="reconcile-row">
						<input type="hidden" name="instanceId" value={inst.id} />
						<div class="reconcile-head">
							<strong>{inst.label}</strong>
							<span class="muted"
								>due {dayLabel(inst.dueOn)} · est. {money(inst.expectedMinor)}</span
							>
						</div>
						<div class="reconcile-controls">
							<label class="field-input compact">
								<span class="field-sym">{symbol}</span>
								<input
									name="actual"
									type="text"
									inputmode="decimal"
									placeholder={String(major(inst.expectedMinor))}
									aria-label="What it actually cost"
								/>
							</label>
							<button class="primary" type="submit" name="choice" value="paid">Paid</button>
							<button class="ghost" type="submit" name="choice" value="skipped">Skipped</button>
							<label class="field-input compact">
								<input name="dueOn" type="date" aria-label="New due date" />
							</label>
							<button class="ghost" type="submit" name="choice" value="rescheduled">
								Reschedule
							</button>
						</div>
					</form>
				{/each}
			</section>
		{/if}

		<!-- 4.1 Coverage. Below 1.0 it takes over the screen. -->
		<section class="coverage" class:short>
			<p class="eyebrow">Coverage — next 90 days</p>
			{#if ratio === null}
				<p class="cover-figure">—</p>
				<p class="lede">
					Nothing scheduled in the next 90 days. Add what you know is coming; the list below is
					there so this is a recognition task, not a recall one.
				</p>
			{:else}
				<p class="cover-figure">{ratio.toFixed(2)}×</p>
				<p class="cover-status">
					<span aria-hidden="true">{short ? '!' : '✓'}</span>
					{#if short}
						Short by {money(data.coverage.shortfallMinor)}
					{:else}
						Funded — {money(data.coverage.balanceMinor)} against {money(data.coverage.due90Minor)}
					{/if}
				</p>
				{#if short}
					<p class="lede">
						Below 1.0 is the leading indicator that your Emergency fund is about to get raided.
						{#if data.coverage.firstAtRisk}
							<strong>{data.coverage.firstAtRisk.label}</strong> on
							{dayLabel(data.coverage.firstAtRisk.dueOn)} is the one that bounces first.
						{/if}
					</p>
				{/if}
			{/if}

			{#if data.accrualPerPeriod !== null}
				<p class="muted accrual">
					This period's accrual: <strong>{money(data.accrualPerPeriod)}</strong> over
					{data.periodDays} days. Recomputed each period, so a new cost due in two months raises the next
					two periods rather than quietly under-funding.
				</p>
			{/if}
		</section>

		<!-- 4.2 Next 12 months. Single series → no legend; the title names it. -->
		<Figure
			title="Expected outflow, next 12 months"
			emptyNote="Nothing scheduled yet. This fills in as you declare irregulars, and the two spikes a year you would otherwise forget become visible here first."
			columns={['Month', 'Expected']}
			rows={data.outflow.map((o) => [monthLabel(o.month), money(o.expectedMinor)])}
			render={(Plot, width) =>
				Plot.plot({
					width,
					height: 220,
					marginLeft: 56,
					// Band, explicitly: these are ordinal month buckets, not instants.
					// Left to infer, Plot reads 'YYYY-MM' as a date and warns.
					x: { type: 'band', label: null, tickFormat: monthLabel },
					y: { label: null, grid: true, tickFormat: (d: number) => money(d) },
					style: { background: 'transparent', color: 'var(--ink-muted)', fontSize: '11px' },
					marks: [
						Plot.barY(data.outflow, {
							x: 'month',
							y: 'expectedMinor',
							fill: 'var(--series-1-fill)',
							rx: 1
						}),
						Plot.ruleY([0], { stroke: 'var(--hairline-strong)' })
					]
				})}
		/>

		<!--
			4.3 Accrued vs required. Two series, same unit, one y-axis, direct
			labels — never a dual axis (Spec §8.6). Both series come out of the
			weekly review snapshots.
		-->
		<Figure
			title="Accrued against required"
			emptyNote="Appears after two completed weekly reviews — the balance you assert at R1 is what draws this line."
			minPoints={3}
			columns={['Week ending', 'Accrued', 'Required (90 days)']}
			rows={data.history.map((h) => [
				dayLabel(h.endsOn),
				money(h.accruedMinor),
				money(h.requiredMinor)
			])}
			render={data.history.length >= 2
				? (Plot, width) =>
						Plot.plot({
							width,
							height: 220,
							marginLeft: 56,
							marginRight: 76,
							x: { label: null, type: 'utc' },
							y: { label: null, grid: true, tickFormat: (d: number) => money(d) },
							style: { background: 'transparent', color: 'var(--ink-muted)', fontSize: '11px' },
							marks: [
								Plot.line(data.history, {
									x: (d: { endsOn: string }) => new Date(d.endsOn),
									y: 'accruedMinor',
									stroke: 'var(--series-1)',
									strokeWidth: 2
								}),
								Plot.line(
									data.history.filter((h) => h.requiredMinor !== null),
									{
										x: (d: { endsOn: string }) => new Date(d.endsOn),
										y: 'requiredMinor',
										stroke: 'var(--series-2)',
										strokeWidth: 2
									}
								),
								Plot.text([data.history.at(-1)], {
									x: (d: { endsOn: string }) => new Date(d.endsOn),
									y: 'accruedMinor',
									text: () => 'accrued',
									dx: 6,
									textAnchor: 'start',
									fill: 'var(--series-1-fill)'
								}),
								Plot.text([data.history.at(-1)], {
									x: (d: { endsOn: string }) => new Date(d.endsOn),
									y: 'requiredMinor',
									text: () => 'required',
									dx: 6,
									textAnchor: 'start',
									fill: 'var(--series-2-fill)'
								})
							]
						})
				: null}
		/>

		<!-- 4.4 Upcoming -->
		<section class="block">
			<p class="eyebrow">Upcoming</p>
			{#if data.upcoming.length === 0}
				<p class="empty">Nothing scheduled in the next 12 months.</p>
			{:else}
				<div class="scroll">
					<table>
						<thead>
							<tr>
								<th scope="col">Label</th>
								<th scope="col">Due</th>
								<th scope="col">Expected</th>
								<th scope="col">Funded?</th>
								<th scope="col"><span class="sr-only">Settle</span></th>
							</tr>
						</thead>
						<tbody>
							{#each data.upcoming.slice(0, 24) as inst (inst.id)}
								{@const funded = data.coverage.balanceMinor >= inst.expectedMinor}
								<tr>
									<th scope="row">{inst.label}</th>
									<td>{dayLabel(inst.dueOn)}</td>
									<td>{money(inst.expectedMinor)}</td>
									<td class="status" class:good={funded}>
										<span aria-hidden="true">{funded ? '✓' : '!'}</span>
										{funded ? 'funded' : 'short'}
									</td>
									<td>
										<form method="POST" action="?/reconcile" use:enhance class="inline">
											<input type="hidden" name="instanceId" value={inst.id} />
											<label class="field-input compact">
												<span class="field-sym">{symbol}</span>
												<input
													name="actual"
													type="text"
													inputmode="decimal"
													placeholder={String(major(inst.expectedMinor))}
													aria-label="Actual cost for {inst.label}"
												/>
											</label>
											<button class="ghost small" type="submit" name="choice" value="paid">
												Settle
											</button>
										</form>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<!--
			4.6 Estimate accuracy. Expected → actual per settled instance: your
			personal calibration on F10, and the only honest way to know whether
			25% padding is enough for you.
		-->
		<Figure
			title="Estimate accuracy — expected against actual"
			emptyNote="Appears once you have settled an irregular. The gap between what you expected and what it cost is the most useful number this app will ever show you."
			minPoints={3}
			columns={['Label', 'Settled', 'Expected', 'Actual', 'Error']}
			rows={data.accuracy.map((a) => [
				a.label,
				dayLabel(a.settledOn),
				money(a.expectedMinor),
				money(a.actualMinor),
				`${a.actualMinor > a.expectedMinor ? '+' : ''}${Math.round(((a.actualMinor - a.expectedMinor) / a.expectedMinor) * 100)}%`
			])}
			render={(Plot, width) =>
				Plot.plot({
					width,
					height: Math.max(140, data.accuracy.length * 28 + 60),
					marginLeft: 140,
					x: { label: null, grid: true, tickFormat: (d: number) => money(d) },
					y: { label: null },
					style: { background: 'transparent', color: 'var(--ink-muted)', fontSize: '11px' },
					marks: [
						Plot.link(data.accuracy, {
							y: 'label',
							x1: 'expectedMinor',
							x2: 'actualMinor',
							stroke: 'var(--hairline-strong)',
							strokeWidth: 2
						}),
						Plot.dot(data.accuracy, {
							y: 'label',
							x: 'expectedMinor',
							fill: 'var(--series-1-fill)',
							r: 5
						}),
						Plot.dot(data.accuracy, {
							y: 'label',
							x: 'actualMinor',
							fill: 'var(--series-2-fill)',
							r: 5
						})
					]
				})}
		/>

		<!-- 4.5 Definitions -->
		<section class="block">
			<div class="block-head">
				<p class="eyebrow">Definitions</p>
				<button class="ghost small" type="button" onclick={() => startNew()}>Add one</button>
			</div>

			{#if data.definitions.length === 0}
				<p class="empty">
					Nothing declared. Walk the calendar event by event rather than estimating a monthly
					average — averaging is exactly how exceptional costs vanish from a budget.
				</p>
			{/if}

			{#if data.definitions.length > 0}
				<div class="scroll">
					<table>
						<thead>
							<tr>
								<th scope="col">Label</th>
								<th scope="col">Cadence</th>
								<th scope="col">Estimate</th>
								<th scope="col">Padding</th>
								<th scope="col">Accrues</th>
								<th scope="col"><span class="sr-only">Actions</span></th>
							</tr>
						</thead>
						<tbody>
							{#each data.definitions as d (d.id)}
								<tr>
									<th scope="row">{d.label}</th>
									<td>
										{CADENCE_LABELS[d.cadence]}{d.cadence === 'every_n_years'
											? ` (${d.cadenceN})`
											: ''}
									</td>
									<td>{money(d.amountMinor)}</td>
									<td>+{d.paddingPct}%</td>
									<td>{money(Math.round((d.amountMinor * (100 + d.paddingPct)) / 100))}</td>
									<td>
										<span class="inline">
											<button class="ghost small" type="button" onclick={() => startEdit(d)}>
												Edit
											</button>
											<form method="POST" action="?/archive" use:enhance class="inline">
												<input type="hidden" name="id" value={d.id} />
												<button class="ghost small" type="submit">Archive</button>
											</form>
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			{#if showForm}
				<form method="POST" action="?/upsert" use:enhance class="card">
					<input type="hidden" name="id" value={draft.id} />
					<div class="grid">
						<label class="field">
							<span class="field-label">Label</span>
							<span class="field-input">
								<input name="label" type="text" bind:value={draft.label} required />
							</span>
						</label>
						<label class="field">
							<span class="field-label">Estimate (before padding)</span>
							<span class="field-input">
								<span class="field-sym">{symbol}</span>
								<input
									name="amount"
									type="text"
									inputmode="decimal"
									bind:value={draft.amount}
									required
								/>
							</span>
						</label>
						<label class="field">
							<span class="field-label">Cadence</span>
							<select name="cadence" bind:value={draft.cadence}>
								{#each Object.entries(CADENCE_LABELS) as [value, label] (value)}
									<option {value}>{label}</option>
								{/each}
							</select>
						</label>
						<label class="field">
							<span class="field-label">Every N years</span>
							<span class="field-input">
								<input name="cadenceN" type="number" min="1" max="20" bind:value={draft.cadenceN} />
							</span>
						</label>
						<label class="field">
							<span class="field-label">Next due</span>
							<span class="field-input">
								<input name="nextDueOn" type="date" bind:value={draft.nextDueOn} required />
							</span>
						</label>
						<label class="field">
							<span class="field-label">Category</span>
							<select name="category" bind:value={draft.category}>
								<option value="">—</option>
								{#each CATEGORIES as c (c.key)}
									<option value={c.key}>{c.label}</option>
								{/each}
							</select>
						</label>
						<label class="field">
							<span class="field-label">Padding %</span>
							<span class="field-input">
								<input name="paddingPct" type="number" bind:value={draft.paddingPct} />
							</span>
						</label>
					</div>
					<p class="muted">
						The +25% is the documented magnitude of the underestimate, and every year you will find
						it was needed. It is shown, not hidden, and it is not negotiable downward.
					</p>
					<div class="row">
						<button class="primary" type="submit">Save</button>
						<button class="ghost" type="button" onclick={() => (showForm = false)}>Cancel</button>
					</div>
				</form>
			{/if}

			<details class="candidates">
				<summary>Costs people forget — pick one to prefill</summary>
				<p class="muted">
					Recall is exactly what fails here. Recognising a cost from a list is a different cognitive
					task from remembering it, and it is the one that works.
				</p>
				<div class="chips">
					{#each CANDIDATES as c (c.label)}
						<button
							type="button"
							class="chip"
							class:on={picked === c.label}
							onclick={() => {
								picked = c.label;
								startNew({
									label: c.label,
									cadence: c.cadence,
									category: c.category ?? '',
									cadenceN: c.cadenceN ?? ''
								});
							}}
						>
							{c.label}
						</button>
					{/each}
				</div>
			</details>
		</section>
	</main>
{/if}

<style>
	/* ── Coverage hero ────────────────────────────────────────────────── */
	.coverage {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1.25rem;
		border: 1px solid var(--hairline);
		border-radius: 0.625rem;
		background: var(--surface);
	}

	/* Below 1.0 this stops being one tile among twelve. */
	.coverage.short {
		border-color: var(--status-critical);
		border-left-width: 4px;
	}

	.cover-figure {
		margin: 0;
		font-size: clamp(2.5rem, 9vw, 3.25rem);
		line-height: 1;
		font-variant-numeric: proportional-nums;
	}

	.cover-status {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--status-good);
	}

	.coverage.short .cover-status {
		color: var(--status-critical);
	}

	.accrual {
		margin: 0.5rem 0 0;
		padding-top: 0.75rem;
		border-top: 1px solid var(--hairline);
	}

	.muted {
		color: var(--ink-muted);
		font-size: 0.8125rem;
		margin: 0;
	}

	/* ── Reconcile ────────────────────────────────────────────────────── */
	.reconcile {
		border-left: 4px solid var(--status-warning);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.reconcile-row {
		gap: 0.5rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--hairline);
	}

	.reconcile-head {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
		align-items: baseline;
	}

	.reconcile-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}

	/* ── Blocks & tables ──────────────────────────────────────────────── */
	.block {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.block-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.scroll {
		overflow-x: auto;
	}

	th,
	td {
		text-align: right;
		padding: 0.5rem 0.75rem 0.5rem 0;
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

	tbody th {
		font-weight: 400;
		color: var(--ink-secondary);
		white-space: normal;
	}

	.status {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--status-warning);
	}

	.status.good {
		color: var(--status-good);
	}

	.inline {
		display: flex;
		flex-direction: row;
		gap: 0.375rem;
		align-items: center;
		justify-content: flex-end;
	}

	.compact {
		padding: 0 0.5rem;
		max-width: 8rem;
	}

	.compact input {
		min-height: 2.25rem;
		font-size: 0.875rem;
	}

	.small {
		min-height: 2.25rem;
		padding: 0 0.75rem;
		font-size: 0.8125rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.75rem 1rem;
	}

	/* ── Candidates ───────────────────────────────────────────────────── */
	.candidates {
		border: 1px solid var(--hairline);
		border-radius: 0.5rem;
		padding: 0.75rem 1rem;
	}

	.candidates summary {
		cursor: pointer;
		font-size: 0.9375rem;
		color: var(--ink-secondary);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.chip {
		min-height: 2.25rem;
		padding: 0 0.75rem;
		border: 1px solid var(--hairline-strong);
		border-radius: 999px;
		background: none;
		color: var(--ink-secondary);
		font-family: inherit;
		font-size: 0.8125rem;
		cursor: pointer;
	}

	.chip.on,
	.chip:hover {
		border-color: var(--ink-muted);
		color: var(--ink);
	}
</style>
