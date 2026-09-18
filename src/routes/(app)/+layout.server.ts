import { getConfig } from '$lib/server/config';
import { getSetting } from '$lib/server/settings';
import type { LayoutServerLoad } from './$types';

/**
 * Who the request belongs to. The `session` hook has already resolved it, so
 * this only hands the answer to the shell: the sidebar and the account menu are
 * the same on every page, and repeating the lookup per route would be the thing
 * that eventually disagrees with itself.
 *
 * The demo flag travels with it for the same reason — the banner that warns the
 * visitor the data is synthetic belongs to the frame, not to a page.
 *
 * Час ежедневного сброса едет туда же и только на стенде: полоса обязана сказать
 * зрителю, что данные общие и до какого часа они доживут. Вне демонстрационного
 * режима расписания не существует, и настройку незачем читать на каждой
 * странице.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	const demoMode = getConfig().DEMO_MODE;
	const schedule = demoMode ? await getSetting('demo_reset_schedule') : null;

	return {
		user: locals.user,
		demoMode,
		demoResetHour: schedule !== null && schedule.enabled ? schedule.hour : null
	};
};
