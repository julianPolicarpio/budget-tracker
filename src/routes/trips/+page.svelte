<script lang="ts">
	import NavStrip from '$lib/components/NavStrip.svelte';
	import { enhance } from '$app/forms';
	import Figure from '$lib/components/Figure.svelte';
	import { formatMoney } from '$lib/money';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const minorUnits = $derived(data.ready ? data.currency.minorUnits : 2);
	const symbol = $derived(data.ready ? data.currency.symbol : '');

	function money(m: number | null | undefined): string {
		if (m === null || m === undefined) return '—';
		return formatMoney(m, { minorUnits, symbol }).replace(/\.00$/, '');
	}
	function dayLabel(iso: string | null): string {
		if (!iso) return '—';
		return new Intl.DateTimeFormat('en-GB', {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			timeZone: 'UTC'
		}).format(new Date(iso.slice(0, 10) + 'T00:00:00Z'));
	}

	let showDeclare = $state(false);
	let coveringId = $state<number | null>(null);
</script>

<svelte:head><title>Trips · Split</title></svelte:head>

{#if !data.ready}
	<main class="sheet"><p class="eyebrow">Not set up</p></main>
{:else}
	<main class="sheet">
		<NavStrip />

		<header class="masthead">
			<div>
				<h1>Trips</h1>
				<p class="lede">
					Plan a trip, track what you spend while you are on it, and settle the cost when you get
					back. Trip spending stays out of your ordinary daily figure.
				</p>
			</div>
		</header>

		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

		<!-- ── Active trip ──────────────────────────────────────────────── -->
		{#if data.active}
			{@const a = data.active}
			{@const envelope = a.trip.envelopeMinor + a.trip.bufferDrawMinor}
			<section class="card">
				<p class="eyebrow">Active — {a.trip.label}</p>
				<p class="hero-figure">{money(Math.max(0, envelope - a.drawnMinor))}</p>
				<p class="muted">
					left of {money(envelope)}
					{#if a.trip.bufferDrawMinor > 0}
						(including {money(a.trip.bufferDrawMinor)} taken from the Emergency fund)
					{/if}
					· {dayLabel(a.trip.startsOn)} – {dayLabel(a.trip.endsOn)} · {a.trip.tripTz}
				</p>

				<dl class="facts">
					<div>
						<dt>Logged locally</dt>
						<dd>
							{formatMoney(a.drawnLocalMinor, {
								minorUnits: a.trip.localMinorUnits,
								symbol: a.trip.currencySymbol
							})}
						</dd>
					</div>
					<div>
						<dt>Locked rate</dt>
						<dd>{a.trip.fxRateToHome}</dd>
					</div>
					<div>
						<dt>Currency</dt>
						<dd>{a.trip.currencyCode} · {a.trip.localMinorUnits} dp</dd>
					</div>
				</dl>
			</section>

			<Figure
				title="Spending — actual against pace"
				emptyNote="Fills in as you log. The straight line is the even-spend pace; being above it early is normal, because flights and deposits are front-loaded."
				minPoints={3}
				columns={['Day', 'Cumulative', 'Pace']}
				rows={a.burndown.map((p) => [
					dayLabel(p.date),
					money(p.cumulativeMinor),
					money(p.paceMinor)
				])}
				render={a.burndown.length >= 2
					? (Plot, width) =>
							Plot.plot({
								width,
								height: 220,
								marginLeft: 60,
								marginRight: 70,
								x: { label: null, type: 'utc' },
								y: { label: null, grid: true, tickFormat: (d: number) => money(d) },
								style: {
									background: 'transparent',
									color: 'var(--ink-muted)',
									fontSize: '11px'
								},
								marks: [
									Plot.line(a.burndown, {
										x: (d: { date: string }) => new Date(d.date),
										y: 'paceMinor',
										stroke: 'var(--series-2)',
										strokeWidth: 1.5,
										strokeDasharray: '3,3'
									}),
									Plot.line(a.burndown, {
										x: (d: { date: string }) => new Date(d.date),
										y: 'cumulativeMinor',
										stroke: 'var(--series-1)',
										strokeWidth: 2
									}),
									Plot.text([a.burndown.at(-1)], {
										x: (d: { date: string }) => new Date(d.date),
										y: 'cumulativeMinor',
										text: () => 'actual',
										dx: 6,
										textAnchor: 'start',
										fill: 'var(--series-1-fill)'
									}),
									Plot.text([a.burndown.at(-1)], {
										x: (d: { date: string }) => new Date(d.date),
										y: 'paceMinor',
										text: () => 'pace',
										dx: 6,
										textAnchor: 'start',
										fill: 'var(--series-2-fill)'
									})
								]
							})
					: null}
			/>

			<section class="block">
				<p class="eyebrow">Rate and settle</p>
				<div class="two">
					<form method="POST" action="?/setRate" use:enhance class="card">
						<input type="hidden" name="id" value={a.trip.id} />
						<label class="field">
							<span class="field-label">Exchange rate — home per 1 {a.trip.currencyCode}</span>
							<span class="field-input">
								<input
									name="fxRateToHome"
									type="number"
									step="0.0001"
									value={a.trip.fxRateToHome}
									required
								/>
							</span>
						</label>
						<p class="muted">
							Take one withdrawal and divide: home debited ÷ local received. That captures the ATM
							fee and the card markup, which run several percent — far larger than rate drift over
							two weeks. A live mid-market rate would be <em>less</em> accurate, not more.
						</p>
						<button class="ghost" type="submit">Update rate</button>
					</form>

					<form method="POST" action="?/settle" use:enhance class="card">
						<input type="hidden" name="id" value={a.trip.id} />
						<label class="field">
							<span class="field-label">What the bank actually charged</span>
							<span class="field-input">
								<span class="field-sym">{symbol}</span>
								<input name="actual" type="text" inputmode="decimal" required />
							</span>
						</label>
						<label class="field">
							<span class="field-label">Settled on</span>
							<span class="field-input">
								<input name="settledOn" type="date" value={data.today} />
							</span>
						</label>
						<p class="muted">
							Two numbers, and their difference is the point. <strong>Set aside − logged</strong> is
							the estimate error, which tunes next year. <strong>Actual − logged</strong> is the exchange-rate and
							fee error, which tunes next trip's rate. Different failures, different fixes.
						</p>
						<button class="primary" type="submit">Settle the trip</button>
					</form>
				</div>
			</section>
		{/if}

		<!-- ── Planned trips and the funding check ──────────────────────── -->
		<section class="block">
			<div class="block-head">
				<p class="eyebrow">Planned</p>
				<button class="ghost small" type="button" onclick={() => (showDeclare = !showDeclare)}>
					{showDeclare ? 'Cancel' : 'Declare a trip'}
				</button>
			</div>

			{#if data.planned.length === 0}
				<p class="empty">
					Nothing planned. Declare a trip the moment you book it — an hour later it exists
					emotionally but not financially, and that gap is where the whole cost goes unfunded.
				</p>
			{/if}

			{#each data.planned as p (p.trip.id)}
				{@const pct = Math.min(100, (p.check.fundedMinor / p.check.envelopeMinor) * 100)}
				<div class="card" class:urgent={p.check.due && p.check.shortfallMinor > 0}>
					<div class="trip-head">
						<strong>{p.trip.label}</strong>
						<span class="muted">
							{dayLabel(p.trip.startsOn)} – {dayLabel(p.trip.endsOn)} ·
							{p.check.daysToDeparture} days out
						</span>
					</div>

					<div class="meter" role="img" aria-label="{Math.round(pct)}% funded">
						<span class="meter-fill" style="--w: {pct}%"></span>
					</div>
					<p class="status" class:good={p.check.shortfallMinor === 0}>
						<span aria-hidden="true">{p.check.shortfallMinor === 0 ? '✓' : '!'}</span>
						{p.check.shortfallMinor === 0
							? `funded — ${money(p.check.envelopeMinor)}`
							: `short by ${money(p.check.shortfallMinor)} of ${money(p.check.envelopeMinor)}`}
					</p>

					{#if p.check.due && p.check.shortfallMinor > 0}
						<!--
							Three honest options, and no dismiss. Letting the shortfall
							quietly consume the next two periods of Spend is the default
							failure this check exists to prevent.
						-->
						<div class="options">
							<p class="eyebrow">Three options, and there is no fourth</p>
							<ol>
								<li>Shorten it.</li>
								<li>Downgrade it.</li>
								<li>Take the shortfall from the Emergency fund, with an IOU.</li>
							</ol>
							{#if coveringId === p.trip.id}
								<form method="POST" action="?/coverShortfall" use:enhance>
									<input type="hidden" name="id" value={p.trip.id} />
									<div class="grid">
										<label class="field">
											<span class="field-label">Amount</span>
											<span class="field-input">
												<span class="field-sym">{symbol}</span>
												<input
													name="amount"
													type="text"
													inputmode="decimal"
													value={String(p.check.shortfallMinor / 10 ** minorUnits)}
													required
												/>
											</span>
										</label>
										<label class="field">
											<span class="field-label">Why (required)</span>
											<span class="field-input"
												><input name="iouReason" type="text" required /></span
											>
										</label>
										<label class="field">
											<span class="field-label">Back by</span>
											<span class="field-input"><input name="iouRepayBy" type="date" /></span>
										</label>
									</div>
									<button class="primary" type="submit">Take from Emergency fund with an IOU</button>
								</form>
							{:else}
								<button class="ghost" type="button" onclick={() => (coveringId = p.trip.id)}>
									Take from the Emergency fund
								</button>
							{/if}
						</div>
					{/if}

					<div class="row">
						<form method="POST" action="?/activate" use:enhance>
							<input type="hidden" name="id" value={p.trip.id} />
							<button class="ghost small" type="submit">Start the trip</button>
						</form>
						<form method="POST" action="?/cancel" use:enhance>
							<input type="hidden" name="id" value={p.trip.id} />
							<button class="ghost small" type="submit">Cancel</button>
						</form>
					</div>
				</div>
			{/each}

			{#if showDeclare}
				<form method="POST" action="?/declare" use:enhance class="card">
					<div class="grid">
						<label class="field">
							<span class="field-label">Label</span>
							<span class="field-input">
								<input name="label" type="text" placeholder="Tokyo, September" required />
							</span>
						</label>
						<label class="field">
							<span class="field-label">Starts</span>
							<span class="field-input"><input name="startsOn" type="date" required /></span>
						</label>
						<label class="field">
							<span class="field-label">Ends</span>
							<span class="field-input"><input name="endsOn" type="date" required /></span>
						</label>
						<label class="field">
							<span class="field-label">Timezone</span>
							<span class="field-input">
								<input name="tripTz" type="text" placeholder="Asia/Tokyo" required />
							</span>
						</label>
						<label class="field">
							<span class="field-label">Currency code</span>
							<span class="field-input">
								<input name="currencyCode" type="text" placeholder="JPY" required />
							</span>
						</label>
						<label class="field">
							<span class="field-label">Symbol</span>
							<span class="field-input">
								<input name="currencySymbol" type="text" placeholder="¥" required />
							</span>
						</label>
						<label class="field">
							<span class="field-label">Decimal places</span>
							<select name="localMinorUnits">
								<option value="2">2 — most currencies</option>
								<option value="0">0 — JPY, KRW, VND</option>
								<option value="3">3 — KWD, BHD, JOD</option>
							</select>
						</label>
						<label class="field">
							<span class="field-label">Exchange rate — home per 1 unit</span>
							<span class="field-input">
								<input
									name="fxRateToHome"
									type="number"
									step="0.0001"
									placeholder="0.38"
									required
								/>
							</span>
						</label>
						<label class="field">
							<span class="field-label">Estimate (before padding)</span>
							<span class="field-input">
								<span class="field-sym">{symbol}</span>
								<input name="estimate" type="text" inputmode="decimal" required />
							</span>
						</label>
					</div>
					<p class="muted">
						The estimate is padded 25% like any other irregular, and the trip is set aside from
						Irregulars from now until departure. Anything past {data.maxTripDays} days is a relocation,
						not a trip — that needs a fresh calibration, not a bigger set-aside.
					</p>
					<button class="primary" type="submit">Declare it</button>
				</form>
			{/if}
		</section>

		<!-- ── Past trips ───────────────────────────────────────────────── -->
		{#if data.past.length > 0}
			<section class="block">
				<p class="eyebrow">Past</p>
				<div class="scroll">
					<table>
						<thead>
							<tr>
								<th scope="col">Trip</th>
								<th scope="col">When</th>
								<th scope="col">Set aside</th>
								<th scope="col">Logged</th>
								<th scope="col">Actual</th>
								<th scope="col">Estimate error</th>
								<th scope="col">Rate error</th>
							</tr>
						</thead>
						<tbody>
							{#each data.past as t (t.id)}
								<tr>
									<th scope="row">{t.label}</th>
									<td>{dayLabel(t.startsOn)}</td>
									<td>{money(t.envelopeMinor)}</td>
									<td>{money(t.loggedTotalMinor)}</td>
									<td>{money(t.actualMinor)}</td>
									<td>
										{t.loggedTotalMinor !== null
											? money(t.envelopeMinor - t.loggedTotalMinor)
											: '—'}
									</td>
									<td>
										{t.actualMinor !== null && t.loggedTotalMinor !== null
											? money(t.actualMinor - t.loggedTotalMinor)
											: '—'}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="muted">
					This is the same data behind the estimate-accuracy chart on Irregulars. Travel is where
					your estimation error is largest and most visible, which makes it the most valuable
					calibration you will ever generate.
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

	.block-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.hero-figure {
		margin: 0.25rem 0 0.25rem;
		font-size: clamp(2.25rem, 8vw, 3rem);
		line-height: 1;
		font-variant-numeric: proportional-nums;
	}

	.facts {
		margin: 1rem 0 0;
		padding-top: 0.875rem;
		border-top: 1px solid var(--hairline);
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 0.75rem;
	}

	.facts div {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.facts dt {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-muted);
	}

	.facts dd {
		margin: 0;
		font-size: 0.9375rem;
		font-variant-numeric: tabular-nums;
	}

	.two {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
		gap: 0.75rem;
	}

	.trip-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}

	.card.urgent {
		border-left: 4px solid var(--status-warning);
	}

	.meter {
		position: relative;
		height: 0.5rem;
		background: var(--hairline);
		border-radius: 1px;
	}

	.meter-fill {
		position: absolute;
		inset-block: 0;
		left: 0;
		width: var(--w);
		background: var(--series-1-fill);
		border-radius: 1px;
	}

	.status {
		margin: 0.5rem 0 0;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--status-warning);
	}

	.status.good {
		color: var(--status-good);
	}

	.options {
		margin-top: 1rem;
		padding-top: 0.875rem;
		border-top: 1px solid var(--hairline);
	}

	.options ol {
		margin: 0.5rem 0 0.875rem;
		padding-left: 1.25rem;
		color: var(--ink-secondary);
		font-size: 0.9375rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: 0.75rem 1rem;
	}

	.small {
		min-height: 2.25rem;
		padding: 0 0.75rem;
		font-size: 0.8125rem;
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
</style>
