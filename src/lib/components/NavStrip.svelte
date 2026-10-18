<script lang="ts">
	/**
	 * One strip, every screen.
	 *
	 * This replaced two things: the pill row that lived only on the REVIEW
	 * screens, and a nine row dropdown on Today that carried a description per
	 * destination. Both navigated to the same places in different shapes, so you
	 * had to learn two models for one job.
	 *
	 * This component used to be `ReviewNav`, and its doc said a nav bar was
	 * "deliberately absent from Today" because it "is an invitation to go
	 * looking at balances". That reasoning is kept here rather than deleted,
	 * because it is right about the risk. What changed is the reading of the
	 * facts: Today already carried a dropdown to all nine of these screens, so
	 * the capability was never actually withheld, only made two taps deep. The
	 * guard that matters is the withholding layer in `today.ts`, which is
	 * enforced by the type system, not the number of taps it takes to leave.
	 *
	 * The strip itself leaks nothing: labels only, never a figure, never a
	 * count. Owner's call, 2026-10-01.
	 */
	import { page } from '$app/state';
	import { destinationsFor } from '$lib/nav/destinations';

	const current = $derived(page.url.pathname);
</script>

<nav class="nav" aria-label="Screens">
	{#each destinationsFor(page.data.demo === true) as d (d.href)}
		<a
			href={d.href}
			class:on={current === d.href}
			aria-current={current === d.href ? 'page' : undefined}
		>
			{d.label}
		</a>
	{/each}
	<a class="home" class:on={current === '/'} href="/">Today</a>
</nav>

<style>
	/*
	 * One line that scrolls sideways rather than wrapping to three. Wrapping
	 * changes the strip's height depending on which screen you are on, which
	 * moves everything below it. A fixed height row that scrolls keeps every
	 * screen's first line of content in the same place.
	 */
	.nav {
		display: flex;
		gap: 0.375rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--hairline);
		overflow-x: auto;
		scrollbar-width: none;
	}

	.nav::-webkit-scrollbar {
		display: none;
	}

	/*
	 * `min-height: var(--touch)` because this row inherited a 34px pill from
	 * the old review-only nav, and it now sits on Today, which is used
	 * one-handed on a phone at night. The token's own comment is unconditional:
	 * "The one-handed floor. Nothing tappable goes below this." A 34px target
	 * is a miss you make tired and then have to undo.
	 */
	a {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		min-height: var(--touch);
		padding: 0.4rem 0.75rem;
		border: 1px solid transparent;
		border-radius: 999px;
		color: var(--ink-muted);
		font-size: 0.8125rem;
		text-decoration: none;
		white-space: nowrap;
	}

	a:hover {
		color: var(--ink);
	}

	a.on {
		color: var(--ink);
		border-color: var(--hairline-strong);
		/*
		 * Named so the View Transitions API can carry this one element between
		 * screens. Only the active pill animates: the thing that actually
		 * changed is the thing that moves (DESIGN.md, Motion).
		 */
		view-transition-name: nav-current;
	}

	.home {
		margin-left: auto;
		border-color: var(--hairline-strong);
	}

	/*
	 * On Today the strip is the last thing on the page, so its rule belongs
	 * above it rather than below.
	 */
	:global(.door-strip) .nav {
		padding-top: 1rem;
		padding-bottom: 0;
		border-bottom: 0;
		border-top: 1px solid var(--hairline);
	}
</style>
