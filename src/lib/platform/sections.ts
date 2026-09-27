/**
 * Страницы модуля: пункты меню пространства, которые приносит модуль. Модуль
 * объявляет в манифесте раздел (`sections`: ключ, подпись, право), а в своём
 * `sections.ts` через `defineSectionsUi` — чем его рисовать: компонент страницы
 * и значок пункта. Реестр (`sections-registry.ts`) собирает их со всех
 * установленных модулей, диспетчер ядра (`src/routes/(app)/w/[workspace]/m/…`)
 * открывает страницу по адресу `/w/<пространство>/m/<модуль>/<раздел>`.
 *
 * Здесь нет `import.meta.glob`: объявление живёт отдельно от реестра, иначе
 * `sections.ts` модуля и реестр импортировали бы друг друга.
 */
import type { Component } from 'svelte';
import type { LucideIcon } from '$lib/icon';
import type { ModuleManifest } from './define';

/** Пространство, в котором открыта страница модуля. */
export type SectionWorkspace = {
	id: string;
	key: string;
	name: string;
	/** Действующие модули пространства: включённые и нужные стадиям процесса. */
	modules: readonly string[];
};

/**
 * Пропсы страницы модуля. Шапку и крошки рисует диспетчер ядра — одинаково со
 * всеми страницами пространства; страница модуля рисует только своё тело.
 */
export type SectionPageProps = {
	/** Что вернул загрузчик раздела из `sections.server.ts` модуля. */
	data: unknown;
	workspace: SectionWorkspace;
};

export type SectionUi = {
	component: Component<SectionPageProps>;
	/** Значок пункта в меню пространства. */
	icon: LucideIcon;
	/** Пояснение под заголовком страницы: что на ней и зачем. */
	description?: string;
};

export type SectionsUi<M extends ModuleManifest> = {
	[K in M['sections'][number]['key']]: SectionUi;
};

/** Страницы модуля — то, что `sections.ts` модуля отдаёт по умолчанию. */
export type SectionsUiPart<M extends ModuleManifest = ModuleManifest> = {
	key: M['key'];
	sections: SectionsUi<M>;
};

/**
 * Страницы модуля. Связь с манифестом проверяет компилятор: у каждого раздела
 * из манифеста должен быть компонент, лишний ключ — ошибка.
 */
export function defineSectionsUi<const M extends ModuleManifest>(
	manifest: M,
	sections: SectionsUi<M>
): SectionsUiPart<M> {
	return Object.freeze({ key: manifest.key, sections });
}
