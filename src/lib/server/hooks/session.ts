import type { Handle } from '@sveltejs/kit';

/**
 * Resolves who is making the request — a browser session cookie or an API key —
 * and puts the answer on `locals` for every later hook and every load function.
 *
 * The lookup itself belongs to the auth module and lands with it. Until then no
 * caller can be authenticated, so both slots are filled with `null`: that keeps
 * `locals.user` and `locals.apiKey` matching their declared types instead of
 * being `undefined` behind a type that promises otherwise.
 */
export const session: Handle = async ({ event, resolve }) => {
	event.locals.user = null;
	event.locals.apiKey = null;

	return resolve(event);
};
