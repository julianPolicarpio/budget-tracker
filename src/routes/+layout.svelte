<script lang="ts">
	import './layout.css';
	import { onNavigate } from '$app/navigation';
	import favicon from '$lib/assets/favicon.svg';
	import DemoBanner from '$lib/components/DemoBanner.svelte';

	let { children, data } = $props();

	/*
	 * Navigation shows continuity, not arrival (DESIGN.md, Motion).
	 *
	 * Without this, moving between screens blanks and redraws, so nine screens
	 * read as nine pages rather than one surface changing. The only element
	 * given a `view-transition-name` is the active pill in `NavStrip`, so the
	 * thing that actually changed is the thing that moves; everything else
	 * crossfades.
	 *
	 * Browsers without the View Transitions API skip straight to the resolve,
	 * which is an ordinary SvelteKit navigation. There is no fallback to write
	 * and nothing to feature-detect beyond this guard.
	 */
	onNavigate((navigation) => {
		if (!document.startViewTransition) return;

		return new Promise((resolve) => {
			const transition = document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});

			/*
			 * `ready` rejects whenever the browser declines to animate: a hidden
			 * document, a transition superseded by a second navigation before the
			 * first painted, reduced motion. Every one of those is correct
			 * behaviour and the navigation still completes, so there is nothing to
			 * handle. Without this catch the rejection is unhandled and logs
			 * "Transition was aborted because of invalid state" to the console on
			 * each one, which buries real errors.
			 */
			transition.ready.catch(() => {});
		});
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{#if data.demo === true}<DemoBanner />{/if}
{@render children()}
