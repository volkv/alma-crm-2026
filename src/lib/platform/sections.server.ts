/**
 * Серверная часть страниц модуля: загрузчик на каждый раздел из манифеста.
 *
 * Здесь только объявление и типы — без `import.meta.glob`. Модули собирает
 * `sections-registry.server.ts`, а диспетчер ядра зовёт загрузчик уже после
 * своих проверок: раздел есть, право у человека есть, модуль действует в
 * пространстве. Сам загрузчик их не повторяет, но данные читает под правами
 * вызывающего — сервисы ядра сужают выборку областью доступа сами.
 */
import type { RequestEvent } from '@sveltejs/kit';
import type { ActorContext } from '$lib/server/actor';
import type { ModuleManifest } from './define';
import type { SectionWorkspace } from './sections';

/** Параметры адреса страницы модуля: `/w/<пространство>/m/<модуль>/<раздел>/…`. */
export type SectionRouteParams = { workspace: string; module: string; path: string };

/**
 * Загрузчик раздела. Что он вернёт, получит компонент страницы в `data`;
 * значение уезжает в браузер, поэтому годится только то, что сериализуется.
 */
export type SectionLoad = (input: {
	event: RequestEvent<SectionRouteParams>;
	ctx: ActorContext;
	workspace: SectionWorkspace;
	/**
	 * Сегменты адреса после ключа раздела. Раздел без вложенных страниц
	 * отвечает на лишний сегмент 404 сам: диспетчер не знает, что внутри.
	 */
	rest: readonly string[];
}) => Promise<unknown>;

export type SectionsServer<M extends ModuleManifest> = {
	[K in M['sections'][number]['key']]: SectionLoad;
};

export type SectionsServerPart<K extends string = string> = {
	key: K;
	loads: Readonly<Record<string, SectionLoad>>;
};

/**
 * Загрузчики страниц модуля. Манифест передаётся целиком: ключ модуля берётся
 * из него, а у каждого раздела манифеста должен быть загрузчик — пропуск или
 * лишний ключ ловит компилятор.
 */
export function defineSectionsServer<const M extends ModuleManifest>(
	manifest: M,
	loads: SectionsServer<M>
): SectionsServerPart<M['key']> {
	return Object.freeze({ key: manifest.key, loads });
}
