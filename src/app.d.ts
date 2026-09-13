// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/**
			 * The caller of every request. Set by hooks.server.ts from a session
			 * cookie (Spec §3.3), or hardcoded to 1 in the single-user escape
			 * hatch when no Google sign-in is configured (see auth.ts). Routes
			 * exempt from the sign-in redirect (`/signin`, `/auth/*`,
			 * `/api/health`) may run with this unset — they do not read it.
			 */
			userId: number;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
