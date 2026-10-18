/**
 * Every screen you can navigate to, in one place.
 *
 * This list used to exist twice: a `DOOR` array on Today carrying labels plus a
 * description each, and a `LINKS` array in the nav component carrying labels
 * alone. They drifted, as duplicated lists do. `ReviewNav` omitted Settings
 * entirely, so from `/accounts` there was no way to reach it without going back
 * to Today first. One array makes that class of bug impossible rather than
 * merely fixed.
 *
 * Order is fixed and never sorted at runtime. Spec A7: "Stable grouping, plain
 * labels, search; no unpredictable reordering." A list that rearranges itself
 * costs you the muscle memory that makes it fast, which is the entire reason
 * this is a strip and not a menu.
 *
 * Labels only. No descriptions: they answer "what is this tab" once and are
 * noise on every visit after that (DESIGN.md, Voice).
 */

export interface Destination {
	href: string;
	label: string;
}

export const DESTINATIONS: readonly Destination[] = [
	{ href: '/review', label: 'Weekly review' },
	{ href: '/accounts', label: 'Accounts' },
	{ href: '/irregulars', label: 'Big bills' },
	{ href: '/subscriptions', label: 'Subscriptions' },
	{ href: '/trips', label: 'Trips' },
	{ href: '/debt', label: 'Debt' },
	{ href: '/rules', label: 'Wishlist' },
	{ href: '/trends', label: 'Trends' },
	{ href: '/settings', label: 'Settings' }
];

/** The only destinations a public-demo visitor sees besides Today. */
export const DEMO_HREFS: readonly string[] = ['/review'];

export function destinationsFor(demo: boolean): readonly Destination[] {
	return demo ? DESTINATIONS.filter((d) => DEMO_HREFS.includes(d.href)) : DESTINATIONS;
}
