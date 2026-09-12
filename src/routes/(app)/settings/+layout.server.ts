import { actorFromEvent } from '$lib/server/actor';
import { can } from '$lib/server/rbac';
import { SETTINGS_SECTIONS } from './sections';
import type { LayoutServerLoad } from './$types';

/**
 * Какие разделы настроек человек вообще видит. Меню собирается из прав здесь,
 * а отказ по прямой ссылке — в загрузчике самого раздела: одно правило, два
 * места применения, и оба читают `SETTINGS_SECTIONS`.
 *
 * Адреса отдаются как есть, без `resolve()`: их сравнивают с `url.pathname`
 * текущей страницы, а `resolve()` во время отрисовки возвращает путь
 * относительно неё — ссылка получится верной, а сравнение никогда не совпадёт.
 */
export const load: LayoutServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	return {
		sections: SETTINGS_SECTIONS.filter(
			(section) => section.permission === null || can(ctx, section.permission)
		).map((section) => ({
			href: section.href,
			label: section.label,
			description: section.description
		}))
	};
};
