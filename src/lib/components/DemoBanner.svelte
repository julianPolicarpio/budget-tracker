<script lang="ts">
	/**
	 * The demo's one thin line, plus the guided tour. Mounted by the root layout
	 * only when the visitor is in the public demo, so the live app never renders
	 * it and never loads driver.js.
	 */
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { maybeAutoStart, notifyNavigated, startTour, stopTour } from '$lib/tour/tour';

	afterNavigate((nav) => {
		notifyNavigated(nav.to?.url.pathname ?? window.location.pathname);
	});

	onMount(() => {
		maybeAutoStart(true);
		return () => stopTour();
	});
</script>

<p class="demo-banner">
	<span>Demo</span>
	<span aria-hidden="true">&middot;</span>
	<span>your data is deleted after 24 hours</span>
	<span aria-hidden="true">&middot;</span>
	<button type="button" onclick={() => startTour({ restart: true })}>Replay tour</button>
</p>

<style>
	.demo-banner {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.375rem;
		margin: 0;
		padding: 0.375rem 1rem;
		border-bottom: 1px solid var(--hairline);
		color: var(--ink-muted);
		font-size: 0.75rem;
		line-height: 1.4;
	}

	button {
		padding: 0;
		border: 0;
		background: none;
		color: var(--ink);
		font: inherit;
		text-decoration: underline;
		text-underline-offset: 0.15em;
		cursor: pointer;
	}

	button:focus-visible {
		outline: 2px solid var(--ink);
		outline-offset: 2px;
	}
</style>
