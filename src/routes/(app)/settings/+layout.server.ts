import { actorFromEvent } from '$lib/server/actor';
import { can } from '$lib/server/rbac';
import { SETTINGS_SECTIONS } from './sections';
import type { LayoutServerLoad } from './$types';

/**
 * Какие подразделы настроек человек вообще видит. Отсюда оболочка раздела
 * берёт название и подпись открытого подраздела — для заголовка и хлебных
 * крошек; в главное меню подразделы попадают своим путём (`$lib/nav`), а отказ
 * по прямой ссылке выдаёт загрузчик самого подраздела. Право у всех трёх одно
 * и то же, и берут они его из одной таблицы.
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
