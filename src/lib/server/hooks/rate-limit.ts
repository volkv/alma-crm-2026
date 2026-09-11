import { error, type Handle } from '@sveltejs/kit';
import { UNKNOWN_ADDRESS, withinAddressLimit } from '$lib/server/auth/lockout';

/**
 * Caps how often one caller may hit the expensive and abusable routes using the
 * Redis instance the app already runs on.
 *
 * Here that means the sign-in form and nothing else: the lock on a single
 * account stops someone guessing one person's password, and this stops one
 * machine walking through accounts. Sending POSTs is what costs — a hash to
 * verify and a row to read — so only those are counted; opening the page is
 * free. The public API brings its own limiter with its own keys.
 */
export const rateLimit: Handle = async ({ event, resolve }) => {
	if (event.route.id?.startsWith('/(auth)') && event.request.method === 'POST') {
		const ip = event.getClientAddress() || UNKNOWN_ADDRESS;

		if (!(await withinAddressLimit(ip))) {
			error(429, 'Слишком много попыток входа с этого адреса. Попробуйте через 15 минут.');
		}
	}

	return resolve(event);
};
