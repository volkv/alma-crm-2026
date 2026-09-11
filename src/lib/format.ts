/**
 * Formatting for everything the interface shows to a Russian-speaking user:
 * dates, figures and word forms. Components never build these strings
 * themselves, so a date looks the same in a table cell, in a card and in a
 * toast.
 */

/**
 * The operator works on Moscow time, and so do the deadlines in the process it
 * runs. Pinning the zone also means a date renders identically on the server, in
 * the browser and in a test, whatever the machine's own zone is.
 */
const TIME_ZONE = 'Europe/Moscow';

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
	timeZone: TIME_ZONE,
	day: '2-digit',
	month: '2-digit',
	year: 'numeric'
});

const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', {
	timeZone: TIME_ZONE,
	day: '2-digit',
	month: '2-digit',
	year: 'numeric',
	hour: '2-digit',
	minute: '2-digit'
});

const monthDayFormat = new Intl.DateTimeFormat('ru-RU', {
	timeZone: TIME_ZONE,
	day: 'numeric',
	month: 'long'
});

const numberFormat = new Intl.NumberFormat('ru-RU');

/** Anything that can carry a moment in time before it is formatted. */
export type DateInput = Date | string | number;

function toDate(value: DateInput): Date {
	const date = value instanceof Date ? value : new Date(value);

	if (Number.isNaN(date.getTime())) {
		throw new RangeError(`Не удалось разобрать дату: ${String(value)}`);
	}

	return date;
}

/** `12.09.2026` — the form used in tables, lists and document titles. */
export function formatDate(value: DateInput): string {
	return dateFormat.format(toDate(value));
}

/** `12.09.2026, 14:05` — for events, where the time of day matters. */
export function formatDateTime(value: DateInput): string {
	return dateTimeFormat.format(toDate(value));
}

/** `12 сентября` — for headings and timelines, where the year is already known. */
export function formatDayAndMonth(value: DateInput): string {
	return monthDayFormat.format(toDate(value));
}

/** `1 234 567`, with the non-breaking group separator Russian typography uses. */
export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		throw new RangeError(`Не удалось отформатировать число: ${String(value)}`);
	}

	return numberFormat.format(value);
}

/**
 * Moscow keeps a fixed +03:00 offset, so a calendar day starts at a fixed
 * instant and the day a deadline falls on is plain arithmetic.
 */
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function moscowDayNumber(value: DateInput): number {
	return Math.floor((toDate(value).getTime() + MOSCOW_OFFSET_MS) / DAY_MS);
}

/**
 * Whole calendar days from `now` until `deadline`: `0` means today, negative
 * means overdue. Counting calendar days rather than 24-hour spans is what a
 * deadline means to the person reading it — a due date of today is "today"
 * whether it is 09:00 or 18:00.
 */
export function daysUntil(deadline: DateInput, now: DateInput = Date.now()): number {
	return moscowDayNumber(deadline) - moscowDayNumber(now);
}

/**
 * The three Russian word forms a count selects between, in the order
 * `1 день` / `2 дня` / `5 дней`.
 */
export type PluralForms = readonly [one: string, few: string, many: string];

/**
 * Picks the word form for a count. Only the form is returned, so a caller that
 * renders the number separately (a badge, a chip) is not forced to re-parse the
 * string.
 */
export function pluralForm(count: number, forms: PluralForms): string {
	const absolute = Math.abs(Math.trunc(count));
	const lastTwo = absolute % 100;
	const last = absolute % 10;

	if (lastTwo >= 11 && lastTwo <= 14) return forms[2];
	if (last === 1) return forms[0];
	if (last >= 2 && last <= 4) return forms[1];

	return forms[2];
}

/** `5 дней` — the count and its word form, ready to drop into a sentence. */
export function pluralize(count: number, forms: PluralForms): string {
	return `${formatNumber(count)} ${pluralForm(count, forms)}`;
}

/**
 * The one or two letters an avatar shows: the first letters of the first two
 * words of the name. An empty name has no initials, and that is not an error —
 * the avatar simply falls back to its icon.
 */
export function initials(fullName: string): string {
	return fullName
		.split(/\s+/)
		.filter((part) => part.length > 0)
		.slice(0, 2)
		.map((part) => part[0].toLocaleUpperCase('ru-RU'))
		.join('');
}
