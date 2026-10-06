<script lang="ts">
	import NavStrip from '$lib/components/NavStrip.svelte';
	import { enhance } from '$app/forms';
	import { formatMoney } from '$lib/money';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const minorUnits = $derived(data.ready ? data.currency.minorUnits : 2);
	const symbol = $derived(data.ready ? data.currency.symbol : '');

	function money(m: number | null | undefined): string {
		if (m === null || m === undefined) return '—';
		return formatMoney(m, { minorUnits, symbol }).replace(/\.00$/, '');
	}
	const apr = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`;

	function months(n: number): string {
		if (n < 12) return `${n} mo`;
		return `${Math.floor(n / 12)}y ${n % 12}m`;
	}

	const MODE_LABEL = {
		snowball: 'Snowball, smallest balance first',
		hybrid: 'Hybrid, smallest first, then optimise',
		avalanche: 'Avalanche, highest rate first'
	} as const;

	let showNew = $state(false);
</script>

<svelte:head><title>Debt · Split</title></svelte:head>

{#if !data.ready}
	<main class="sheet"><p class="eyebrow">Not set up</p></main>
{:else}
	<main class="sheet">
		<NavStrip />

		<header class="masthead">
			<div>
				<h1>Debt</h1>
				<p class="lede">
					What you owe, and how to clear it faster. Clearing the smallest debt first costs more in
					interest but keeps you going, so this screen prices that trade before you choose.
				</p>
			</div>
		</header>

		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

		<!-- The monthly extra is what makes any of this meaningful. -->
		<form method="GET" class="extra">
			<label class="field">
				<span class="field-label">Extra per month, beyond the minimums</span>
				<span class="field-input">
					<span class="field-sym">{symbol}</span>
					<input
						name="extra"
						type="text"
						inputmode="decimal"
						value={data.extraRaw}
						placeholder="5000"
					/>
				</span>
			</label>
			<button class="ghost" type="submit">Recompute</button>
		</form>

		{#if !data.plan}
			<p class="empty">
				No open debts. If you have some, add them below. The payoff order only matters once the app
				can see the rates.
			</p>
		{:else}
			{@const p = data.plan}
			<section class="card">
				<p class="eyebrow">Recommended: {MODE_LABEL[p.mode]}</p>
				<p class="rationale">{p.rationale}</p>

				<!-- All three, always. You are entitled to buy the motivation knowingly. -->
				<div class="scroll">
					<table>
						<thead>
							<tr>
								<th scope="col">Order</th>
								<th scope="col">Interest</th>
								<th scope="col">Time</th>
								<th scope="col">vs avalanche</th>
								<th scope="col"><span class="sr-only">Chosen</span></th>
							</tr>
						</thead>
						<tbody>
							{#each [{ key: 'avalanche', sim: p.avalanche }, { key: 'snowball', sim: p.snowball }, { key: 'hybrid', sim: p.hybrid }] as row (row.key)}
								<tr class:chosen={p.mode === row.key}>
									<th scope="row"
										>{MODE_LABEL[row.key as keyof typeof MODE_LABEL].split(', ')[0]}</th
									>
									<td>{money(row.sim.totalInterestMinor)}</td>
									<td>{row.sim.stalled ? 'never' : months(row.sim.months)}</td>
									<td>
										{row.key === 'avalanche'
											? '—'
											: `+${money(row.sim.totalInterestMinor - p.avalanche.totalInterestMinor)}`}
									</td>
									<td>{p.mode === row.key ? '✓' : ''}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				{#if p.avalanche.stalled || p.snowball.stalled}
					<p class="warn">
						<span aria-hidden="true">!</span>
						At this payment level the balance never clears: the minimums do not cover the interest. Raise
						the monthly extra before reading the order.
					</p>
				{/if}

				<p class="eyebrow order-head">The order</p>
				<ol class="order">
					{#each p.order as id, i (id)}
						{@const d = data.debts.find((x) => x.id === id)}
						{#if d}
							<li>
								<span>{d.label}</span>
								<span class="muted">{money(d.balanceMinor)} · {apr(d.aprBp)} APR</span>
							</li>
						{/if}
					{/each}
				</ol>
			</section>
		{/if}

		<!-- ── Per-debt ─────────────────────────────────────────────────── -->
		<section class="block">
			<div class="block-head">
				<p class="eyebrow">Debts</p>
				<button class="ghost small" type="button" onclick={() => (showNew = !showNew)}>
					{showNew ? 'Cancel' : 'Add a debt'}
				</button>
			</div>

			{#if data.debts.length > 0}
				<div class="scroll">
					<table>
						<thead>
							<tr>
								<th scope="col">Debt</th>
								<th scope="col">Balance</th>
								<th scope="col">APR (annual borrowing cost)</th>
								<th scope="col">Minimum</th>
								<th scope="col"><span class="sr-only">Payment</span></th>
							</tr>
						</thead>
						<tbody>
							{#each data.debts as d (d.id)}
								<tr>
									<th scope="row">{d.label}</th>
									<td>{money(d.balanceMinor)}</td>
									<td class:expensive={d.aprBp >= 1000}>{apr(d.aprBp)}</td>
									<td>{money(d.minPaymentMinor)}</td>
									<td>
										<form method="POST" action="?/payment" use:enhance class="inline">
											<input type="hidden" name="debtId" value={d.id} />
											<label class="field-input compact">
												<span class="field-sym">{symbol}</span>
												<input
													name="amount"
													type="text"
													inputmode="decimal"
													aria-label="Payment to {d.label}"
												/>
											</label>
											<label class="visually-hidden" for="pay-src-{d.id}">Paid from</label>
											<select
												id="pay-src-{d.id}"
												name="sourceAccountId"
												aria-label="Paid from"
												class="compact"
											>
												{#each data.buckets as b (b.id)}
													<option value={b.id}>{b.name}</option>
												{/each}
											</select>
											<button class="ghost small" type="submit">Pay</button>
										</form>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="muted">
					Phase 2 ends when nothing above ~10% APR remains. The rates at or above that are
					marked. Paying one to zero closes it automatically.
				</p>
			{:else}
				<p class="empty">Nothing recorded.</p>
			{/if}

			{#if showNew}
				<form method="POST" action="?/upsert" use:enhance class="card">
					<div class="grid">
						<label class="field">
							<span class="field-label">Label</span>
							<span class="field-input"><input name="label" type="text" required /></span>
						</label>
						<label class="field">
							<span class="field-label">Balance</span>
							<span class="field-input">
								<span class="field-sym">{symbol}</span>
								<input name="balance" type="text" inputmode="decimal" required />
							</span>
						</label>
						<label class="field">
							<span class="field-label">APR % (annual borrowing cost)</span>
							<span class="field-input">
								<input name="apr" type="number" step="0.1" min="0" required />
							</span>
						</label>
						<label class="field">
							<span class="field-label">Minimum payment</span>
							<span class="field-input">
								<span class="field-sym">{symbol}</span>
								<input name="minPayment" type="text" inputmode="decimal" required />
							</span>
						</label>
					</div>
					<button class="primary" type="submit">Save</button>
				</form>
			{/if}
		</section>

		{#if data.closed.length > 0}
			<section class="block">
				<p class="eyebrow">Cleared</p>
				<ul class="cleared">
					{#each data.closed as d (d.id)}
						<li>
							<span aria-hidden="true">✓</span>
							{d.label}, cleared {d.closedOn?.slice(0, 10)}
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</main>
{/if}

<style>
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}

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

	.block-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.extra {
		flex-direction: row !important;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.75rem;
	}

	.rationale {
		margin: 0.5rem 0 1rem;
		font-size: 0.9375rem;
		color: var(--ink-secondary);
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
		color: var(--ink);
	}

	tr.chosen td,
	tr.chosen th {
		color: var(--ink);
		font-weight: 500;
	}

	.expensive {
		color: var(--status-warning);
	}

	.warn {
		margin: 0.75rem 0 0;
		font-size: 0.875rem;
		color: var(--status-warning);
	}

	.order-head {
		margin-top: 1rem;
	}

	.order {
		margin: 0.5rem 0 0;
		padding-left: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.order li {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		justify-content: space-between;
		font-size: 0.9375rem;
	}

	.cleared {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		color: var(--ink-secondary);
		font-size: 0.9375rem;
	}

	.cleared span {
		color: var(--status-good);
		margin-right: 0.4rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: 0.75rem 1rem;
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
		max-width: 7rem;
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
</style>
