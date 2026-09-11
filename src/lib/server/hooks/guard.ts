import type { Handle } from '@sveltejs/kit';

/**
 * Decides whether the resolved caller may reach the requested route at all:
 * redirects anonymous browsers to the sign-in page and answers API callers with
 * 401/403 before any load function or endpoint runs.
 *
 * The route-to-permission map is part of the auth module and lands with it.
 * Until then every route is public, which is what the application currently is.
 */
export const guard: Handle = async ({ event, resolve }) => resolve(event);
