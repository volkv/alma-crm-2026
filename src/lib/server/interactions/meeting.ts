/**
 * Приглашение на встречу файлом календаря — RFC 5545, `METHOD:REQUEST`.
 *
 * Сборка текста — чистая функция без базы, прав и HTTP: что именно идёт в файл
 * (кого пускать в `ATTENDEE`, а кого — только по имени в повестку), решает
 * маршрут раздачи (`meeting.ics/+server.ts`), который знает про права на
 * персональные данные. Здесь только формат: экранирование текста, перенос
 * строк по 75 октетам и структура события, — поэтому он проверяется юнит-тестом
 * без testcontainers.
 */

import { createHash } from 'node:crypto';

/** Предел строки контента по RFC 5545 (раздел 3.1) — октеты, не символы. */
const FOLD_LIMIT_OCTETS = 75;

const PRODID = '-//Альма CRM//Meeting Invite//RU';

/** Домен для `UID`: у продукта нет публичного каталога вида `@lct-crm.local`, но тот же вид уже носят демонстрационные почты сотрудников. */
const UID_DOMAIN = 'lct-crm.local';

const encoder = new TextEncoder();

/** Участник с открытой почтой: попадает в файл свойством `ATTENDEE`. */
export type MeetingAttendee = { name: string; email: string };

export type MeetingInviteInput = {
	/** Устойчивый идентификатор события — см. {@link meetingInviteUid}. */
	uid: string;
	/** Заголовок встречи. */
	summary: string;
	/** Повестка; переносы строк экранируются как `\n` по тексту RFC. */
	agenda: string;
	/** Место или ссылка; `null` — не указано. */
	location: string | null;
	/** Начало встречи — точный момент времени (уже переведённый из Europe/Moscow в UTC). */
	start: Date;
	durationMinutes: number;
	organizer: MeetingAttendee;
	/** Участники с открытой почтой. */
	attendeesWithEmail: readonly MeetingAttendee[];
	/**
	 * Участники без почты: нет права видеть контакты стороны или почта не
	 * указана. `ATTENDEE` требует адрес (`CAL-ADDRESS`), поэтому в файл они
	 * попадают не свойством события, а именем в тексте повестки.
	 */
	attendeeNamesWithoutEmail: readonly string[];
	/** Момент генерации файла — `DTSTAMP`. */
	generatedAt: Date;
};

function pad(value: number, width = 2): string {
	return String(value).padStart(width, '0');
}

/** Момент времени в форме ics-в-UTC: `20261005T140000Z`. */
export function formatIcsInstant(date: Date): string {
	return (
		`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
		`T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
	);
}

/**
 * Экранирование текстового значения (RFC 5545, 3.3.11): обратная косая черта —
 * первой заменой, иначе она задвоит экранирование следующих символов.
 */
export function escapeIcsText(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r\n|\r|\n/g, '\\n');
}

/** Значение параметра (`CN=`): кавычки заменяются, спецсимволы требуют кавычек вокруг всего значения. */
function escapeIcsParam(value: string): string {
	const cleaned = value.replace(/"/g, "'");

	return /[,;:]/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

function utf8Octets(char: string): number {
	return encoder.encode(char).length;
}

/**
 * Перенос длинной строки по 75 октетам (RFC 5545, 3.1): каждая физическая
 * строка кончается `CRLF`, продолжение начинается с одного пробела — он тоже
 * входит в лимит той строки, — и разрез никогда не приходится на середину
 * символа (считаем по кодовым точкам, а не по UTF-16 code units).
 */
export function foldIcsLine(line: string): string {
	const codePoints = Array.from(line);
	const physicalLines: string[] = [];
	let current = '';
	let currentOctets = 0;

	for (const char of codePoints) {
		const octets = utf8Octets(char);

		if (current !== '' && currentOctets + octets > FOLD_LIMIT_OCTETS) {
			physicalLines.push(current);
			current = ` ${char}`;
			currentOctets = 1 + octets;
			continue;
		}

		current += char;
		currentOctets += octets;
	}

	physicalLines.push(current);

	return physicalLines.join('\r\n');
}

function simpleLine(name: string, value: string): string {
	return foldIcsLine(`${name}:${value}`);
}

function organizerLine(organizer: MeetingAttendee): string {
	return foldIcsLine(`ORGANIZER;CN=${escapeIcsParam(organizer.name)}:mailto:${organizer.email}`);
}

function attendeeLine(attendee: MeetingAttendee): string {
	const cn = escapeIcsParam(attendee.name);

	return foldIcsLine(
		`ATTENDEE;CN=${cn};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee.email}`
	);
}

/** Повестка вместе с именами участников без почты — им место только здесь, не в `ATTENDEE`. */
function buildDescription(input: MeetingInviteInput): string {
	const parts = [input.agenda.trim()];

	if (input.attendeeNamesWithoutEmail.length > 0) {
		parts.push(
			`Без адреса в приглашении (нет права видеть контакты или почта не указана): ${input.attendeeNamesWithoutEmail.join(', ')}`
		);
	}

	return parts.filter((part) => part !== '').join('\n\n');
}

/**
 * Собирает файл приглашения целиком.
 *
 * `METHOD:REQUEST` — это приглашение, а не запись «для себя»: календарь
 * получателя предложит принять или отклонить, а не просто добавит в сетку.
 */
export function buildMeetingInvite(input: MeetingInviteInput): string {
	const start = formatIcsInstant(input.start);
	const end = formatIcsInstant(new Date(input.start.getTime() + input.durationMinutes * 60_000));
	const description = buildDescription(input);

	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		simpleLine('PRODID', PRODID),
		'CALSCALE:GREGORIAN',
		'METHOD:REQUEST',
		'BEGIN:VEVENT',
		simpleLine('UID', input.uid),
		simpleLine('DTSTAMP', formatIcsInstant(input.generatedAt)),
		simpleLine('DTSTART', start),
		simpleLine('DTEND', end),
		'SEQUENCE:0',
		simpleLine('SUMMARY', escapeIcsText(input.summary)),
		simpleLine('DESCRIPTION', escapeIcsText(description)),
		...(input.location !== null && input.location.trim() !== ''
			? [simpleLine('LOCATION', escapeIcsText(input.location))]
			: []),
		organizerLine(input.organizer),
		...input.attendeesWithEmail.map(attendeeLine),
		'STATUS:CONFIRMED',
		'TRANSP:OPAQUE',
		'END:VEVENT',
		'END:VCALENDAR'
	];

	return lines.join('\r\n') + '\r\n';
}

/**
 * `UID` стабилен для одной записи и одного времени встречи: повторное
 * скачивание того же приглашения обновляет то же событие в календаре
 * получателя, а не заводит рядом второе. Другое время — уже другая встреча и
 * другой `UID`.
 */
export function meetingInviteUid(
	interactionId: string,
	start: Date,
	durationMinutes: number
): string {
	const hash = createHash('sha256')
		.update(`${interactionId}|${start.toISOString()}|${durationMinutes}`)
		.digest('hex')
		.slice(0, 32);

	return `meeting-${hash}@${UID_DOMAIN}`;
}
