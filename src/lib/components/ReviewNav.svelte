<script lang="ts">
	/**
	 * Navigation between the REVIEW-class screens.
	 *
	 * Deliberately absent from Today. That screen has one job and a closed list
	 * of widgets (Spec §8.1); a nav bar is an invitation to go looking at
	 * balances, which is the whole thing the withholding layer exists to
	 * prevent. You get to the review surfaces through a prompt that has a
	 * reason to be there, or by typing the URL.
	 */
	import { page } from '$app/state';

	const LINKS = [
		{ href: '/review', label: 'Weekly review' },
		{ href: '/accounts', label: 'Accounts' },
		{ href: '/irregulars', label: 'Big bills' },
		{ href: '/subscriptions', label: 'Subscriptions' },
		{ href: '/trips', label: 'Trips' },
		{ href: '/debt', label: 'Debt' },
		{ href: '/rules', label: 'Wishlist' },
		{ href: '/trends', label: 'Trends' }
	];

	const current = $derived(page.url.pathname);
</script>

<nav class="nav" aria-label="Review screens">
	{#each LINKS as l (l.href)}
		<a
			href={l.href}
			class:on={current === l.href}
			aria-current={current === l.href ? 'page' : undefined}
		>
			{l.label}
		</a>
	{/each}
	<a class="home" href="/">Today</a>
</nav>

<style>
	.nav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--hairline);
	}

	a {
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
	}

	.home {
		margin-left: auto;
		border-color: var(--hairline-strong);
	}
</style>
