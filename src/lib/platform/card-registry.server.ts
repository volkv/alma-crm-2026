/**
 * Серверные части карточки от установленных модулей: действия форм, файлы и
 * загрузка данных. Импорт жадный и статический — действия нужны странице при
 * первом же запросе, а ошибка поставки (два модуля с одним действием) должна
 * всплыть при запуске, а не на нажатии кнопки.
 *
 * Проверка «модуль действует в пространстве дела» стоит здесь, в слое
 * маршрута, а не в сервисах ядра: те же сервисы зовут сид, фоновые задачи и
 * проверки, которым до модулей пространства дела нет.
 */
import { error, type RequestEvent } from '@sveltejs/kit';
import type { InteractionView } from '$lib/contracts/interactions';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { toActionFailure, toPageError } from '$lib/server/http';
import type { OutboundMailHandler } from '$lib/server/mail/queue';
import { assertModuleActive } from '$lib/server/platform/workspace-modules';
import type { CardActionHandler, CardRouteParams, CardServerPart } from './card.server';
import { isModuleKey, type ModuleKey } from './registry';

const parts = import.meta.glob<{ default: CardServerPart }>(
	['/src/modules/*/card.server.ts', '/src/modules/custom/*/card.server.ts'],
	{ eager: true }
);

type InstalledPart = CardServerPart<ModuleKey>;

/**
 * Части модулей, которые есть в установке. Папка модуля без строки в
 * `crm.config.ts` не подключена: её действия и файлы странице не видны.
 */
const INSTALLED_PARTS: readonly InstalledPart[] = Object.values(parts)
	.map((file) => file.default)
	.filter((part): part is InstalledPart => isModuleKey(part.key));

const PARTS_BY_KEY = new Map<string, InstalledPart>(
	INSTALLED_PARTS.map((part) => [part.key, part])
);

/**
 * Действия модулей для страницы карточки, каждое за проверкой «модуль
 * действует». Отказ проверки — отказ формы тем же языком, что у действий
 * ядра (`toActionFailure`): недействующий модуль — 400 со словами, чужое дело —
 * 404, как у любого действия над ним.
 *
 * Совпадение имени с действием ядра или другого модуля — ошибка поставки:
 * одно действие молча перекрыло бы другое.
 */
export function moduleCardActionHandlers(
	coreActionNames: readonly string[]
): Record<string, CardActionHandler> {
	const owners = new Map<string, string>(coreActionNames.map((name) => [name, 'ядро']));
	const handlers: Record<string, CardActionHandler> = {};

	for (const part of INSTALLED_PARTS) {
		for (const [name, handler] of Object.entries(part.actions)) {
			const owner = owners.get(name);

			if (owner !== undefined) {
				throw new Error(
					`Действие карточки «${name}» объявляют двое: «${owner}» и модуль «${part.key}»`
				);
			}

			owners.set(name, `модуль «${part.key}»`);
			handlers[name] = async (event) => {
				try {
					await assertModuleActive(actorFromEvent(event), event.params.id, part.key);
				} catch (cause) {
					return toActionFailure(cause);
				}

				return handler(event);
			};
		}
	}

	return handlers;
}

/**
 * Файл модуля по ссылке из карточки. Незнакомый модуль или файл — 404, как
 * незнакомый адрес; недействующий модуль и чужое дело — страница ошибки с
 * текстом проверки.
 */
export async function serveModuleFile(
	event: RequestEvent<CardRouteParams & { module: string; file: string }>
): Promise<Response> {
	const part = PARTS_BY_KEY.get(event.params.module);
	const handler = part?.files[event.params.file];

	if (part === undefined || handler === undefined) {
		error(404, 'Такого файла у карточки нет');
	}

	try {
		await assertModuleActive(actorFromEvent(event), event.params.id, part.key);
	} catch (cause) {
		toPageError(cause);
	}

	return handler(event);
}

/**
 * Данные модулей для карточки: `load` зовётся только у действующих модулей,
 * данные выключенного не читаются вовсе.
 */
export async function loadModuleCardData(
	event: RequestEvent<CardRouteParams>,
	ctx: ActorContext,
	interaction: InteractionView,
	active: readonly ModuleKey[]
): Promise<Record<string, unknown>> {
	const loaded = await Promise.all(
		INSTALLED_PARTS.flatMap(({ key, load }) =>
			load !== null && active.includes(key)
				? [load({ event, ctx, interaction }).then((data) => [key, data] as const)]
				: []
		)
	);

	return Object.fromEntries(loaded);
}

/**
 * Обработчик письма модуля по виду задания очереди (`<модуль>:<вид>`);
 * `null` — такого модуля или вида в установке нет.
 *
 * Обработчик обёрнут той же проверкой, что действия карточки: модуль, который
 * выключили в пространстве дела между нажатием и отправкой, писем от своего
 * имени больше не шлёт.
 */
export function moduleMailHandler(kind: string): OutboundMailHandler | null {
	const separator = kind.indexOf(':');
	const part = separator < 0 ? undefined : PARTS_BY_KEY.get(kind.slice(0, separator));
	const handler = part?.mail?.[kind.slice(separator + 1)];

	if (part === undefined || handler === undefined) {
		return null;
	}

	return {
		auditType: handler.auditType,
		deliver: async (ctx, job) => {
			await assertModuleActive(ctx, job.interactionId, part.key);

			return handler.deliver(ctx, job);
		}
	};
}
