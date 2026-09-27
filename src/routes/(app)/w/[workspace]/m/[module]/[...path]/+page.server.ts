import { error } from '@sveltejs/kit';
import type { SectionSpec } from '$lib/platform/define';
import { moduleByKey } from '$lib/platform/registry';
import { loadModuleSection } from '$lib/platform/sections-registry.server';
import { actorFromEvent } from '$lib/server/actor';
import { can } from '$lib/server/rbac';
import { PERMISSIONS } from '$lib/server/rbac/permissions';
import type { PageServerLoad } from './$types';

/**
 * Страница модуля: один маршрут на все разделы всех модулей.
 *
 * Модуль не кладёт файлов в `src/routes` — иначе его нельзя было бы подключить
 * или убрать одной строкой в `crm.config.ts`, — поэтому страницы модулей
 * открывает этот диспетчер: `/w/<пространство>/m/<модуль>/<раздел>`. Вход в
 * пространство уже проверил загрузчик ветки (`w/[workspace]`), подсветку пункта
 * меню даёт префикс адреса, как у остальных разделов.
 *
 * Проверки идут по порядку, и каждая отвечает своими словами: незнакомый модуль
 * или раздел — 404, нет права раздела — 403, модуль не действует в этом
 * пространстве — 404. Последнее не 403: права у человека есть, нет самой
 * страницы, как нет и пункта меню, который бы на неё вёл.
 */
export const load: PageServerLoad = async (event) => {
	const { params } = event;
	const module = moduleByKey(params.module);

	if (module === undefined) {
		error(404, 'Такого модуля в системе нет');
	}

	const segments = params.path.split('/').filter((segment) => segment !== '');
	const [sectionKey, ...rest] = segments;
	const sections: readonly SectionSpec[] = module.sections;
	const section =
		sectionKey === undefined
			? sections.at(0)
			: sections.find((candidate) => candidate.key === sectionKey);

	if (section === undefined) {
		error(404, `У модуля «${module.label}» нет такой страницы`);
	}

	const ctx = actorFromEvent(event);

	// Вошёл в пространство — не значит «можно»: адрес набирают руками.
	if (section.permission !== null && !can(ctx, section.permission)) {
		error(
			403,
			`Страница «${section.label}» доступна только с правом «${PERMISSIONS[section.permission]}»`
		);
	}

	const { workspace } = await event.parent();

	if (!workspace.modules.includes(module.key)) {
		error(404, `Модуль «${module.label}» не подключён к пространству «${workspace.name}»`);
	}

	const sectionData = await loadModuleSection(module.key, section.key, {
		event,
		ctx,
		workspace,
		rest
	});

	return {
		module: module.key,
		section: section.key,
		title: section.label,
		sectionData
	};
};
