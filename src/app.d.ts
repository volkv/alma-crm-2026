// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { ApiKeyContext } from '$lib/server/api/types';
import type { SessionUser } from '$lib/server/auth/types';

declare global {
	namespace App {
		interface Error {
			message: string;
			/** Ties the page the user sees to the server log line. */
			requestId?: string;
		}

		interface Locals {
			/** Set by the `requestId` hook before anything else runs. */
			requestId: string;
			/** Set by the `session` hook; `null` for anonymous requests. */
			user: SessionUser | null;
			/** Set by the `session` hook; `null` unless the caller used an API key. */
			apiKey: ApiKeyContext | null;
		}
	}
}

export {};
