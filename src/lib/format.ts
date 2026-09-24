/**
 * Formatting for everything the interface shows to a Russian-speaking user:
 * dates, figures and word forms. Components never build these strings
 * themselves, so a date looks the same in a table cell, in a card and in a
 * toast.
 */
import { MOSCOW_OFFSET_MS } from '$lib/contracts/calendar';

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

const timeFormat = new Intl.DateTimeFormat('ru-RU', {
	timeZone: TIME_ZONE,
	hour: '2-digit',
	minute: '2-digit'
});

const monthDayFormat = new Intl.DateTimeFormat('ru-RU', {
	timeZone: TIME_ZONE,
	day: 'numeric',
	month: 'long'
});

/**
 * `en-CA` is the shortest way to ask `Intl` for `yyyy-mm-dd`: the calendar day
 * as the schemas, the database and the `date` inputs of the browser spell it.
 */
const isoDayFormat = new Intl.DateTimeFormat('en-CA', {
	timeZone: TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
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

/** `14:05` — the time of day alone, for an event of the same working session. */
export function formatTime(value: DateInput): string {
	return timeFormat.format(toDate(value));
}

/** `12 сентября` — for headings and timelines, where the year is already known. */
export function formatDayAndMonth(value: DateInput): string {
	return monthDayFormat.format(toDate(value));
}

/**
 * `2026-09-12` — the calendar day in Moscow, the form every schema, column and
 * date control stores. The zone matters: at 01:00 Moscow the machine clock in
 * UTC still says yesterday, and a plan that starts "today" would be dated a day
 * back for everyone who reads it.
 */
export function formatIsoDay(value: DateInput = Date.now()): string {
	return isoDayFormat.format(toDate(value));
}

/** `12.09.2026`, exactly as {@link formatDate} writes it. */
const RU_DAY = /^(\d{2})\.(\d{2})\.(\d{4})$/;

/**
 * The reverse of {@link formatDate} for a typed-in day: `12.09.2026` becomes
 * `2026-09-12`, and anything else becomes `null`. A half-typed or impossible
 * date is not an error worth throwing — the field simply has no value yet —
 * but it must not silently become another day either, which is what `new Date`
 * does with `31.02`.
 */
export function parseRuDay(text: string): string | null {
	const match = RU_DAY.exec(text.trim());

	if (match === null) {
		return null;
	}

	const [, day, month, year] = match;
	const iso = `${year}-${month}-${day}`;
	const date = new Date(`${iso}T00:00:00Z`);

	if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) {
		return null;
	}

	return iso;
}

/** `1 234 567`, with the non-breaking group separator Russian typography uses. */
export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		throw new RangeError(`Не удалось отформатировать число: ${String(value)}`);
	}

	return numberFormat.format(value);
}

/**
 * Sizes people read: `2,3 МБ`, not `2 411 059 байт`. The unit is the one a
 * Russian file manager shows, and the step is 1024 — the same one the storage
 * limit is written in.
 */
const SIZE_UNITS = ['Б', 'КБ', 'МБ'] as const;
const sizeFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) {
		throw new RangeError(`Не удалось отформатировать размер: ${String(bytes)}`);
	}

	let value = bytes;
	let unit = 0;

	while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}

	return `${sizeFormat.format(value)} ${SIZE_UNITS[unit]}`;
}

// Moscow keeps a fixed +03:00 offset, so a calendar day starts at a fixed
// instant and the day a deadline falls on is plain arithmetic. The offset itself
// is declared once, in `$lib/contracts/calendar`: screen figures and file
// figures have to agree.
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
