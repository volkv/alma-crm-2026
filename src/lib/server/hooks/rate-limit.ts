import { redirect, type Handle } from '@sveltejs/kit';
import { UNKNOWN_ADDRESS, withinAddressLimit } from '$lib/server/auth/lockout';

/**
 * Caps how often one caller may hit the expensive and abusable routes using the
 * Redis instance the app already runs on.
 *
 * Here that means the sign-in form and nothing else: the lock on a single
 * account stops someone guessing one person's password, and this stops one
 * machine walking through accounts. Sending POSTs is what costs — a hash to
 * verify and a row to read — so only those are counted; opening the page is
 * free, and a successful sign-in with a password clears the counter. The public
 * API brings its own limiter with its own keys.
 *
 * The rule is the route group rather than a list of paths, so a second `(auth)`
 * page is covered by existing there. A refusal sends the visitor back to the
 * page they posted from instead of answering with a bare 429 body: that page
 * sees the same exhausted counter and says in words how long the wait is, which
 * a status code alone cannot do. `next` is carried over — being rate limited
 * should not also lose where the visitor was going.
 *
 * Перенаправление бросается по той же причине, что и в `guard`: форму входа
 * отправляет `use:enhance`, и ответом на неё обязан быть конверт, который
 * собирает SvelteKit, а не готовый 303 с разметкой страницы внутри.
 */
export const rateLimit: Handle = async ({ event, resolve }) => {
	if (event.route.id?.startsWith('/(auth)') && event.request.method === 'POST') {
		const ip = event.getClientAddress() || UNKNOWN_ADDRESS;

		if (!(await withinAddressLimit(ip))) {
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
