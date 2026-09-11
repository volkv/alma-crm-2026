import type { LayoutServerLoad } from './$types';

/**
 * Who the request belongs to. The `session` hook has already resolved it, so
 * this only hands the answer to the shell: the sidebar and the account menu are
 * the same on every page, and repeating the lookup per route would be the thing
 * that eventually disagrees with itself.
 */
export const load: LayoutServerLoad = async ({ locals }) => ({ user: locals.user });
