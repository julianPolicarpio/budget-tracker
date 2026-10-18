/**
 * Screens the public demo hides. Plain and DOM-free so the server hook and the
 * client both read the same list.
 */
export const DEMO_HIDDEN_PREFIXES = [
	'/accounts',
	'/irregulars',
	'/subscriptions',
	'/trips',
	'/debt',
	'/rules',
	'/trends',
	'/settings',
	'/setup'
] as const;

/**
 * True when `pathname` is, or sits under, a hidden screen. Matches the decoded,
 * lowercased path, so `/%74rips` and `/TRIPS` do not slip through. A path that
 * does not decode is treated as hidden.
 */
export function isDemoHidden(pathname: string): boolean {
	let path: string;
	try {
		path = decodeURIComponent(pathname).toLowerCase();
	} catch {
		return true;
	}
	return DEMO_HIDDEN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}
