/**
 * Упоминания сотрудников в комментариях к делу.
 *
 * В тексте комментария упоминание хранится токеном `@[Имя](идентификатор)`:
 * адресат — идентификатор пользователя, а не имя. Имена совпадают, меняются и
 * пишутся по-разному, а письмо и колокольчик обязаны найти ровно того, кого
 * выбрали из подсказки. Подпись в квадратных скобках — имя в момент
 * упоминания: по ней текст читается и там, где разметку не разбирают (выгрузка,
 * API), а карточка рисует на её месте плашку.
 *
 * Модуль общий для браузера и сервера: браузер собирает токен и раскладывает
 * текст на куски, сервер достаёт из текста адресатов. Список адресатов от
 * браузера сервер не принимает вовсе — только текст, который он разбирает сам.
 */
import { z } from 'zod';
import { id } from './common';

/**
 * Токен упоминания. Подпись — без скобок и перевода строки, идентификатор —
 * UUID. Флаг `g` обязателен: разбор идёт через `matchAll`.
 */
const MENTION_TOKEN =
	/@\[([^[\]\n]{1,120})\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

/** Сколько человек можно позвать одним комментарием. */
export const MAX_MENTIONS_PER_COMMENT = 10;

export type MentionSegment =
	{ kind: 'text'; text: string } | { kind: 'mention'; label: string; userId: string };

/** Текст комментария кусками: обычный текст и упоминания по порядку. */
export function splitMentions(body: string): MentionSegment[] {
	const segments: MentionSegment[] = [];
	let cursor = 0;

	for (const match of body.matchAll(MENTION_TOKEN)) {
		if (match.index > cursor) {
			segments.push({ kind: 'text', text: body.slice(cursor, match.index) });
		}

		segments.push({ kind: 'mention', label: match[1], userId: match[2].toLowerCase() });
		cursor = match.index + match[0].length;
	}

	if (cursor < body.length) {
		segments.push({ kind: 'text', text: body.slice(cursor) });
	}

	return segments;
}

/** Кого упомянули: идентификаторы без повторов в порядке первого упоминания. */
export function mentionedUserIds(body: string): { userId: string; label: string }[] {
	const seen = new Map<string, string>();

	for (const segment of splitMentions(body)) {
		if (segment.kind === 'mention' && !seen.has(segment.userId)) {
			seen.set(segment.userId, segment.label);
		}
	}

	return [...seen].map(([userId, label]) => ({ userId, label }));
}

/**
 * Токен для вставки в текст. Скобки и переводы строки из имени убираются: они
 * разорвали бы разметку, и упоминание превратилось бы в обычный текст.
 */
export function mentionToken(name: string, userId: string): string {
	const label = name.replace(/[[\]\n]/g, ' ').trim() || 'сотрудник';

	return `@[${label.slice(0, 120)}](${userId})`;
}

/**
 * Колокольчик текущего пользователя: сколько непрочитанных и последние
 * упоминания. Схема — для браузера: ответ приезжает JSON, и даты в нём
 * строками.
 */
export const mentionInboxSchema = z.object({
	unread: z.number().int().nonnegative(),
	items: z.array(
		z.object({
			id: z.uuid(),
			commentId: z.uuid(),
			interactionId: z.uuid(),
			/** Пространство дела: ссылка на карточку живёт под ним. */
			workspaceKey: z.string(),
			interactionTitle: z.string(),
			/** Кто упомянул — автор комментария. */
			authorName: z.string(),
			createdAt: z.coerce.date(),
			readAt: z.coerce.date().nullable()
		})
	)
});

export type MentionInbox = z.output<typeof mentionInboxSchema>;
export type MentionView = MentionInbox['items'][number];

/**
 * Что отметить прочитанным: одно упоминание (щелчок в колокольчике), все
 * упоминания в деле (карточка открыта) или всё сразу.
 */
export const markMentionsReadSchema = z.discriminatedUnion(
	'scope',
	[
		z.object({
			scope: z.literal('mention'),
			mentionId: id('Некорректный идентификатор упоминания')
		}),
		z.object({
			scope: z.literal('interaction'),
			interactionId: id('Некорректный идентификатор взаимодействия')
		}),
		z.object({ scope: z.literal('all') })
	],
	{ error: 'Не указано, что отметить прочитанным' }
);

export type MarkMentionsReadInput = z.output<typeof markMentionsReadSchema>;
