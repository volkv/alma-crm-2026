/**
 * Загрузчики страниц модулей из `sections.server.ts` установленных модулей.
 *
 * Импорт жадный и статический, как у реестра компонентов: раздел без
 * загрузчика должен всплыть при запуске, а не у сотрудника на первом нажатии.
 * Часть модуля, которого нет в `crm.config.ts`, отбрасывается.
 */
import type { ActorContext } from '$lib/server/actor';
import type { RequestEvent } from '@sveltejs/kit';
import type { SectionWorkspace } from './sections';
import type { SectionRouteParams, SectionsServerPart } from './sections.server';
import { INSTALLED_MODULES, isModuleKey, type ModuleKey } from './registry';

const found = import.meta.glob<{ default: SectionsServerPart }>(
	['/src/modules/*/sections.server.ts', '/src/modules/custom/*/sections.server.ts'],
	{ eager: true }
);

const PARTS = new Map<ModuleKey, SectionsServerPart>();

for (const [file, loaded] of Object.entries(found)) {
	const part = loaded.default;

	if (!isModuleKey(part.key)) {
		continue;
	}

	if (PARTS.has(part.key)) {
		throw new Error(`Загрузчики страниц модуля «${part.key}» объявлены дважды (${file})`);
	}

	PARTS.set(part.key, part);
}

for (const module of INSTALLED_MODULES) {
	const loads = PARTS.get(module.key)?.loads ?? {};
	const missing = module.sections
		.filter((section) => !Object.hasOwn(loads, section.key))
		.map((section) => `«${section.key}»`);

	if (missing.length > 0) {
		throw new Error(
			`Модуль «${module.key}» объявил в манифесте разделы без загрузчика в sections.server.ts: ${missing.join(', ')}`
		);
	}
}

/**
 * Данные страницы раздела. Проверки — раздел есть, право есть, модуль
 * действует — делает диспетчер до вызова; незнакомый раздел здесь — ошибка
 * вызывающего, а не адрес, набранный руками.
 */
export async function loadModuleSection(
	module: ModuleKey,
	section: string,
	input: {
		event: RequestEvent<SectionRouteParams>;
		ctx: ActorContext;
		workspace: SectionWorkspace;
		rest: readonly string[];
	}
): Promise<unknown> {
	const loads = PARTS.get(module)?.loads ?? {};

	if (!Object.hasOwn(loads, section)) {
		throw new Error(`У модуля «${module}» нет загрузчика раздела «${section}»`);
	}

	return loads[section](input);
}
