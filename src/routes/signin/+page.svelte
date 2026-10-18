<script lang="ts">
	/**
	 * The landing page, and the sign-in page, and the page every signed-out
	 * browser lands on. One route, because they are the same moment.
	 *
	 * This is a REVIEW-class screen, not a DAILY one (§8.0b): it is read once,
	 * carefully, by someone deciding whether any of this is worth their time.
	 * Density is correct here in a way it never is on Today.
	 *
	 * The order is deliberate. The thesis first, because "a budgeting app" is
	 * a thing nobody needs another of and "an app that refuses to show you your
	 * balance" is a thing worth thirty more seconds. The demo second, because
	 * the claim is only a claim until you are inside it. Sign-in last, because
	 * almost nobody arriving here should be asked to commit to anything.
	 */
	import { onMount } from 'svelte';
	import { clearAll } from '$lib/outbox';

	let { data } = $props();

	/**
	 * "Cleared on sign-out" (Spec §6, task A5). This screen is the one place a
	 * signed-out browser always lands — an explicit sign-out, an expired
	 * session, or a first visit — so wiping the offline outbox here,
	 * unconditionally, is what stops a queued entry replaying into a different
	 * tenant after an account switch on a shared device. That is the offline
	 * form of the leak §3 exists to prevent. Idempotent against an empty store,
	 * so a first-time visitor pays nothing for it.
	 */
	onMount(() => {
		clearAll();
	});

	/**
	 * Each rule, and the reason it is not an oversight. The reason is the whole
	 * point: without it this reads as a list of missing features.
	 */
	const RULES = [
		{
			rule: 'The daily screen never shows a balance',
			why: 'When people see a big balance, they usually spend more. The code for that screen has no place for a balance, so adding one breaks the build instead of quietly passing review.'
		},
		{
			rule: 'Your daily number is a range, not one amount',
			why: 'If the app says “₱103 left,” most people read it as permission to spend ₱103, and then a bit more. A range has no exact limit to spend up to.'
		},
		{
			rule: 'You type every purchase yourself',
			why: 'There is no bank sync and no card sync, and there never will be. Typing each purchase is the point, not a hassle. Automatic tracking takes away the one moment where you actually notice what you spent.'
		},
		{
			rule: 'Eight categories, but no budget for any of them',
			why: 'Dividing a spending budget into category budgets is the one method that was shown to make people spend more. Categories are only used for the weekly review.'
		},
		{
			rule: 'Spending less today does not raise tomorrow’s number',
			why: 'Your daily number is set once when the week starts, and it stays the same. Recomputing “what is left ÷ days remaining” leads to overspending at the end of the week, so the app is built so it cannot do that computation.'
		},
		{
			rule: 'A 15% cushion is set aside and hidden',
			why: 'Most people cannot keep a buffer in their head, so the app keeps it for you. The cushion builds up quietly and goes to your savings when the week ends.'
		},
		{
			rule: 'Bills never touch your spending money',
			why: 'Rent, subscriptions and yearly payments are set aside before your daily number is computed. A payment you cannot skip should not compete with your coffee money.'
		}
	];
</script>

<svelte:head>
	<title>Split: a budgeting app that hides your balance</title>
	<meta
		name="description"
		content="Split leaves out the features most budgeting apps compete on, because those features make people spend more."
	/>
</svelte:head>

