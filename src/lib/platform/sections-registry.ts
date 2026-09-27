/**
 * Реестр страниц модулей: компоненты и значки из `sections.ts` установленных
 * модулей и пункты меню, которые из них получаются.
 *
 * Импорт жадный и статический: сервер рисует страницу модуля в первом же
 * ответе, а ленивая загрузка оставила бы её пустой до гидратации. Часть
 * модуля, которого нет в `crm.config.ts`, отбрасывается — без строки в конфиге
 * модуля как будто нет, даже если папка на месте.
 *
 * Полноту проверяет сама загрузка реестра: раздел из манифеста без компонента
 * роняет сборку, а не оставляет в меню пункт, который ведёт в пустоту —
 * на страницу без тела.
 */
import type { Component } from 'svelte';
import type { LucideIcon } from '$lib/icon';
import type { PermissionKey } from '$lib/server/rbac/permissions';
import type { SectionPageProps, SectionUi, SectionsUiPart } from './sections';
import { INSTALLED_MODULES, isModuleKey, type ModuleKey } from './registry';

const found = import.meta.glob<{ default: SectionsUiPart }>(
	['/src/modules/*/sections.ts', '/src/modules/custom/*/sections.ts'],
	{ eager: true }
);

const PARTS = new Map<ModuleKey, SectionsUiPart>();

for (const [file, loaded] of Object.entries(found)) {
	const part = loaded.default;

	if (!isModuleKey(part.key)) {
		continue;
	}

	if (PARTS.has(part.key)) {
		throw new Error(`Страницы модуля «${part.key}» объявлены дважды (${file})`);
	}

	PARTS.set(part.key, part);
}

for (const module of INSTALLED_MODULES) {
	const sections: Readonly<Record<string, SectionUi | undefined>> =
		PARTS.get(module.key)?.sections ?? {};
	const missing = module.sections
		.filter((section) => sections[section.key] === undefined)
		.map((section) => `«${section.key}»`);

	if (missing.length > 0) {
		throw new Error(
			`Модуль «${module.key}» объявил в манифесте, но не нарисовал в sections.ts разделы: ${missing.join(', ')}`
		);
	}
}

/** Пункт меню пространства, ведущий на страницу модуля. */
export type ModuleNavSection = {
	href: string;
	label: string;
	icon: LucideIcon;
	permission: PermissionKey | null;
	module: ModuleKey;
	section: string;
};

/**
 * Пункты меню пространства от его действующих модулей: в порядке конфига, а
 * внутри модуля — в порядке манифеста. Недействующий модуль пунктов не даёт:
 * его страница ответила бы 404, а меню не обещает того, чего нет.
 */
export function moduleNavSections(workspace: {
	key: string;
	modules?: readonly string[];
}): ModuleNavSection[] {
	const active = workspace.modules ?? [];

	return INSTALLED_MODULES.filter((module) => active.includes(module.key)).flatMap((module) =>
		module.sections.flatMap((section) => {
			const ui = moduleSectionUi(module.key, section.key);

			return ui === null
				? []
				: [
						{
							href: `/w/${workspace.key}/m/${module.key}/${section.key}`,
							label: section.label,
							icon: ui.icon,
							permission: section.permission,
							module: module.key,
							section: section.key
						}
					];
		})
	);
}

/** Как рисовать раздел модуля; `null` — такого модуля или раздела в установке нет. */
export function moduleSectionUi(module: string, section: string): SectionUi | null {
	if (!isModuleKey(module)) {
		return null;
	}

	const sections: Readonly<Record<string, SectionUi | undefined>> =
		PARTS.get(module)?.sections ?? {};

	return Object.hasOwn(sections, section) ? (sections[section] ?? null) : null;
}

/** Компонент страницы раздела модуля; `null` — такого модуля или раздела нет. */
export function moduleSectionComponent(
	module: string,
	section: string
): Component<SectionPageProps> | null {
	return moduleSectionUi(module, section)?.component ?? null;
}
