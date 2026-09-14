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
			why: 'Seeing a large balance reliably makes people spend more. The code that builds that screen has no field for one, so adding it breaks the build rather than slipping through review.'
		},
		{
			rule: 'Your daily number is a range, not a number',
			why: '“₱103 left” reads as permission to spend ₱103, then a little past it. A range has no edge to spend up to.'
		},
		{
			rule: 'You type every purchase yourself',
			why: 'No bank sync, no card sync, ever. The typing is the mechanism, not the inconvenience — automatic tracking removes the one moment where you notice.'
		},
		{
			rule: 'Eight categories, and no budget on any of them',
			why: 'Subdividing a spending budget is the one intervention that measurably made people spend more. Categories exist for the weekly review and nothing else.'
		},
		{
			rule: 'Underspending does not raise tomorrow’s number',
			why: 'It is set once when the week opens and frozen. Recalculating “what is left ÷ days remaining” produces an end-of-week spree; the app deliberately cannot do that arithmetic.'
		},
		{
			rule: 'A 15% cushion is taken off the top and hidden',
			why: 'People cannot hold a mental buffer, so the app holds it structurally. It accumulates quietly and sweeps into savings when the week closes.'
		},
		{
			rule: 'Bills never touch your spending money',
			why: 'Rent, subscriptions and the annual ones are reserved before the daily figure is calculated. A cost you cannot decline has no business competing with a coffee.'
		}
	];
</script>

<svelte:head>
	<title>Split — a budgeting app that hides your balance</title>
	<meta
		name="description"
		content="Split is deliberately worse at what budgeting apps compete on, because the evidence says those features cause overspending."
	/>
</svelte:head>

<main>
	<header>
		<p class="eyebrow">Split</p>
		<h1>A budgeting app that refuses to show you your balance.</h1>
		<p class="lede">
			It is deliberately worse at everything budgeting apps compete on — live balances, rich
			categories, automatic import — because each of those measurably makes people spend more.
			Seven constraints, none of them oversights.
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
			<a class="secondary" href="/auth/google">Sign in with Google</a>
		</div>
		<p class="note">
			The demo is the real app with ninety days of history in it. No email, nothing to install, and
			it deletes itself after a day.
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
			Single SQLite file, no queue, no worker, no external API. Every constraint above is enforced
			by a test, and the one that matters most — that no query can return another person’s data —
			is enforced by making the unscoped database handle impossible to import.
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
	 * --accent-solid, not --accent. White on --accent is 3.64:1 in dark mode
	 * and 4.41:1 in light: both fail the 4.5:1 floor for text this size. The
	 * darker step clears it in both themes, and this is the one button a
	 * reviewer is most likely to look at.
	 */
	.primary {
		background: var(--accent-solid, #1f5fb0);
		border: 1px solid transparent;
		color: #fff;
	}

	.primary:hover {
		filter: brightness(1.1);
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
