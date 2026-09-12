import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import type { PageServerLoad } from './$types';

/**
 * У раздела настроек нет своей страницы: открывать его имеет смысл сразу на
 * профиле — единственном подразделе, который доступен любому вошедшему.
 */
export const load: PageServerLoad = async () => {
	redirect(303, resolve('/settings/profile'));
};
