import { describe, expect, it } from 'vitest';
import {
	daysUntil,
	formatDate,
	formatDateTime,
	formatDayAndMonth,
	formatNumber,
	initials,
	pluralForm,
	pluralize
} from '$lib/format';

describe('formatDate', () => {
	it('renders a date as dd.mm.yyyy', () => {
		expect(formatDate('2026-09-12T10:00:00Z')).toBe('12.09.2026');
	});

	it('accepts a Date as well as a string', () => {
		expect(formatDate(new Date('2026-01-05T10:00:00Z'))).toBe('05.01.2026');
	});

	it('reads the instant in Moscow time, not in the machine time zone', () => {
		// 21:30 UTC on the 11th is already 00:30 on the 12th in Moscow.
		expect(formatDate('2026-09-11T21:30:00Z')).toBe('12.09.2026');
	});

	it('refuses an unparseable value instead of rendering "Invalid Date"', () => {
		expect(() => formatDate('вчера')).toThrow(RangeError);
	});
});

describe('formatDateTime', () => {
	it('adds the time of day in Moscow time', () => {
		expect(formatDateTime('2026-09-12T07:05:00Z')).toBe('12.09.2026, 10:05');
	});
});

describe('formatDayAndMonth', () => {
	it('spells the month out and drops the year', () => {
		expect(formatDayAndMonth('2026-09-12T10:00:00Z')).toBe('12 сентября');
	});
});

describe('formatNumber', () => {
	it('groups thousands with a non-breaking space', () => {
		expect(formatNumber(1234567)).toBe('1 234 567');
	});

	it('leaves small numbers alone', () => {
		expect(formatNumber(42)).toBe('42');
	});

	it('refuses a value that is not a finite number', () => {
		expect(() => formatNumber(Number.NaN)).toThrow(RangeError);
		expect(() => formatNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
	});
});

describe('daysUntil', () => {
	it('counts calendar days, not 24-hour spans', () => {
		// Late evening today to early morning tomorrow is one calendar day.
		expect(daysUntil('2026-09-13T05:00:00Z', '2026-09-12T20:00:00Z')).toBe(1);
	});

	it('returns zero for a deadline that falls on today', () => {
		expect(daysUntil('2026-09-12T20:00:00Z', '2026-09-12T05:00:00Z')).toBe(0);
	});

	it('returns a negative count for an overdue deadline', () => {
		expect(daysUntil('2026-09-09T09:00:00Z', '2026-09-12T09:00:00Z')).toBe(-3);
	});

	it('uses Moscow day boundaries', () => {
		// 21:30 UTC is already the next day in Moscow, so the deadline is today.
		expect(daysUntil('2026-09-12T10:00:00Z', '2026-09-11T21:30:00Z')).toBe(0);
	});
});

describe('pluralForm', () => {
	const days = ['день', 'дня', 'дней'] as const;

	it('uses the singular for 1 and for anything ending in 1', () => {
		expect(pluralForm(1, days)).toBe('день');
		expect(pluralForm(21, days)).toBe('день');
		expect(pluralForm(101, days)).toBe('день');
	});

	it('uses the paucal form for 2 to 4 and for anything ending in them', () => {
		expect(pluralForm(2, days)).toBe('дня');
		expect(pluralForm(3, days)).toBe('дня');
		expect(pluralForm(4, days)).toBe('дня');
		expect(pluralForm(22, days)).toBe('дня');
		expect(pluralForm(103, days)).toBe('дня');
	});

	it('uses the plural for 5 to 20 and for zero', () => {
		expect(pluralForm(0, days)).toBe('дней');
		expect(pluralForm(5, days)).toBe('дней');
		expect(pluralForm(20, days)).toBe('дней');
	});

	it('uses the plural for the teens, which end in 1 to 4 but are not singular', () => {
		expect(pluralForm(11, days)).toBe('дней');
		expect(pluralForm(12, days)).toBe('дней');
		expect(pluralForm(14, days)).toBe('дней');
		expect(pluralForm(111, days)).toBe('дней');
		expect(pluralForm(112, days)).toBe('дней');
	});

	it('ignores the sign, so an overdue count picks the same form', () => {
		expect(pluralForm(-2, days)).toBe('дня');
		expect(pluralForm(-11, days)).toBe('дней');
	});
});

describe('pluralize', () => {
	it('puts the formatted count in front of the word form', () => {
		expect(pluralize(3, ['день', 'дня', 'дней'])).toBe('3 дня');
		expect(pluralize(5, ['день', 'дня', 'дней'])).toBe('5 дней');
		expect(pluralize(1000, ['документ', 'документа', 'документов'])).toBe('1 000 документов');
	});
});

describe('initials', () => {
	it('takes the first letters of the first two words', () => {
		expect(initials('Анна Ковалёва')).toBe('АК');
		expect(initials('Пётр Сергеевич Никитин')).toBe('ПС');
	});

	it('uppercases what it takes', () => {
		expect(initials('анна ковалёва')).toBe('АК');
	});

	it('handles a single word and extra whitespace', () => {
		expect(initials('  Анна  ')).toBe('А');
	});

	it('returns nothing for an empty name', () => {
		expect(initials('')).toBe('');
		expect(initials('   ')).toBe('');
	});
});
