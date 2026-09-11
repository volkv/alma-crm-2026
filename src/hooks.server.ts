import type { ServerInit } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { getConfig } from '$lib/server/config';
import { guard } from '$lib/server/hooks/guard';
import { rateLimit } from '$lib/server/hooks/rate-limit';
import { requestId } from '$lib/server/hooks/request-id';
import { securityHeaders } from '$lib/server/hooks/security-headers';
import { session } from '$lib/server/hooks/session';

/**
 * Runs once while the server starts, before it accepts any request — and not
 * during the build. A missing or malformed variable stops the process here
 * rather than surfacing as a broken page later.
 */
export const init: ServerInit = () => {
	getConfig();
};

/**
 * Every cross-cutting concern of a request, in the order it has to happen:
 * an id to log under, headers that must be on every response, who the caller is,
 * whether they may proceed, and how often they may do so. A new aspect goes into
 * its own file under `lib/server/hooks` and into this list — never inline here.
 */
export const handle = sequence(requestId, securityHeaders, session, guard, rateLimit);
