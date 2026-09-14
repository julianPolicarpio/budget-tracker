<script lang="ts">
	import ReviewNav from '$lib/components/ReviewNav.svelte';
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
	const major = (m: number) => m / 10 ** minorUnits;

	function dayLabel(iso: string | null): string {
		if (!iso) return 'never';
		return new Intl.DateTimeFormat('en-GB', {
			day: 'numeric',
			month: 'short',
			timeZone: 'UTC'
		}).format(new Date(iso.slice(0, 10) + 'T00:00:00Z'));
	}

	// The phase meter reads off the exit condition's own arithmetic when it has
	// one, so the bar and the sentence beneath it can never disagree.
	const progress = $derived.by(() => {
		if (!data.ready) return null;
		const m = /([\d.]+)\s+of\s+([\d.]+)/.exec(data.phase.verdict.detail);
		if (!m) return null;
		return Math.min(100, (Number(m[1]) / Number(m[2])) * 100);
	});

	// Bound so the IOU fields can appear the moment a savings account is picked.
	// Seeded in an effect rather than at declaration: reading `data` there would
	// capture only its initial value.
	let transferFrom = $state('');
	$effect(() => {
		if (!transferFrom && data.ready) transferFrom = String(data.accounts[0]?.id ?? '');
	});
	const needsIou = $derived(
		data.ready &&
			['irregulars', 'buffer', 'grow'].includes(
				data.accounts.find((a) => String(a.id) === transferFrom)?.kind ?? ''
			)
	);

	let showGoal = $state(false);
</script>

<svelte:head><title>Accounts · Split</title></svelte:head>

