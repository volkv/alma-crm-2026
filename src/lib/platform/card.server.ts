/**
 * Серверная часть карточки взаимодействия, которую приносит модуль: действия
 * форм, файлы по ссылке из карточки, загрузка своих данных и обработчики
 * писем вузу, которые модуль ставит в общую очередь.
 *
 * Здесь только объявление и типы — без `import.meta.glob`. Модули собирает
 * `card-registry.server.ts`: он же оборачивает каждое действие и файл проверкой
 * «модуль действует в пространстве дела», поэтому сам модуль её не пишет.
 */
import type { ActionFailure, RequestEvent } from '@sveltejs/kit';
import type { InteractionView } from '$lib/contracts/interactions';
import type { ActorContext } from '$lib/server/actor';
import type { OutboundMailHandler } from '$lib/server/mail/queue';
import type { ModuleManifest } from './define';

/** Значение, которым список формы обозначает «ничего не выбрано». */
export { NO_OPTION } from '$lib/components/directory/labels';

/** Параметры адреса карточки: пространство и взаимодействие. */
export type CardRouteParams = { workspace: string; id: string };

/**
 * Действие формы карточки. Имя действия — то, что стоит в `action="?/…"`:
 * оно общее с действиями ядра на одной странице, поэтому совпадать с ними и
 * с действиями других модулей не должно.
 */
export type CardActionHandler = (
	event: RequestEvent<CardRouteParams>
) => Promise<Record<string, unknown> | ActionFailure<Record<string, unknown>>>;

/** Файл карточки: `…/interactions/<id>/files/<модуль>/<файл>`. */
export type CardFileHandler = (
	event: RequestEvent<CardRouteParams & { module: string; file: string }>
) => Promise<Response>;

/**
 * Свои данные модуля для карточки. Зовётся только у модулей, действующих в
 * пространстве дела; результат лежит в `data.moduleData[<ключ модуля>]`.
 * Область доступа к делу уже проверена: `interaction` прочитан загрузчиком
 * карточки под правами того, кто её открыл.
 */
export type CardLoad = (input: {
	event: RequestEvent<CardRouteParams>;
	ctx: ActorContext;
	interaction: InteractionView;
}) => Promise<unknown>;

/**
 * Письма вузу, которые модуль ставит в общую очередь (`mail/queue.ts`): вид
 * письма → обработчик. Вид в очереди — `<модуль>:<вид>`, и найти обработчик
 * по нему очередь просит реестр.
 */
export type CardMailHandlers = Record<string, OutboundMailHandler>;

export type CardServer = {
	actions: Record<string, CardActionHandler>;
	files: Record<string, CardFileHandler>;
	load: CardLoad | null;
	mail?: CardMailHandlers;
};

export type CardServerPart<K extends string = string> = CardServer & { key: K };

/**
 * Серверная часть карточки модуля. Манифест передаётся целиком, чтобы ключ
 * модуля брался из него, а не писался второй раз строкой.
 */
export function defineCardServer<const M extends ModuleManifest>(
	manifest: M,
	server: CardServer
): CardServerPart<M['key']> {
	return { key: manifest.key, ...server };
}
