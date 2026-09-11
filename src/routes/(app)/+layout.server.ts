import { getConfig } from '$lib/server/config';
import type { LayoutServerLoad } from './$types';

/**
 * Who the request belongs to. The `session` hook has already resolved it, so
 * this only hands the answer to the shell: the sidebar and the account menu are
 * the same on every page, and repeating the lookup per route would be the thing
 * that eventually disagrees with itself.
 *
 * The demo flag travels with it for the same reason — the banner that warns the
 * visitor the data is synthetic belongs to the frame, not to a page.
 */
export const load: LayoutServerLoad = async ({ locals }) => ({
	user: locals.user,
	demoMode: getConfig().DEMO_MODE
});
