<script lang="ts">
	import ReviewNav from '$lib/components/ReviewNav.svelte';
	import { enhance } from '$app/forms';
	import { dailyAllowance, displayBand } from '$lib/allowance';
	import { formatMoney, parseMoney } from '$lib/money';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	function money(minor: number | null | undefined): string {
		if (minor === null || minor === undefined) return '—';
		return formatMoney(minor, {
			minorUnits: data.ready ? data.currency.minorUnits : 2,
			symbol: data.ready ? data.currency.symbol : ''
		});
	}

	function major(minor: number | null | undefined): string {
		if (minor === null || minor === undefined) return '';
		return formatMoney(minor, {
			minorUnits: data.ready ? data.currency.minorUnits : 2,
			group: false
		});
	}

	function dayLabel(iso: string, opts: Intl.DateTimeFormatOptions = {}): string {
		return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(
			new Date(iso + 'T00:00:00Z')
		);
	}

	// ── R5's live preview. Same functions the server freezes the number with,
	// so the slider cannot drift from what gets written (Spec §6.1).
	let allocInput = $state('');
	$effect(() => {
		if (data.ready && data.period && allocInput === '') {
			allocInput = major(data.period.spendAllocMinor);
		}
	});

	const preview = $derived.by(() => {
		if (!data.ready || !data.period) return null;
		const alloc = parseMoney(allocInput, data.currency.minorUnits);
		if (alloc === null || alloc <= 0) return null;
		const allowance = dailyAllowance(
			{ spendAllocMinor: alloc, days: data.period.days },
			data.haircutPct
		);
		return {
			allowance,
			band: displayBand(allowance, {
				bandPct: data.bandPct,
				roundingStep: data.roundingStep
			})
		};
	});

	let copied = $state(false);
	async function copy(line: string) {
		await navigator.clipboard.writeText(line);
		copied = true;
		setTimeout(() => (copied = false), 1600);
	}

	const maxBar = $derived(
		data.ready ? Math.max(1, ...data.actuals.byCategory.map((c) => c.minor)) : 1
	);
</script>

<svelte:head>
	<title>Weekly review · Split</title>
</svelte:head>

