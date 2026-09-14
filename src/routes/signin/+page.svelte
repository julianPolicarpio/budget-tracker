<script lang="ts">
	// One button. This is the whole page — Spec §8.0b's calm DAILY register,
	// taken to its limit: there is nothing here to review and nothing to log.
	import { onMount } from 'svelte';
	import { clearAll } from '$lib/outbox';

	/**
	 * "Cleared on sign-out" (Spec §6, task A5). This screen is the one place
	 * a signed-out browser always lands — by an explicit sign-out, an
	 * expired session, or simply never having signed in — so wiping the
	 * offline outbox here, unconditionally, is what stops a queued entry
	 * from ever replaying into a different tenant after an account switch
	 * on a shared device (the offline version of the leak Spec §3 exists to
	 * prevent; see `src/lib/outbox.ts`'s module doc). Idempotent against an
	 * empty or already-cleared store, so a first-time visitor pays nothing
	 * for it.
	 */
	onMount(() => {
		clearAll();
	});
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
