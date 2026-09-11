import type { Handle } from '@sveltejs/kit';
import {
	clearSessionCookie,
	loadSessionUser,
	SESSION_COOKIE,
	touchSession
} from '$lib/server/auth/session';

/**
 * Resolves who is making the request — a browser session cookie or an API key —
 * and puts the answer on `locals` for every later hook and every load function.
 *
 * The user is rebuilt from the database on every request rather than kept in
 * the session record: a revoked permission, a changed role or a deactivated
 * account has to take effect now, not at the end of the working day.
 *
 * A cookie that no longer resolves is removed right here. Leaving it in place
 * would send the browser back to the sign-in page on every navigation while it
 * keeps presenting the same dead identifier.
 */
export const session: Handle = async ({ event, resolve }) => {
	event.locals.user = null;
	event.locals.apiKey = null;

	const sessionId = event.cookies.get(SESSION_COOKIE);

	if (sessionId !== undefined) {
		const userId = await touchSession(sessionId);
		const user = userId === null ? null : await loadSessionUser(userId);

		if (user === null) {
			clearSessionCookie(event.cookies);
		} else {
			event.locals.user = user;
		}
	}

	return resolve(event);
};
