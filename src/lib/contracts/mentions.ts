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

/** Сколько знаков комментария видно в строке колокольчика. */
const EXCERPT_LENGTH = 120;

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
/** Цифры через пробелы, скобки и дефисы; телефоном считается от десяти цифр. */
const PHONE_CANDIDATE = /\+?\d[\d\s()-]{8,}\d/g;
const PHONE_DIGITS = 10;

/**
 * Начало комментария для строки колокольчика: одной строкой, упоминания —
 * именами, без токенов, почта и телефоны скрыты. Колокольчик открыт на
 * любом экране, и чужие контакты, вписанные в комментарий, с него не читаются
 * — их видно в самой карточке.
 */
export function mentionExcerpt(body: string): string {
	const text = splitMentions(body)
		.map((segment) => (segment.kind === 'mention' ? `@${segment.label}` : segment.text))
		.join('')
		.replace(EMAIL, '[почта скрыта]')
		.replace(PHONE_CANDIDATE, (candidate) =>
			candidate.replace(/\D/g, '').length >= PHONE_DIGITS ? '[телефон скрыт]' : candidate
		)
		.replace(/\s+/g, ' ')
		.trim();

	return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text;
}
