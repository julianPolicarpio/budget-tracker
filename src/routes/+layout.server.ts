/**
 * Root layout load: the shared Actions-panel context (Spec A2, A6).
 *
 * Runs for every page under this layout, including public ones reached with
 * no session (e.g. `/signin`), where `locals.userId` is never set by
 * hooks.server.ts — and for a signed-in user who has not finished `/setup`,
 * where a userId exists but no settings row does. `buildActionContext()`
 * handles both by returning empty arrays rather than throwing; see its doc
 * comment in $lib/actions/context.ts.
 */
import { buildActionContext } from '$lib/actions/context';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	return { actionContext: buildActionContext(locals.userId) };
};
