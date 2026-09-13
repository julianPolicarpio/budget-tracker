// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/**
			 * The caller of every request. Hardcoded to 1 in hooks.server.ts until
			 * A2 adds real sessions — see the comment there (Spec §3.2).
			 */
			userId: number;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