{#if !data.ready}
	<main class="sheet">
		<p class="eyebrow">Not set up</p>
		<p>Run <code>npm run db:init</code> first.</p>
	</main>
{:else}
	<main class="sheet">
		<header class="masthead">
			<div>
				<p class="eyebrow">Accounts</p>
				<h1>Where the money is, and what it is waiting on</h1>
			</div>
		</header>

		<ReviewNav />

		{#if form?.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}

		<!--
			The stage banner. A meter, not a pie, not a donut.

			The stage NUMBER is deliberately not shown (§5.12). It gates features
			internally and means nothing to the person reading it; the name —
			"Six weeks", "Kill expensive debt" — already says what you are working
			on, which is the only part that was ever useful.
		-->
		<section class="card phase">
			<div class="phase-head">
				<div>
					<p class="eyebrow">{data.phase.current.name}</p>
					<p class="phase-exit">{data.phase.current.exit}</p>
				</div>
				<span class="verdict verdict-{data.phase.verdict.state}">
					<span aria-hidden="true"
						>{data.phase.verdict.state === 'cleared'
							? '✓'
							: data.phase.verdict.state === 'not_yet'
								? '·'
								: '?'}</span
					>
					{data.phase.verdict.state === 'cleared'
						? 'cleared'
						: data.phase.verdict.state === 'not_yet'
							? 'not yet'
							: 'cannot tell'}
				</span>
			</div>

			{#if progress !== null}
				<div class="meter" role="img" aria-label={data.phase.verdict.detail}>
					<span class="meter-fill" style="--w: {progress}%"></span>
				</div>
			{/if}
			<p class="muted">{data.phase.verdict.detail}</p>
			<p class="muted">{data.phase.current.funds}</p>

			{#if data.phase.proposal}
				<!-- The engine proposes; it never advances on its own. -->
				<div class="proposal">
					<p>
						<strong
							>Ready for {data.phases[data.phase.proposal.toPhase].name}?</strong
						>
					</p>
					<p class="muted">{data.phase.proposal.rationale}</p>
					<div class="row">
						<form method="POST" action="?/acceptPhase" use:enhance>
							<input type="hidden" name="id" value={data.phase.proposal.id} />
							<button class="primary" type="submit">Move up</button>
						</form>
						<form method="POST" action="?/declinePhase" use:enhance>
							<input type="hidden" name="id" value={data.phase.proposal.id} />
							<button class="ghost" type="submit">Not yet</button>
						</form>
					</div>
				</div>
			{/if}

			<details class="mover">
				<summary>Move phase by hand</summary>
				<p class="muted">
					Slipping back a phase is a normal event and this app will not treat it as failure — the
					recovery instinct after a setback is itself the documented failure mode.
				</p>
				<form method="POST" action="?/setPhase" use:enhance class="row">
					<label class="field">
						<span class="sr-only">Phase</span>
						<select name="phase" value={String(data.phase.current.n)}>
							{#each data.phases as p (p.n)}
								<option value={String(p.n)}>{p.n} — {p.name}</option>
							{/each}
						</select>
					</label>
					<button class="ghost" type="submit">Set phase</button>
				</form>
			</details>
		</section>

		<!-- 3.2 The five accounts. A table, because five rows of five attributes is a table. -->
		<section class="block">
			<p class="eyebrow">The accounts</p>
			<div class="scroll">
				<table>
					<thead>
						<tr>
							<th scope="col">Account</th>
							<th scope="col">Institution</th>
							<th scope="col">Balance</th>
							<th scope="col">As of</th>
							<th scope="col">Card</th>
							<th scope="col"><span class="sr-only">Assert</span></th>
						</tr>
					</thead>
					<tbody>
						{#each data.accounts as a (a.id)}
							<tr>
								<th scope="row">
									{a.name}
									{#if a.isCommitted}
										<span
											class="tag"
											title="Deliberately inconvenient — the friction is the feature"
											>committed</span
										>
									{/if}
								</th>
								<td class="left muted">{a.institution ?? '—'}</td>
								<td>{money(a.balanceMinor)}</td>
								<td class="muted">{dayLabel(a.balanceAsOf)}</td>
								<td>{a.hasCard ? 'debit' : 'none'}</td>
								<td>
									<form method="POST" action="?/assertBalance" use:enhance class="inline">
										<input type="hidden" name="accountId" value={a.id} />
										<label class="field-input compact">
											<span class="field-sym">{symbol}</span>
											<input
												name="balance"
												type="text"
												inputmode="decimal"
												placeholder={String(major(a.balanceMinor))}
												aria-label="Assert {a.name} balance"
											/>
										</label>
										<button class="ghost small" type="submit">Set</button>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="muted">
				Balances are asserted, not derived. Deriving them from logged flows sounds cleaner and
				drifts within a month, because you will not log every bank fee — and typing the number
				weekly is itself part of the intervention.
			</p>
		</section>

		<!-- 3.3 The flow, drawn once so the mental model sticks. -->
		<section class="block">
			<p class="eyebrow">The split</p>
			<pre class="flow" aria-label="Income splits into Bills, Spending, Big bills, Emergency fund and Savings">
INCOME ──┬──▶ BILLS            auto-debits only, never thought about
         ├──▶ SPENDING         the one account you look at · debit card
         ├──▶ BIG BILLS        1/12 of every annual cost, every month
         ├──▶ EMERGENCY FUND   different bank · no card · the friction is the point
         └──▶ SAVINGS          only once the emergency fund is done</pre>
		</section>

		<!-- 3.4 Transfer checklist -->
		<section class="block">
			<p class="eyebrow">Moves to make</p>
			{#if !data.period}
				<p class="empty">No open period, so there is nothing to move yet.</p>
			{:else if data.checklist.length === 0}
				<p class="empty">Nothing outstanding for this period.</p>
			{:else}
				<ul class="checklist">
					{#each data.checklist as item (item.id)}
						<li class:done={item.executedAt !== null}>
							<span>
								Move <strong>{money(item.amountMinor)}</strong> from Income to {item.accountName}
							</span>
							{#if item.executedAt}
								<span class="status good"><span aria-hidden="true">✓</span> done</span>
							{:else}
								<form method="POST" action="?/executeMove" use:enhance class="inline">
									<input type="hidden" name="id" value={item.id} />
									<button class="ghost small" type="submit">Mark done</button>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
				<p class="muted">
					Only two of the five are known here. Bills, Emergency fund and Savings need the income split, which
					needs income sources — a subsystem Spec §13's roadmap never assigns to a phase.
				</p>
			{/if}
		</section>

		<!-- 3.5 Open IOUs. Never summarised into a count. -->
		<section class="block">
			<p class="eyebrow">Open IOUs</p>
			{#if data.ious.length === 0}
				<p class="empty">
					None open. Every move out of Big bills, Emergency fund or Savings writes one — date, amount, why,
					and when it comes back.
				</p>
			{:else}
				<ul class="ious">
					{#each data.ious as iou (iou.id)}
						<li class:overdue={iou.overdue}>
							<div class="iou-head">
								<span class="iou-amount">{money(iou.amountMinor)}</span>
								<span class="muted">
									{dayLabel(iou.movedOn)} · {iou.fromName} → {iou.toName}
									{#if iou.repayBy}
										· back by {dayLabel(iou.repayBy)}
									{/if}
									{#if iou.overdue}
										<span class="status warn"><span aria-hidden="true">!</span> overdue</span>
									{/if}
								</span>
							</div>
							<p class="iou-reason">{iou.reason}</p>
							<form method="POST" action="?/repayIou" use:enhance>
								<input type="hidden" name="id" value={iou.id} />
								<button class="ghost small" type="submit">Repaid</button>
							</form>
						</li>
					{/each}
				</ul>
				<p class="muted">
					Reading these one by one is the mechanism. Most people find that four in a row does more
					than any rule prohibiting the transfer would have — which is why this is a list and not a
					count.
				</p>
			{/if}
		</section>

		<!-- Transfer form -->
		<section class="block">
			<p class="eyebrow">Record a transfer</p>
			<form method="POST" action="?/transfer" use:enhance class="card">
				<div class="grid">
					<label class="field">
						<span class="field-label">From</span>
						<select name="fromAccountId" bind:value={transferFrom}>
							{#each data.accounts as a (a.id)}<option value={String(a.id)}>{a.name}</option>{/each}
						</select>
					</label>
					<label class="field">
						<span class="field-label">To</span>
						<select name="toAccountId">
							{#each data.accounts as a (a.id)}<option value={String(a.id)}>{a.name}</option>{/each}
						</select>
					</label>
					<label class="field">
						<span class="field-label">Amount</span>
						<span class="field-input">
							<span class="field-sym">{symbol}</span>
							<input name="amount" type="text" inputmode="decimal" required />
						</span>
					</label>
					<label class="field">
						<span class="field-label">Moved on</span>
						<span class="field-input"><input name="movedOn" type="date" value={data.today} /></span>
					</label>
				</div>

				{#if needsIou}
					<div class="iou-required">
						<p class="eyebrow">IOU required</p>
						<p class="muted">
							No approval, no guilt — just the note. It turns an invisible leak into a countable
							event, and you will read it back at the quarterly audit.
						</p>
						<div class="grid">
							<label class="field">
								<span class="field-label">Why</span>
								<span class="field-input"><input name="iouReason" type="text" required /></span>
							</label>
							<label class="field">
								<span class="field-label">Back by</span>
								<span class="field-input"><input name="iouRepayBy" type="date" /></span>
							</label>
						</div>
					</div>
				{/if}

				<button class="primary" type="submit">Record transfer</button>
			</form>
		</section>

		<!-- 3.6 Goals — fine partitioning belongs here and only here. -->
		<section class="block">
			<div class="block-head">
				<p class="eyebrow">Goals</p>
				<button class="ghost small" type="button" onclick={() => (showGoal = !showGoal)}>
					{showGoal ? 'Cancel' : 'Add a goal'}
				</button>
			</div>

			{#if data.goals.length === 0}
				<p class="empty">
					No goals yet. Partitioning savings into named sub-goals was worth roughly a third more
					saved — and the name is doing the work, so "Rent if I lose my job" beats "Emergency fund" and
					"Japan, March" beats "Travel".
				</p>
			{:else}
				<ul class="goals">
					{#each data.goals as g (g.id)}
						{@const pct = g.targetMinor
							? Math.min(100, (g.savedMinor / g.targetMinor) * 100)
							: null}
						<li>
							<div class="goal-head">
								<strong>{g.label}</strong>
								<span class="muted">
									{money(g.savedMinor)}{g.targetMinor ? ` of ${money(g.targetMinor)}` : ''}
									{#if g.targetDate}· by {dayLabel(g.targetDate)}{/if}
								</span>
							</div>
							{#if pct !== null}
								<div class="meter" role="img" aria-label="{g.label}: {Math.round(pct)} percent">
									<span class="meter-fill" style="--w: {pct}%"></span>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			{#if showGoal}
				<form method="POST" action="?/upsertGoal" use:enhance class="card">
					<div class="grid">
						<label class="field">
							<span class="field-label">Label — be concrete</span>
							<span class="field-input">
								<input name="label" type="text" placeholder="Rent if I lose my job" required />
							</span>
						</label>
						<label class="field">
							<span class="field-label">Account</span>
							<select name="accountId">
								{#each data.accounts.filter( (a) => ['buffer', 'grow', 'irregulars'].includes(a.kind) ) as a (a.id)}
									<option value={String(a.id)}>{a.name}</option>
								{/each}
							</select>
						</label>
						<label class="field">
							<span class="field-label">Target</span>
							<span class="field-input">
								<span class="field-sym">{symbol}</span>
								<input name="target" type="text" inputmode="decimal" />
							</span>
						</label>
						<label class="field">
							<span class="field-label">Saved so far</span>
							<span class="field-input">
								<span class="field-sym">{symbol}</span>
								<input name="saved" type="text" inputmode="decimal" />
							</span>
						</label>
						<label class="field">
							<span class="field-label">By when</span>
							<span class="field-input"><input name="targetDate" type="date" /></span>
						</label>
					</div>
					<button class="primary" type="submit">Save goal</button>
				</form>
			{/if}
		</section>
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
	td:first-child,
	.left {
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

	.tag,
	.status {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-muted);
		margin-left: 0.4rem;
	}

	.status.good {
		color: var(--status-good);
	}

	.status.warn {
		color: var(--status-warning);
	}

	/* ── Phase ────────────────────────────────────────────────────────── */
	.phase {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.phase-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.phase-exit {
		margin: 0.25rem 0 0;
		font-size: 1.0625rem;
	}

	.verdict {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.verdict-cleared {
		color: var(--status-good);
	}
	.verdict-not_yet {
		color: var(--ink-muted);
	}
	.verdict-unevaluable {
		color: var(--status-warning);
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

	.proposal {
		border-top: 1px solid var(--hairline);
		padding-top: 0.875rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.proposal p {
		margin: 0;
	}

	.mover summary {
		cursor: pointer;
		font-size: 0.8125rem;
		color: var(--ink-muted);
	}

	.mover .row {
		margin-top: 0.75rem;
	}

	/* ── Flow ─────────────────────────────────────────────────────────── */
	.flow {
		margin: 0;
		padding: 1rem;
		overflow-x: auto;
		background: var(--surface);
		border: 1px solid var(--hairline);
		border-radius: 0.625rem;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		line-height: 1.7;
		color: var(--ink-secondary);
	}

	/* ── Checklist, IOUs, goals ───────────────────────────────────────── */
	.checklist,
	.ious,
	.goals {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.checklist li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.625rem 0.875rem;
		border: 1px solid var(--hairline);
		border-radius: 0.5rem;
	}

	.checklist li.done {
		color: var(--ink-muted);
		border-style: dashed;
	}

	.ious li {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.875rem;
		border: 1px solid var(--hairline);
		border-left-width: 3px;
		border-radius: 0.5rem;
	}

	.ious li.overdue {
		border-left-color: var(--status-warning);
	}

	.iou-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.75rem;
	}

	.iou-amount {
		font-family: var(--font-mono);
		font-size: 1.0625rem;
		font-variant-numeric: tabular-nums;
	}

	.iou-reason {
		margin: 0;
		font-size: 0.9375rem;
		color: var(--ink-secondary);
	}

	.goals li {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.goal-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}

	/* ── Forms ────────────────────────────────────────────────────────── */
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
		max-width: 7.5rem;
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

	.iou-required {
		border-left: 3px solid var(--status-warning);
		padding-left: 0.875rem;
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}
</style>
