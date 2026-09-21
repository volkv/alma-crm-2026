import type { Handle } from '@sveltejs/kit';
import {
	clearSessionCookie,
	loadSessionUser,
	renewSessionCookie,
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
 * A cookie that no longer resolves is dropped before the request goes any
 * further. Leaving it in place would send the browser back to the sign-in page
 * on every navigation while it keeps presenting the same dead identifier. The
 * reset is left pending in `event.cookies`, which covers both outcomes:
 * SvelteKit attaches pending cookies to a route's response and to the redirect
 * the guard throws alike. A sign-in later in the same request sets the cookie
 * again, and that value wins over the reset.
 *
 * Сессию, которая продлилась, хук пересылает браузеру заново: срок жизни
 * cookie — вторая половина скользящего окна, и без этой пересылки он стоял бы
 * на месте от самого входа. Тогда браузер выбрасывал бы cookie через
 * `session_idle_minutes` после входа независимо от работы человека, а
 * продлённая сессия оставалась бы в Redis без того, чем её предъявить.
 */
export const session: Handle = async ({ event, resolve }) => {
	event.locals.user = null;
	event.locals.apiKey = null;

	const sessionId = event.cookies.get(SESSION_COOKIE);

	if (sessionId !== undefined) {
		const touched = await touchSession(sessionId);
		const user = touched === null ? null : await loadSessionUser(touched.userId);

		if (touched === null || user === null) {
			clearSessionCookie(event.cookies);
		} else {
			event.locals.user = user;

			if (touched.renewFor !== null) {
				renewSessionCookie(event.cookies, sessionId, touched.renewFor);
			}
		}
	}

	return resolve(event);
};
