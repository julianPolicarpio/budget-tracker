<script lang="ts">
	/**
	 * REVIEW register (Spec §8.0b): dense, tabular, numbers visible. The
	 * opposite of Today by design — this is a screen you open deliberately,
	 * once a week, to make decisions on.
	 */
	import ReviewNav from '$lib/components/ReviewNav.svelte';
	import SubscriptionEdit from '$lib/components/SubscriptionEdit.svelte';
	import { enhance } from '$app/forms';
	import { CATEGORIES } from '$lib/categories';
	import { CADENCE_LABELS } from '$lib/subscription-cadence';
	import { formatMoney } from '$lib/money';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const minorUnits = $derived(data.ready ? data.currency.minorUnits : 2);
	const symbol = $derived(data.ready ? data.currency.symbol : '');

	function money(m: number | null | undefined): string {
		if (m === null || m === undefined) return '—';
		return formatMoney(m, { minorUnits, symbol, group: true }).replace(/\.00$/, '');
	}

	const MONTHS: Record<string, number> = {
		monthly: 1,
		quarterly: 3,
		semiannual: 6,
		annual: 12
	};
	const annualise = (s: { amountMinor: number; cadence: string }) =>
		s.amountMinor * (12 / MONTHS[s.cadence]);

	function dayLabel(iso: string): string {
		return new Intl.DateTimeFormat('en-GB', {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			timeZone: 'UTC'
		}).format(new Date(iso + 'T00:00:00Z'));
	}

	function daysUntil(iso: string, today: string): number {
		return Math.round(
			(Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000
		);
	}

	/** Only one row is editable at a time — two open forms is two sources of truth. */
	let editingId = $state<number | null>(null);
	let showForm = $state(false);
	let isTrial = $state(true);
</script>

<svelte:head><title>Bills &amp; subscriptions · Split</title></svelte:head>

<main class="shell">
	<ReviewNav />

	{#if !data.ready}
		<p class="empty">Split is not set up yet.</p>
	{:else}
		<header class="head">
			<h1>Bills &amp; subscriptions</h1>
			<!--
				The headline is the ANNUAL figure, not the monthly one. ₱285 a month
				is a number you wave away; ₱3,420 a year is a number you argue with.
				Same fact, and F12's snowball is built entirely out of the first
				framing.
			-->
			<p class="total">
				<span class="total-fig">{money(data.annualisedTotalMinor)}</span>
				<span class="total-unit">per year, if nothing changes</span>
			</p>
			{#if data.perPeriodMinor !== null && data.perPeriodMinor > 0}
				<!--
					The figure that answers "does this fit". Annual is what makes you
					argue with the cost; per-period is what the split actually has to
					reserve before a single peso reaches Spend.
				-->
				<p class="reserve">
					<strong>{money(data.perPeriodMinor)}</strong> reserved every
					{data.periodDays} days, before Spend
				</p>
			{/if}
		</header>

		{#if form?.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}

		<form method="POST" action="?/quickAdd" use:enhance class="quick">
			<input name="label" placeholder="Home wifi" required aria-label="What is it" />
			<input
				name="amount"
				inputmode="decimal"
				placeholder="750"
				required
				aria-label="Charge amount"
			/>
			<select name="cadence" aria-label="How often">
				{#each Object.entries(CADENCE_LABELS) as [key, label] (key)}
					<option value={key}>{label}</option>
				{/each}
			</select>
			<label class="free">
				<span>Free until</span>
				<input type="date" name="freeUntil" aria-label="Free trial ends on" />
			</label>
			<label class="ess">
				<input type="checkbox" name="isEssential" value="1" />
				Non-negotiable
			</label>
			<button type="submit">Add</button>
		</form>

		{#if data.essential.length > 0}
			<!--
				Essentials sit apart and are never culled. Asking "have you used your
				home internet lately" teaches you to skim the list, and the list only
				works if every row on it is a real question.
			-->
			<h2 class="sub">Non-negotiable</h2>
			<table class="grid">
				<thead>
					<tr>
						<th scope="col">Commitment</th>
						<th scope="col" class="num">Charge</th>
						<th scope="col" class="num">Per year</th>
						<th scope="col">Next</th>
						<th scope="col"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each data.essential as sub (sub.id)}
						<tr>
							<th scope="row">
								<span class="label">{sub.label}</span>
								{#if sub.vendor}<span class="vendor">{sub.vendor}</span>{/if}
							</th>
							<td class="num">
								{money(sub.amountMinor)}
								<span class="cadence">{CADENCE_LABELS[sub.cadence]}</span>
							</td>
							<td class="num strong">{money(annualise(sub))}</td>
							<td>{dayLabel(sub.nextChargeOn)}</td>
							<td>
								<div class="actions">
									<button
										class="mini"
										onclick={() => (editingId = editingId === sub.id ? null : sub.id)}
									>
										Edit
									</button>
									<form method="POST" action="?/cancel" use:enhance>
										<input type="hidden" name="id" value={sub.id} />
										<button type="submit" class="mini danger">Ended it</button>
									</form>
								</div>
							</td>
						</tr>
						{#if editingId === sub.id}
							<tr class="editor">
								<td colspan="5">
									<SubscriptionEdit
										{sub}
										{minorUnits}
										{symbol}
										onDone={() => (editingId = null)}
									/>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
			<h2 class="sub">Cancellable</h2>
		{/if}

		{#if data.rows.length === 0}
			<p class="empty">
				Nothing cancellable recorded. The dangerous subscription is always the
				one you forgot you had.
			</p>
		{:else}
			<table class="grid">
				<thead>
					<tr>
						<th scope="col">Subscription</th>
						<th scope="col" class="num">Charge</th>
						<th scope="col" class="num">Per year</th>
						<th scope="col">Next</th>
						<th scope="col">Deadline</th>
						<th scope="col">Last used</th>
						<th scope="col"><span class="sr-only">Decision</span></th>
					</tr>
				</thead>
				<tbody>
					{#each data.rows as row (row.sub.id)}
						{@const days = row.sub.cancelByOn ? daysUntil(row.sub.cancelByOn, data.today) : null}
						<tr>
							<th scope="row">
								<span class="label">{row.sub.label}</span>
								{#if row.sub.vendor}<span class="vendor">{row.sub.vendor}</span>{/if}
								{#if row.sub.trialEndsOn}<span class="tag trial">free trial</span>{/if}
							</th>
							<td class="num">
								{money(row.sub.amountMinor)}
								<span class="cadence">{CADENCE_LABELS[row.sub.cadence]}</span>
							</td>
							<td class="num strong">{money(row.annualisedMinor)}</td>
							<td>{dayLabel(row.sub.nextChargeOn)}</td>
							<td>
								{#if row.sub.cancelByOn && days !== null}
									{dayLabel(row.sub.cancelByOn)}
									<span class="cadence" class:soon={days <= row.sub.leadDays}>
										{days < 0 ? 'passed' : days === 0 ? 'today' : `in ${days} days`}
									</span>
								{:else}
									—
								{/if}
							</td>
							<td>
								{#if row.stale}
									<!-- Spec §267: used in the last 30 days? If no, cancel now. -->
									<span class="tag stale" title="Not used in the last 30 days">
										{row.staleDays === null ? 'never' : `${row.staleDays}d ago`}
									</span>
								{:else}
									{row.staleDays}d ago
								{/if}
							</td>
							<td>
								<!--
									The flex row is a div, not the cell itself: `display: flex`
									on a <td> drops it out of the table layout and collapses
									the whole grid's column widths.
								-->
								<div class="actions">
								<button
									class="mini"
									onclick={() => (editingId = editingId === row.sub.id ? null : row.sub.id)}
								>
									Edit
								</button>
								<form method="POST" action="?/used" use:enhance>
									<input type="hidden" name="id" value={row.sub.id} />
									<button type="submit" class="mini">Used it</button>
								</form>
								<form method="POST" action="?/keep" use:enhance>
									<input type="hidden" name="id" value={row.sub.id} />
									<button type="submit" class="mini">Keep</button>
								</form>
								<form method="POST" action="?/cancel" use:enhance>
									<input type="hidden" name="id" value={row.sub.id} />
									<button type="submit" class="mini danger">Cancelled it</button>
								</form>
								</div>
							</td>
						</tr>
						{#if editingId === row.sub.id}
							<tr class="editor">
								<td colspan="7">
									<SubscriptionEdit
										sub={row.sub}
										{minorUnits}
										{symbol}
										onDone={() => (editingId = null)}
									/>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>

			<p class="rule">
				<strong>If a renewal notice arrives, decide right then — keep or cancel — and
				never "decide later."</strong>
				<span>Spec §374. "Later" is how ₱285 a month becomes permanent.</span>
			</p>
		{/if}

		{#if data.cancelled.length > 0}
			<!--
				"Ended it" is one click, and so is getting it wrong. Nothing is
				deleted, so undoing costs one click too.
			-->
			<h2 class="sub">Ended</h2>
			<ul class="ended">
				{#each data.cancelled as sub (sub.id)}
					<li>
						<span>{sub.label}</span>
						<span class="cadence">{money(sub.amountMinor)} · {CADENCE_LABELS[sub.cadence]}</span>
						<form method="POST" action="?/restore" use:enhance>
							<input type="hidden" name="id" value={sub.id} />
							<button type="submit" class="mini">Restore</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}

		<button class="disclose" onclick={() => (showForm = !showForm)} aria-expanded={showForm}>
			{showForm ? '− Close' : '+ Add a subscription'}
		</button>

		{#if showForm}
			<form method="POST" action="?/add" use:enhance class="add">
				<div class="field wide">
					<label for="label">What is it</label>
					<input id="label" name="label" required placeholder="Google AI Plus (400 GB)" />
				</div>
				<div class="field">
					<label for="vendor">Billed by</label>
					<input id="vendor" name="vendor" placeholder="Google One" />
				</div>
				<div class="field">
					<label for="amount">Charge ({symbol})</label>
					<input id="amount" name="amount" required inputmode="decimal" placeholder="285.00" />
				</div>
				<div class="field">
					<label for="tax">of which tax</label>
					<input id="tax" name="tax" inputmode="decimal" placeholder="30.54" />
				</div>
				<div class="field">
					<label for="cadence">How often</label>
					<select id="cadence" name="cadence">
						{#each Object.entries(CADENCE_LABELS) as [key, label] (key)}
							<option value={key}>{label}</option>
						{/each}
					</select>
				</div>
				<div class="field">
					<label for="nextChargeOn">First / next charge</label>
					<input id="nextChargeOn" name="nextChargeOn" type="date" required />
				</div>

				<label class="check">
					<input type="checkbox" name="isTrial" value="1" bind:checked={isTrial} />
					It's a free trial right now
				</label>
				<label class="check">
					<input type="checkbox" name="isEssential" value="1" />
					Non-negotiable — never ask me to cancel it
				</label>

				<div class="field">
					<label for="cancelByOn">Cancel by</label>
					<input id="cancelByOn" name="cancelByOn" type="date" />
					<span class="hint">Blank = the charge date.</span>
				</div>
				<div class="field">
					<label for="leadDays">Warn me</label>
					<select id="leadDays" name="leadDays">
						<option value="30" selected>30 days ahead</option>
						<option value="60">60 days ahead</option>
						<option value="14">14 days ahead</option>
						<option value="7">7 days ahead</option>
					</select>
					<span class="hint">A second warning always fires at 7 days.</span>
				</div>
				<div class="field">
					<label for="category">Category</label>
					<select id="category" name="category">
						<option value="">—</option>
						{#each CATEGORIES as c (c.key)}
							<option value={c.key}>{c.label}</option>
						{/each}
					</select>
					<span class="hint">For the review only. Bills never touch Spend.</span>
				</div>
				<div class="field wide">
					<label for="note">Note</label>
					<input id="note" name="note" placeholder="Cancel in Play → Subscriptions" />
				</div>

				<button type="submit" class="save">Add it</button>
			</form>
		{/if}
	{/if}
</main>

<style>
	.shell {
		max-width: 68rem;
		margin: 0 auto;
		padding: 1.5rem 1.25rem 4rem;
	}

	.head {
		margin: 1.5rem 0 1.25rem;
	}

	h1 {
		margin: 0;
		font-size: 1.125rem;
		font-weight: 600;
		letter-spacing: 0.01em;
	}

	.total {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.5rem 0 0;
	}

	.total-fig {
		font-size: clamp(2rem, 6vw, 3rem);
		font-weight: 300;
		letter-spacing: -0.02em;
		font-variant-numeric: tabular-nums;
	}

	.total-unit {
		color: var(--ink-muted);
		font-size: 0.875rem;
	}

	.editor > td {
		padding: 0;
		border-bottom: 1px solid var(--hairline);
	}

	.ended {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.ended li {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem;
		border-bottom: 1px solid var(--hairline);
		color: var(--ink-muted);
		font-size: 0.875rem;
	}

	.ended li > span:first-child {
		text-decoration: line-through;
	}

	.ended form {
		margin-left: auto;
	}

	.reserve {
		margin: 0.375rem 0 0;
		color: var(--ink-secondary);
		font-size: 0.9375rem;
	}

	.reserve strong {
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	.quick {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 1.5rem;
		padding: 0.75rem;
		border: 1px dashed var(--hairline-strong);
		border-radius: 0.5rem;
	}

	.quick input[name='label'] {
		flex: 1 1 12rem;
	}

	.quick input[name='amount'] {
		width: 6rem;
		text-align: right;
	}

	.quick button {
		padding: 0.45rem 1rem;
		background: none;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.25rem;
		color: var(--ink);
		font: inherit;
		font-size: 0.875rem;
		cursor: pointer;
	}

	.free {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--ink-muted);
		font-size: 0.8125rem;
		white-space: nowrap;
	}

	.ess {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--ink-secondary);
		font-size: 0.8125rem;
		white-space: nowrap;
	}

	.ess input {
		width: auto;
	}

	.sub {
		margin: 1.75rem 0 0.5rem;
		color: var(--ink-muted);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 400;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.grid {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	.grid th,
	.grid td {
		padding: 0.625rem 0.5rem;
		text-align: left;
		border-bottom: 1px solid var(--hairline);
		vertical-align: top;
	}

	.grid thead th {
		color: var(--ink-muted);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 400;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.grid tbody th {
		font-weight: 500;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.strong {
		color: var(--ink);
		font-weight: 500;
	}

	.label {
		display: block;
	}

	.vendor,
	.cadence {
		display: block;
		color: var(--ink-muted);
		font-size: 0.75rem;
	}

	.cadence.soon {
		color: var(--status-warning);
	}

	.tag {
		display: inline-block;
		margin-top: 0.25rem;
		padding: 0.05rem 0.4rem;
		border-radius: 0.25rem;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.tag.trial {
		color: var(--status-warning);
		border: 1px solid var(--status-warning);
	}

	.tag.stale {
		color: var(--status-critical);
		border: 1px solid var(--status-critical);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}

	.mini {
		padding: 0.25rem 0.5rem;
		background: none;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.25rem;
		color: var(--ink-secondary);
		font: inherit;
		font-size: 0.75rem;
		cursor: pointer;
	}

	.mini:hover {
		color: var(--ink);
	}

	.mini.danger:hover {
		color: var(--status-critical);
		border-color: var(--status-critical);
	}

	.rule {
		margin: 1.25rem 0 0;
		padding: 0.875rem 1rem;
		border-left: 2px solid var(--accent);
		background: var(--surface);
		font-size: 0.875rem;
	}

	.rule strong {
		display: block;
		font-weight: 500;
	}

	.rule span {
		display: block;
		margin-top: 0.25rem;
		color: var(--ink-muted);
		font-size: 0.8125rem;
	}

	.disclose {
		margin-top: 1.5rem;
		padding: 0.5rem 0.875rem;
		background: none;
		border: 1px solid var(--hairline-strong);
		border-radius: 999px;
		color: var(--ink-secondary);
		font: inherit;
		font-size: 0.8125rem;
		cursor: pointer;
	}

	.add {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.875rem;
		margin-top: 1rem;
		padding: 1.25rem;
		border: 1px solid var(--hairline);
		border-radius: 0.5rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.field.wide {
		grid-column: 1 / -1;
	}

	label {
		color: var(--ink-muted);
		font-size: 0.75rem;
	}

	input,
	select {
		padding: 0.45rem 0.5rem;
		background: var(--surface);
		border: 1px solid var(--hairline-strong);
		border-radius: 0.25rem;
		color: var(--ink);
		font: inherit;
		font-size: 0.875rem;
	}

	.hint {
		color: var(--ink-muted);
		font-size: 0.6875rem;
	}

	.check {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--ink-secondary);
		font-size: 0.875rem;
	}

	.check input {
		width: auto;
	}

	.save {
		grid-column: 1 / -1;
		padding: 0.6rem;
		background: none;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.375rem;
		color: var(--ink);
		font: inherit;
		cursor: pointer;
	}

	.empty,
	.error {
		color: var(--ink-muted);
		font-size: 0.9375rem;
	}

	.error {
		color: var(--status-critical);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
