/**
 * Живая карточка взаимодействия: что сервер присылает открытой карточке.
 *
 * Событие называет только **что** случилось и идентификатор, но не несёт
 * данных дела: текст комментария, стороны и контакты карточка перечитывает
 * своим обычным загрузчиком — с правами того, кто смотрит, а не того, кто
 * изменил. Одно сообщение, собранное для автора изменения и разосланное всем,
 * раздало бы его права на персональные данные каждому зрителю.
 */
import { z } from 'zod';

/** Кем человек приходится делу — подпись под его аватаркой. */
export const LIVE_RELATIONS = ['responsible', 'lead', 'member', 'admin'] as const;
export type LiveRelation = (typeof LIVE_RELATIONS)[number];

export const LIVE_RELATION_LABELS: Record<LiveRelation, string> = {
	responsible: 'ответственный',
	lead: 'руководитель',
	member: 'в пространстве',
	admin: 'администратор'
};

/**
 * Человек в составе карточки: у кого есть доступ к делу и кто её сейчас
 * смотрит. Одна запись на учётную запись: демонстрационной учёткой пользуются
 * несколько человек сразу, и их вкладки собраны в число `online`.
 */
export type LivePerson = {
	userId: string;
	/** Имя из справочника пользователей, а не то, что прислал браузер. */
	name: string;
	/** `null` — в карточке, но в списке доступа ещё нет (он обновляется раз в полминуты). */
	relation: LiveRelation | null;
	/** Сколько вкладок этой учётной записи сейчас в карточке. */
	online: number;
	/** Среди них — эта вкладка. Узнаётся по вкладке, а не по учётной записи. */
	you: boolean;
	/** Открыта форма правки полей дела — у одной из вкладок этой учётной записи. */
	editing: boolean;
};

/**
 * Что человек делает в карточке прямо сейчас: набирает комментарий или
 * правит поля дела. Сигнал шлёт браузер, срок держит сервер.
 */
export const LIVE_ACTIVITIES = ['typing', 'editing'] as const;
export type LiveActivityKind = (typeof LIVE_ACTIVITIES)[number];

/** Тело сигнала: начал (или всё ещё) — `active: true`, закончил — `false`. */
export const liveActivitySchema = z.object({
	kind: z.enum(LIVE_ACTIVITIES),
	active: z.boolean()
});

export type LiveActivitySignal = z.infer<typeof liveActivitySchema>;

/**
 * Сроки сигналов. «Печатает» живёт {@link TYPING_TTL_MS} и продлевается набором
 * не чаще раза в {@link TYPING_REFRESH_MS}; открытая форма правки подтверждает
 * себя раз в {@link EDITING_REFRESH_MS} и без подтверждения гаснет через
 * {@link EDITING_TTL_MS}. Одни числа на сервер и браузер: зритель гасит
 * «печатает» сам, если за срок не пришло ни одного подтверждения.
 */
export const TYPING_TTL_MS = 6_000;
export const TYPING_REFRESH_MS = 2_500;
/** Без ввода столько — набор кончился, сигнал гасится сразу, не дожидаясь срока. */
export const TYPING_IDLE_MS = 5_000;
export const EDITING_TTL_MS = 45_000;
export const EDITING_REFRESH_MS = 15_000;

/**
 * Сообщения потока карточки — имя события SSE и его данные.
 *
 * - `hello` — поток открыт;
 * - `roster` — состав: доступ к делу и присутствие;
 * - `typing` — кто сейчас набирает комментарий (идентификаторы учётных записей,
 *   без своей сессии); список заменяет прежний и гаснет у зрителя через
 *   {@link TYPING_TTL_MS}, если не подтверждён новым;
 * - `comment.added` — появился комментарий;
 * - `interaction.changed` — дело изменилось, карточку пора перечитать;
 * - `resync` — сервер мог пропустить события (обрыв связи с шиной), и карточку
 *   тоже пора перечитать;
 * - `bye` — поток закрыт сервером: сессия кончилась или доступа к делу больше
 *   нет. Переподключаться незачем.
 */
export type LiveMessage =
	| { event: 'hello'; data: Record<string, never> }
	| { event: 'roster'; data: { people: LivePerson[] } }
	| { event: 'typing'; data: { userIds: string[] } }
	| { event: 'comment.added'; data: { commentId: string } }
	| { event: 'interaction.changed'; data: Record<string, never> }
	| { event: 'resync'; data: Record<string, never> }
	| { event: 'bye'; data: { reason: 'session' | 'access' } };

/** События шины между процессами: только тип и идентификаторы. */
export const liveEventSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('comment.added'), commentId: z.uuid() }),
	z.object({ type: z.literal('interaction.changed') }),
	z.object({ type: z.literal('presence') }),
	z.object({ type: z.literal('activity'), kind: z.enum(LIVE_ACTIVITIES) })
]);

export type LiveEvent = z.infer<typeof liveEventSchema>;

/** Ключ, по которому живая карточка просит перечитать свой загрузчик. */
export function interactionCardDependency(interactionId: string): `app:${string}` {
	return `app:interaction-card:${interactionId}`;
}