{#if !data.ready}
	<main class="sheet">
		<p class="eyebrow">Not set up</p>
		<p>Run <code>npm run db:init</code> before the first review.</p>
	</main>
{:else}
	<main class="sheet">
		<header class="masthead">
			<div>
				<p class="eyebrow">Weekly money date</p>
				<h1>
					{data.week.label}
					<span class="range">
						{dayLabel(data.week.startsOn, { day: 'numeric', month: 'short' })} –
						{dayLabel(data.week.endsOn, { day: 'numeric', month: 'short' })}
					</span>
				</h1>
			</div>
		</header>

		<ReviewNav />

		<!-- Six steps, and the rail says which one you are on. This is a real
		     sequence, so it is numbered. -->
		<nav class="rail" aria-label="Review steps">
			{#each data.steps as s (s.key)}
				<a
					class="rail-step"
					class:on={s.n === data.step}
					class:done={s.done}
					href="/review?step={s.n}"
					aria-current={s.n === data.step ? 'step' : undefined}
				>
					<span class="rail-n">{s.done && s.n !== data.step ? '✓' : s.n}</span>
					<span class="rail-t">{s.title}</span>
				</a>
			{/each}
		</nav>

		{#if form?.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}

		<!-- ── R1 ──────────────────────────────────────────────────────────── -->
		{#if data.step === 1}
			<section class="step">
				<h2>Log the four balances</h2>
				<p class="lede">
					Open each account and type what it actually says. Physical recording is what carries the
					effect — thinking about the number does not do this work.
				</p>

				<form method="POST" action="?/balances" use:enhance>
					<div class="fields">
						{#each [{ name: 'spend', label: 'Spend', value: data.review.spendBalanceMinor, ghost: data.prior?.spendBalanceMinor }, { name: 'irregulars', label: 'Irregulars', value: data.review.irregularsMinor, ghost: data.prior?.irregularsMinor }, { name: 'buffer', label: 'Buffer', value: data.review.bufferMinor, ghost: data.prior?.bufferMinor }, { name: 'debt', label: 'Total debt', value: data.review.debtTotalMinor, ghost: data.prior?.debtTotalMinor }] as f (f.name)}
							<label class="field">
								<span class="field-label">{f.label}</span>
								<span class="field-input">
									<span class="field-sym">{data.currency.symbol}</span>
									<input
										name={f.name}
										type="text"
										inputmode="decimal"
										autocomplete="off"
										placeholder="0"
										value={major(f.value)}
									/>
								</span>
								<!-- The ghost is a sanity check, not a suggestion: a tenfold
								     typo is obvious next to last week, and invisible alone. -->
								<span class="ghost-value">
									{#if f.ghost === null || f.ghost === undefined}
										no prior week
									{:else}
										{data.prior?.label}: {money(f.ghost)}
									{/if}
								</span>
							</label>
						{/each}
					</div>
					<button class="primary" type="submit">Save and continue</button>
				</form>
			</section>
		{/if}

		<!-- ── R2 ──────────────────────────────────────────────────────────── -->
		{#if data.step === 2}
			<section class="step">
				<h2>This week's actuals</h2>

				{#if data.actuals.totalMinor === 0}
					<p class="empty">
						Nothing logged between {dayLabel(data.week.startsOn, {
							day: 'numeric',
							month: 'short'
						})} and {dayLabel(data.week.endsOn, { day: 'numeric', month: 'short' })}. The bars fill
						from your nightly entries.
					</p>
				{:else}
					<!-- Bars are magnitude, not identity: one hue, sorted descending.
					     Eight colours across eight categories is the classic mistake. -->
					<table class="bars">
						<caption class="sr-only">Spend by category, this week</caption>
						<tbody>
							{#each data.actuals.byCategory.filter((c) => c.minor > 0) as c (c.key)}
								<tr>
									<th scope="row">{c.label}</th>
									<td class="bar-cell">
										<span class="bar" style="--w: {(c.minor / maxBar) * 100}%"></span>
									</td>
									<td class="bar-val">{money(c.minor)}</td>
								</tr>
							{/each}
						</tbody>
					</table>

					<div class="card meter-card">
						<p class="eyebrow">Unplanned ratio</p>
						<p class="meter-value">
							{data.actuals.unplannedRatioBp === null
								? '—'
								: `${Math.round(data.actuals.unplannedRatioBp / 100)}%`}
							<span class="meter-note">
								{money(data.actuals.unplannedMinor)} of {money(data.actuals.totalMinor)}
							</span>
						</p>
						<div
							class="meter"
							role="img"
							aria-label="Unplanned ratio {Math.round(
								(data.actuals.unplannedRatioBp ?? 0) / 100
							)} percent"
						>
							<span
								class="meter-fill"
								style="--w: {Math.min(100, (data.actuals.unplannedRatioBp ?? 0) / 100)}%"
							></span>
							{#if data.prior?.unplannedRatioBp != null}
								<span
									class="meter-tick"
									style="--x: {Math.min(100, data.prior.unplannedRatioBp / 100)}%"
									title="Last week"
								></span>
							{/if}
						</div>
						<p class="meter-foot">
							{#if data.prior?.unplannedRatioBp != null}
								Tick marks last week: {Math.round(data.prior.unplannedRatioBp / 100)}%.
							{/if}
							40–50% is a normal start. Under 25% by month three is good.
						</p>
					</div>
				{/if}

				<form method="POST" action="?/step" use:enhance>
					<input type="hidden" name="stepKey" value="actuals" />
					<input type="hidden" name="next" value="3" />
					<input
						type="hidden"
						name="unplannedRatioBp"
						value={String(data.actuals.unplannedRatioBp ?? '')}
					/>
					<button class="primary" type="submit">Continue</button>
				</form>
			</section>
		{/if}

		<!-- ── R3 ──────────────────────────────────────────────────────────── -->
		{#if data.step === 3}
			<section class="step">
				<h2>Top three transactions</h2>
				<p class="lede">
					Not the total — the top three. One question each, three answers, no analysis.
				</p>

				{#if data.topThree.length === 0}
					<p class="empty">No entries this week, so there is nothing to weigh up.</p>
					<form method="POST" action="?/step" use:enhance>
						<input type="hidden" name="stepKey" value="top_three" />
						<input type="hidden" name="next" value="4" />
						<button class="primary" type="submit">Continue</button>
					</form>
				{:else}
					<form method="POST" action="?/step" use:enhance>
						<input type="hidden" name="stepKey" value="top_three" />
						<input type="hidden" name="next" value="4" />
						<div class="judgements">
							{#each data.topThree as t (t.id)}
								<div class="card judgement">
									<p class="judgement-head">
										<span class="judgement-amt">{money(t.amountMinor)}</span>
										<span class="judgement-meta">
											{t.label} · {dayLabel(t.spentOn, { weekday: 'short' })}
											{#if !t.planned}<span class="tag">unplanned</span>{/if}
										</span>
									</p>
									<p class="judgement-q">Would I do that again?</p>
									<div class="answers">
										{#each ['yes', 'meh', 'no'] as answer (answer)}
											<label class="answer">
												<input type="radio" name="txn_{t.id}" value={answer} required />
												<span>{answer === 'yes' ? 'Yes' : answer === 'no' ? 'No' : 'Meh'}</span>
											</label>
										{/each}
									</div>
								</div>
							{/each}
						</div>
						<button class="primary" type="submit">Continue</button>
					</form>
				{/if}
			</section>
		{/if}

		<!-- ── R4 ──────────────────────────────────────────────────────────── -->
		{#if data.step === 4}
			<section class="step">
				<h2>Week ahead</h2>
				<p class="lede">
					Anything on the calendar that costs money? Naming it now is what stops it eating the daily
					number later.
				</p>

				<ol class="calendar">
					{#each data.aheadDays as d (d)}
						<li>
							<span class="cal-dow">{dayLabel(d, { weekday: 'short' })}</span>
							<span class="cal-day">{dayLabel(d, { day: 'numeric' })}</span>
						</li>
					{/each}
				</ol>

				<p class="empty">
					Scheduled irregulars appear on this strip in Phase 3, with a one-tap “move to Spend,
					tagged”. Until then, write them down.
				</p>

				<form method="POST" action="?/step" use:enhance>
					<input type="hidden" name="stepKey" value="week_ahead" />
					<input type="hidden" name="next" value="5" />
					<label class="field block">
						<span class="field-label">Costs coming up</span>
						<textarea
							name="notes"
							rows="3"
							placeholder="Enrolment fee Thursday, ₱3,000 — from Irregulars"></textarea>
					</label>
					<button class="primary" type="submit">Continue</button>
				</form>
			</section>
		{/if}

		<!-- ── R5 ──────────────────────────────────────────────────────────── -->
		{#if data.step === 5}
			<section class="step">
				<h2>Adjust the number</h2>
				<p class="lede">
					Mid-period adjustment is one of the interventions that reduced overspending. A budget you
					are allowed to update is a budget you do not abandon.
				</p>

				{#if !data.period}
					<p class="empty">
						No open period, so there is nothing to adjust. Open one with
						<code>npm run period:open</code>.
					</p>
					<form method="POST" action="?/adjust" use:enhance>
						<input type="hidden" name="keep" value="1" />
						<button class="primary" type="submit">Continue</button>
					</form>
				{:else}
					<form method="POST" action="?/adjust" use:enhance>
						<div class="card adjust">
							<dl class="facts">
								<div>
									<dt>Period</dt>
									<dd>{data.period.startsOn} → {data.period.endsOn}</dd>
								</div>
								<div>
									<dt>Days</dt>
									<dd>{data.period.days}</dd>
								</div>
								<div>
									<dt>Current allocation</dt>
									<dd>{money(data.period.spendAllocMinor)}</dd>
								</div>
								<div>
									<dt>Haircut</dt>
									<dd>{data.haircutPct}%</dd>
								</div>
							</dl>

							<label class="field block">
								<span class="field-label">New Spend allocation for the period</span>
								<span class="field-input">
									<span class="field-sym">{data.currency.symbol}</span>
									<input
										name="alloc"
										bind:value={allocInput}
										type="text"
										inputmode="decimal"
										autocomplete="off"
									/>
								</span>
							</label>

							{#if preview}
								<p class="preview">
									<span class="eyebrow">New band</span>
									<span class="preview-band"
										>{money(preview.band.low)} – {money(preview.band.high)}</span
									>
									<span class="preview-note">
										from {money(preview.allowance)}/day · replaces the period, never edits it
									</span>
								</p>
							{/if}
						</div>

						<div class="row">
							<button class="primary" type="submit">Apply and continue</button>
							<button class="ghost" type="submit" name="keep" value="1">Keep it as is</button>
						</div>
					</form>
				{/if}
			</section>
		{/if}

		<!-- ── R6 ──────────────────────────────────────────────────────────── -->
		{#if data.step === 6}
			<section class="step">
				<h2>Send it</h2>

				{#if !data.review.completedAt}
					<p class="lede">
						Finishing snapshots the week's metrics onto the review row. That row is the artefact —
						the thing that makes monitoring work rather than just happen.
					</p>
					<form method="POST" action="?/complete" use:enhance>
						<button class="primary" type="submit">Finish review</button>
					</form>
				{:else}
					<p class="lede">
						One line, one other human. Reporting progress to someone was a moderator in the
						monitoring meta-analysis, and it costs nothing.
					</p>

					<div class="card oneliner">
						<p class="line">{data.review.summaryLine}</p>
						<div class="row">
							<button
								class="primary"
								type="button"
								onclick={() => copy(data.review.summaryLine ?? '')}
							>
								{copied ? 'Copied' : 'Copy line'}
							</button>
							<form method="POST" action="?/share" use:enhance>
								<button class="ghost" type="submit">
									{data.review.sharedAt ? 'Marked as sent ✓' : 'Mark as sent'}
								</button>
							</form>
						</div>
					</div>

					<table class="snapshot">
						<caption class="eyebrow">Snapshot</caption>
						<tbody>
							<tr><th scope="row">Spent</th><td>{money(data.review.totalSpentMinor)}</td></tr>
							<tr>
								<th scope="row">Unplanned ratio</th>
								<td>
									{data.review.unplannedRatioBp === null
										? '—'
										: `${(data.review.unplannedRatioBp / 100).toFixed(1)}%`}
								</td>
							</tr>
							<tr>
								<th scope="row">Buffer weeks</th>
								<td>
									{#if data.review.bufferWeeksX100 === null}
										<span class="pending">
											needs weekly take-home — set it with
											<code>npm run db:init -- --take-home &lt;amount&gt;</code>
										</span>
									{:else}
										{(data.review.bufferWeeksX100 / 100).toFixed(1)} / 6.0
									{/if}
								</td>
							</tr>
							<tr>
								<th scope="row">Log adherence</th>
								<td>{((data.review.logAdherenceBp ?? 0) / 100).toFixed(0)}%</td>
							</tr>
							<tr><th scope="row">Streak</th><td>{data.review.streakAtClose ?? 0} days</td></tr>
							<tr>
								<th scope="row">Irregulars coverage</th>
								<td><span class="pending">Phase 3 — needs the irregulars engine</span></td>
							</tr>
							<tr>
								<th scope="row">Save rate</th>
								<td><span class="pending">Phase 3 — needs income rows</span></td>
							</tr>
						</tbody>
					</table>

					<a class="ghost link" href="/">Back to today</a>
				{/if}
			</section>
		{/if}
	</main>
{/if}

<style>
	/*
	 * REVIEW class. Everything unlocks here, and the screen must say so in half
	 * a second without being read: wider measure, cards, rules, tables, dense
	 * type, a numbered rail. Today is one number on an empty field; this is an
	 * instrument panel. The contrast is the withholding layer made visible.
	 */

	.range {
		font-size: 0.9375rem;
		font-weight: 400;
		color: var(--ink-muted);
		margin-left: 0.5rem;
	}

	/* ── Rail ─────────────────────────────────────────────────────────── */
	.rail {
		display: grid;
		grid-template-columns: repeat(6, 1fr);
		gap: 1px;
		background: var(--hairline);
		border: 1px solid var(--hairline);
		border-radius: 0.5rem;
		overflow: hidden;
	}

	.rail-step {
		background: var(--ground);
		padding: 0.625rem 0.5rem;
		text-decoration: none;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-height: 3.25rem;
	}

	.rail-n {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--ink-muted);
	}

	.rail-t {
		font-size: 0.75rem;
		line-height: 1.25;
		color: var(--ink-muted);
	}

	.rail-step.done .rail-n {
		color: var(--status-good);
	}

	.rail-step.on {
		background: var(--surface);
	}

	.rail-step.on .rail-n,
	.rail-step.on .rail-t {
		color: var(--ink);
	}

	@media (max-width: 34rem) {
		.rail-t {
			display: none;
		}
		.rail-step {
			min-height: 2.75rem;
			align-items: center;
			justify-content: center;
		}
	}

	/* ── Steps ────────────────────────────────────────────────────────── */

	/* ── Fields ───────────────────────────────────────────────────────── */
	/* Four balances, so the grid resolves to 4 / 2 / 1 rather than leaving an
	   orphan on a second row. */
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
		gap: 0.75rem 1rem;
	}

	.ghost-value {
		font-size: 0.75rem;
		color: var(--ink-muted);
		font-variant-numeric: tabular-nums;
	}

	/* ── Bars ─────────────────────────────────────────────────────────── */
	.bars {
		width: 100%;
		border-collapse: collapse;
	}

	.bars th {
		text-align: left;
		font-weight: 400;
		font-size: 0.875rem;
		color: var(--ink-secondary);
		padding: 0.35rem 0.75rem 0.35rem 0;
		white-space: nowrap;
	}

	.bar-cell {
		width: 100%;
		padding: 0.35rem 0;
	}

	.bar {
		display: block;
		height: 0.6rem;
		width: var(--w);
		min-width: 2px;
		border-radius: 1px;
		background: var(--series-1, #3987e5);
	}

	.bar-val {
		padding-left: 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
		text-align: right;
		white-space: nowrap;
	}

	/* ── Meter ────────────────────────────────────────────────────────── */
	.meter-value {
		margin: 0.25rem 0 0.75rem;
		font-size: 1.75rem;
		font-weight: 400;
	}

	.meter-note {
		display: block;
		font-size: 0.8125rem;
		color: var(--ink-muted);
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
		background: var(--series-1, #3987e5);
		border-radius: 1px;
	}

	.meter-tick {
		position: absolute;
		top: -3px;
		bottom: -3px;
		left: var(--x);
		width: 2px;
		background: var(--ink);
	}

	.meter-foot {
		margin: 0.625rem 0 0;
		font-size: 0.8125rem;
		color: var(--ink-muted);
	}

	/* ── Judgements ───────────────────────────────────────────────────── */
	.judgements {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.judgement-head {
		margin: 0 0 0.75rem;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.75rem;
	}

	.judgement-amt {
		font-family: var(--font-mono);
		font-size: 1.25rem;
		font-variant-numeric: tabular-nums;
	}

	.judgement-meta {
		font-size: 0.8125rem;
		color: var(--ink-muted);
	}

	.tag {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		margin-left: 0.4rem;
	}

	.judgement-q {
		margin: 0 0 0.625rem;
		font-size: 0.9375rem;
	}

	.answers {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.5rem;
	}

	.answer {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 2.75rem;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.5rem;
		font-size: 0.875rem;
		color: var(--ink-secondary);
		cursor: pointer;
	}

	.answer input {
		position: absolute;
		opacity: 0;
		width: 1px;
		height: 1px;
	}

	.answer:has(input:checked) {
		background: var(--ink);
		border-color: var(--ink);
		color: var(--ground);
	}

	.answer:has(input:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* ── Calendar strip ───────────────────────────────────────────────── */
	.calendar {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 1px;
		background: var(--hairline);
		border: 1px solid var(--hairline);
		border-radius: 0.5rem;
		overflow: hidden;
	}

	.calendar li {
		background: var(--surface);
		padding: 0.625rem 0.25rem;
		text-align: center;
		min-height: 3.5rem;
	}

	.cal-dow {
		display: block;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-muted);
	}

	.cal-day {
		display: block;
		font-size: 1rem;
		font-variant-numeric: tabular-nums;
		margin-top: 0.2rem;
	}

	/* ── Adjust ───────────────────────────────────────────────────────── */
	.facts {
		margin: 0 0 1rem;
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

	.preview {
		margin: 1rem 0 0;
		padding-top: 0.875rem;
		border-top: 1px solid var(--hairline);
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.preview-band {
		font-size: 1.75rem;
		font-variant-numeric: proportional-nums;
	}

	.preview-note {
		font-size: 0.8125rem;
		color: var(--ink-muted);
	}

	/* ── One-liner ────────────────────────────────────────────────────── */
	.oneliner .line {
		margin: 0 0 1rem;
		font-family: var(--font-mono);
		font-size: 0.9375rem;
		line-height: 1.6;
	}

	.snapshot {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9375rem;
	}

	.snapshot caption {
		text-align: left;
		padding-bottom: 0.5rem;
	}

	.snapshot th {
		text-align: left;
		font-weight: 400;
		color: var(--ink-secondary);
		padding: 0.5rem 0.75rem 0.5rem 0;
		border-bottom: 1px solid var(--hairline);
	}

	.snapshot td {
		text-align: right;
		font-variant-numeric: tabular-nums;
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--hairline);
	}

	.link {
		align-self: flex-start;
		padding: 0.6rem 1rem;
	}
</style>
