import type { Handle } from '@sveltejs/kit';
import { hookRedirect } from './redirect';

/**
 * Decides whether the resolved caller may reach the requested route at all.
 *
 * The rule is the route group, not a list of paths: everything under `(app)` is
 * the application itself and needs a session, `(auth)` is how one is obtained,
 * and `/api/v1` authenticates with keys and answers in JSON — that belongs to
 * the API module, so it is left alone here. A request for a route that does not
 * exist (`route.id === null`) is not redirected either: a missing page must
 * answer 404 whether or not anyone is signed in, or the guard turns into a map
 * of what exists.
 *
 * Per-route permissions are checked by the loads and services that know what
 * they are protecting; this hook only answers "is there anybody there".
 *
 * The redirect is built rather than thrown: a thrown one leaves the hook chain
 * altogether, and the response it turns into never gets the security headers or
 * the request id that the outer hooks put on everything else.
 */
export const guard: Handle = async ({ event, resolve }) => {
	if (event.route.id?.startsWith('/(app)') && event.locals.user === null) {
		const next = `${event.url.pathname}${event.url.search}`;

		return hookRedirect(`/login?next=${encodeURIComponent(next)}`);
	}

	return resolve(event);
};
