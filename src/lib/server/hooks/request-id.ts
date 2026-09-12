import { randomUUID } from 'node:crypto';
import type { Handle } from '@sveltejs/kit';

/** Response header that carries the id of the request that produced it. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Gives every request an id that logs, error pages and API error bodies can
 * quote, so a user's report maps to exactly one server log line.
 *
 * The id is always generated here and never taken from the incoming request:
 * an id supplied by the caller would let anyone forge or collide with the ids
 * in our logs.
 *
 * Being the outermost hook, this one stamps every response the chain produces,
 * including the ones a hook builds itself — which is why those are returned
 * rather than thrown (see `hookRedirect`).
 */
export const requestId: Handle = async ({ event, resolve }) => {
	event.locals.requestId = randomUUID();

	const response = await resolve(event);
	response.headers.set(REQUEST_ID_HEADER, event.locals.requestId);

	return response;
};
