<script lang="ts">
	// One button. This is the whole page — Spec §8.0b's calm DAILY register,
	// taken to its limit: there is nothing here to review and nothing to log.
</script>

<svelte:head><title>Split — sign in</title></svelte:head>

<main>
	<p class="eyebrow">Split</p>
	<h1>Your own budget, not a bank's.</h1>
	<p class="tagline">No balances shown, no bank linked, ever. Sign in to start logging.</p>
	<a class="google" href="/auth/google">Continue with Google</a>
</main>

<style>
	main {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 2rem 1.5rem;
		text-align: center;
	}

	.eyebrow {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-muted);
		margin: 0;
	}

	h1 {
		margin: 0;
		font-size: 1.5rem;
		font-weight: 500;
		max-width: 24rem;
	}

	.tagline {
		margin: 0 0 0.5rem;
		color: var(--ink-secondary);
		max-width: 22rem;
	}

	.google {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--touch);
		padding: 0 1.5rem;
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
		font-weight: 500;
		text-decoration: none;
	}

	.google:hover {
		filter: brightness(1.08);
	}
</style>
