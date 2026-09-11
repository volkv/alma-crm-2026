import type { ServerInit } from '@sveltejs/kit';
import { getConfig } from '$lib/server/config';

/**
 * Runs once while the server starts, before it accepts any request — and not
 * during the build. A missing or malformed variable stops the process here
 * rather than surfacing as a broken page later.
 */
export const init: ServerInit = () => {
	getConfig();
};