<main>
	<header>
		<p class="eyebrow">Split</p>
		<h1>A budgeting app that will not show you your balance.</h1>
		<p class="lede">
			Split is made to be worse at the things other budgeting apps compete on: live balances,
			detailed categories, and automatic import. Each of these has been shown to make people spend
			more. So the app follows seven rules, and every one of them is on purpose.
		</p>

		<div class="actions">
			<!--
				POST, not a link. A GET would let any prefetch, link preview or
				crawler mint a tenant, and a bot sweeping this page would seed the
				database a hundred times before a person read a word.
			-->
			<form method="POST" action="/demo">
				<button class="primary" type="submit">Try the demo</button>
			</form>
			{#if !data.demoOnly}
				<a class="secondary" href="/auth/google">Sign in with Google</a>
			{/if}
		</div>
		{#if data.notice === 'busy'}
			<p class="note" role="status">The demo is busy. Try again in a few minutes.</p>
		{:else if data.notice === 'too-many'}
			<p class="note" role="status">You have started several demos in the last hour. Try again later.</p>
		{/if}
		<p class="note">
			The demo is the real app, with 90 days of sample history already in it. You do not need an
			email or anything to install, and your demo is deleted after one day.
		</p>
	</header>

	<section aria-labelledby="rules-heading">
		<h2 id="rules-heading">The seven rules</h2>
		<ol class="rules">
			{#each RULES as r, i (r.rule)}
				<li>
					<span class="n" aria-hidden="true">{i + 1}</span>
					<div>
						<p class="rule">{r.rule}</p>
						<p class="why">{r.why}</p>
					</div>
				</li>
			{/each}
		</ol>
	</section>

	<footer>
		<p>
			Split runs on a single SQLite file, with no queue, no worker and no outside API. Each rule above
			is checked by a test. The most important one, that no query can return another person’s data,
			is protected by making the unscoped database handle impossible to import.
		</p>
	</footer>
</main>

<style>
	main {
		max-width: 44rem;
		margin: 0 auto;
		padding: 4rem 1.5rem 6rem;
		display: flex;
		flex-direction: column;
		gap: 3rem;
	}

	.eyebrow {
		margin: 0 0 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-muted);
	}

	h1 {
		margin: 0 0 1rem;
		font-size: clamp(1.75rem, 5vw, 2.5rem);
		font-weight: 500;
		line-height: 1.15;
		letter-spacing: -0.02em;
		text-wrap: balance;
		max-width: 20ch;
	}

	.lede {
		margin: 0 0 2rem;
		max-width: 54ch;
		color: var(--ink-secondary);
		font-size: 1.0625rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: center;
	}

	.primary,
	.secondary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--touch);
		padding: 0 1.5rem;
		border-radius: 999px;
		font-family: inherit;
		font-size: 0.9375rem;
		font-weight: 500;
		text-decoration: none;
		cursor: pointer;
	}

	/*
	 * Ink on ground: white with near-black text in dark mode, inverted in
	 * light. Keeps the page to the app's black-and-white palette, and the
	 * contrast is far above the 4.5:1 floor in both themes.
	 */
	.primary {
		background: var(--ink);
		border: 1px solid var(--ink);
		color: var(--ground);
	}

	.primary:hover {
		opacity: 0.88;
	}

	.secondary {
		background: none;
		border: 1px solid var(--hairline-strong);
		color: var(--ink);
	}

	.secondary:hover {
		border-color: var(--ink-muted);
	}

	.note {
		margin: 1rem 0 0;
		max-width: 48ch;
		color: var(--ink-muted);
		font-size: 0.8125rem;
	}

	h2 {
		margin: 0 0 1.25rem;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-muted);
	}

	.rules {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.rules li {
		display: flex;
		gap: 1rem;
		padding: 1rem 0;
		border-top: 1px solid var(--hairline);
	}

	/*
	 * Numbered because these ARE a numbered set the reader may want to refer
	 * back to, not for decoration. Mono, so the column stays straight.
	 */
	.n {
		flex: none;
		width: 1.5rem;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		color: var(--ink-muted);
		padding-top: 0.1rem;
	}

	.rule {
		margin: 0 0 0.25rem;
		font-size: 0.9375rem;
		font-weight: 500;
	}

	.why {
		margin: 0;
		max-width: 60ch;
		color: var(--ink-secondary);
		font-size: 0.875rem;
	}

	footer {
		padding-top: 1.5rem;
		border-top: 1px solid var(--hairline);
	}

	footer p {
		margin: 0;
		max-width: 60ch;
		color: var(--ink-muted);
		font-size: 0.8125rem;
	}
</style>
