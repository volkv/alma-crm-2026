import { redirect, type Handle } from '@sveltejs/kit';
import { UNKNOWN_ADDRESS, withinStartLimit } from '$lib/server/auth/start-limit';
import { clientAddress } from '$lib/server/http';

/**
 * Caps how often one caller may hit the expensive and abusable routes using the
 * Redis instance the app already runs on.
 *
 * Here that means starting a sign-in and nothing else. Passwords are checked by
 * the account directory, and guessing one is its problem; what is ours is that
 * every press of «Войти» writes a record to Redis — state, nonce and the PKCE
 * verifier — and without a ceiling an anonymous stream of presses would fill it
 * without ever naming itself. The public API brings its own limiter with its own
 * keys.
 *
 * The rule is the route group rather than a list of paths, so a second `(auth)`
 * page is covered by existing there. A refusal sends the visitor back to the
 * page they posted from instead of answering with a bare 429 body: that page
 * sees the same exhausted counter and says in words how long the wait is, which
 * a status code alone cannot do. `next` is carried over — being rate limited
 * should not also lose where the visitor was going.
 *
 * Перенаправление бросается по той же причине, что и в `guard`: страница входа
 * отправляет форму через `use:enhance`, и ответом на неё обязан быть конверт,
 * который собирает SvelteKit, а не готовый 303 с разметкой страницы внутри.
 */
export const rateLimit: Handle = async ({ event, resolve }) => {
	if (event.route.id?.startsWith('/(auth)') && event.request.method === 'POST') {
		const ip = clientAddress(event) || UNKNOWN_ADDRESS;

		if (!(await withinStartLimit(ip))) {
			const next = event.url.searchParams.get('next');

			redirect(
				303,
				next === null
					? event.url.pathname
					: `${event.url.pathname}?next=${encodeURIComponent(next)}`
			);
		}
	}

	return resolve(event);
};
