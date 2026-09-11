import type { Handle } from '@sveltejs/kit';

/**
 * Caps how often one caller may hit the expensive and abusable routes — sign-in,
 * password reset, document rendering, the public API — using the Redis instance
 * the app already runs on.
 *
 * The counters and their limits belong to the auth and API modules and land with
 * them. Until those routes exist there is nothing to limit.
 */
export const rateLimit: Handle = async ({ event, resolve }) => resolve(event);
