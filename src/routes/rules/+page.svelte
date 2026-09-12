<script lang="ts">
	import ReviewNav from '$lib/components/ReviewNav.svelte';
	import { enhance } from '$app/forms';
	import { formatMoney } from '$lib/money';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const minorUnits = $derived(data.ready ? data.currency.minorUnits : 2);
	const symbol = $derived(data.ready ? data.currency.symbol : '');

	function money(m: number | null | undefined): string {
		if (m === null || m === undefined) return '';
		return formatMoney(m, { minorUnits, symbol }).replace(/\.00$/, '');
	}

	function ripensIn(iso: string): string {
		const hours = Math.ceil((Date.parse(iso) - Date.now()) / 3_600_000);
		if (hours <= 0) return 'ready now';
		if (hours < 24) return `${hours}h left`;
		return `${Math.ceil(hours / 24)}d left`;
	}

	let showNew = $state(false);
</script>

<svelte:head><title>Rules · Split</title></svelte:head>

{#if !data.ready}
	<main class="sheet"><p class="eyebrow">Not set up</p></main>
{:else}
	<main class="sheet">
		<header class="masthead">
			<div>
				<p class="eyebrow">If-then plans &amp; the 72-hour list</p>
				<h1>The rules that replace judgement</h1>
			</div>
		</header>

		<ReviewNav />

		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

		<p class="lede">
			Implementation intentions run at d = 0.65 across 94 tests — the largest effect in this whole
			system, larger than monitoring and larger than financial education. The format is what carries
			it: the cue has to be an event you will actually notice, and the action has to start within
			seconds of it.
		</p>

		<!-- ── The 72-hour list ─────────────────────────────────────────── -->
		<section class="block">
			<div class="block-head">
				<p class="eyebrow">The 72-hour list</p>
				{#if data.dropRateBp !== null}
					<!-- Seeing this number IS the argument for the rule. -->
					<span class="stat">
						<strong>{Math.round(data.dropRateBp / 100)}%</strong> dropped
					</span>
				{/if}
			</div>

			{#if data.ripe.length > 0}
				<ul class="items ripe-list">
					{#each data.ripe as w (w.id)}
						<li>
							<span>
								<strong>{w.label}</strong>
								{#if w.amountMinor}<span class="muted"> · {money(w.amountMinor)}</span>{/if}
								<span class="tag ready">72 hours up</span>
							</span>
							<span class="acts">
								<form method="POST" action="?/resolve" use:enhance>
									<input type="hidden" name="id" value={w.id} />
									<button class="ghost small" type="submit" name="outcome" value="bought">
										Bought it
									</button>
								</form>
								<form method="POST" action="?/resolve" use:enhance>
									<input type="hidden" name="id" value={w.id} />
									<button class="ghost small" type="submit" name="outcome" value="dropped">
										Dropped it
									</button>
								</form>
							</span>
						</li>
					{/each}
				</ul>
			{/if}

			{#if data.waiting.length > 0}
				<ul class="items">
					{#each data.waiting as w (w.id)}
						<li class="waiting">
							<span>
								{w.label}
								{#if w.amountMinor}<span class="muted"> · {money(w.amountMinor)}</span>{/if}
							</span>
							<span class="muted">{ripensIn(w.ripeAt)}</span>
						</li>
					{/each}
				</ul>
			{/if}

			{#if data.ripe.length === 0 && data.waiting.length === 0}
				<p class="empty">
					Nothing on the list. Anything unplanned and over your daily allowance goes here for 72
					hours first — most items die on the list, and the ones that survive you buy guilt-free.
				</p>
			{/if}

			<form method="POST" action="?/addWait" use:enhance class="add-row">
				<label class="field">
					<span class="sr-only">What do you want?</span>
					<span class="field-input">
						<input name="label" type="text" placeholder="Mechanical keyboard" required />
					</span>
				</label>
				<label class="field">
					<span class="sr-only">Roughly how much?</span>
					<span class="field-input">
						<span class="field-sym">{symbol}</span>
						<input name="amount" type="text" inputmode="decimal" placeholder="3200" />
					</span>
				</label>
				<button class="ghost" type="submit">Park it for 72 hours</button>
			</form>

			{#if data.resolved.length > 0}
				<details>
					<summary>Resolved ({data.resolved.length})</summary>
					<ul class="items">
						{#each data.resolved as w (w.id)}
							<li class="resolved">
								<span>{w.label}</span>
								<span class="tag">{w.outcome}</span>
							</li>
						{/each}
					</ul>
				</details>
			{/if}
		</section>

		<!-- ── If-then plans ────────────────────────────────────────────── -->
		{#each data.categories as cat (cat.key)}
			{#if cat.rules.length > 0}
				<section class="block">
					<p class="eyebrow">{cat.label}</p>
					<ul class="rules">
						{#each cat.rules as r (r.id)}
							<li class:off={!r.active}>
								<p class="plan">
									<span class="ifthen">If</span>
									{r.cue},
									<span class="ifthen">then</span>
									{r.action}.
								</p>
								<div class="rule-foot">
									<span class="muted">
										{#if r.firedCount === 0}
											never fired
										{:else}
											fired {r.firedCount}
											{r.firedCount === 1 ? 'time' : 'times'}
										{/if}
									</span>
									<span class="acts">
										<form method="POST" action="?/fired" use:enhance>
											<input type="hidden" name="id" value={r.id} />
											<button class="ghost small" type="submit">It fired</button>
										</form>
										<form method="POST" action="?/toggle" use:enhance>
											<input type="hidden" name="id" value={r.id} />
											<input type="hidden" name="active" value={r.active ? '0' : '1'} />
											<button class="ghost small" type="submit">
												{r.active ? 'Retire' : 'Restore'}
											</button>
										</form>
									</span>
								</div>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		{/each}

		<section class="block">
			<button class="ghost" type="button" onclick={() => (showNew = !showNew)}>
				{showNew ? 'Cancel' : 'Write your own'}
			</button>
			{#if showNew}
				<form method="POST" action="?/upsert" use:enhance class="card">
					<label class="field">
						<span class="field-label">If — a cue you will actually notice</span>
						<span class="field-input">
							<input
								name="cue"
								type="text"
								placeholder="I open a food delivery app after 9pm"
								required
							/>
						</span>
					</label>
					<label class="field">
						<span class="field-label">Then — specific, starting immediately</span>
						<span class="field-input">
							<input
								name="action"
								type="text"
								placeholder="I close it and drink a glass of water first"
								required
							/>
						</span>
					</label>
					<label class="field">
						<span class="field-label">Category</span>
						<select name="category">
							{#each data.categories as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
						</select>
					</label>
					<p class="muted">
						A vague cue is why a rule never fires. "If I am spending too much" is not detectable;
						"if I open a delivery app after 9pm" is.
					</p>
					<button class="primary" type="submit">Add the plan</button>
				</form>
			{/if}
		</section>
	</main>
{/if}

<style>
	.muted {
		color: var(--ink-muted);
		font-size: 0.8125rem;
	}

	.block {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.block-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}

	.stat {
		font-size: 0.875rem;
		color: var(--ink-muted);
	}

	.stat strong {
		font-size: 1.25rem;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}

	.items,
	.rules {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.items li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.75rem 0.875rem;
		border: 1px solid var(--hairline);
		border-radius: 0.5rem;
	}

	.ripe-list li {
		border-left: 3px solid var(--accent);
	}

	.waiting,
	.resolved {
		color: var(--ink-secondary);
		border-style: dashed;
	}

	.tag {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-muted);
		margin-left: 0.4rem;
	}

	.tag.ready {
		color: var(--accent);
	}

	.acts {
		display: flex;
		gap: 0.5rem;
	}

	.small {
		min-height: 2.25rem;
		padding: 0 0.75rem;
		font-size: 0.8125rem;
	}

	.add-row {
		flex-direction: row !important;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem;
	}

	.add-row .field {
		flex: 1 1 10rem;
	}

	.rules li {
		padding: 0.875rem;
		border: 1px solid var(--hairline);
		border-radius: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.rules li.off {
		opacity: 0.5;
	}

	.plan {
		margin: 0;
		font-size: 0.9375rem;
		line-height: 1.55;
		color: var(--ink-secondary);
	}

	/* The if/then scaffold is the mechanism, so it is typographically visible. */
	.ifthen {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-muted);
	}

	.rule-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	details summary {
		cursor: pointer;
		font-size: 0.875rem;
		color: var(--ink-muted);
		margin-bottom: 0.5rem;
	}
</style>
