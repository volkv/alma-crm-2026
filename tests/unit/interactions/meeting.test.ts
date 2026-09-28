/**
 * Сборка приглашения на встречу (.ics, RFC 5545).
 *
 * Проверяются три границы, которые ломаются молча: экранирование текста (иначе
 * запятая или перенос строки в повестке портят файл целиком), перенос строк по
 * 75 октетам (иначе длинная кириллическая строка режется посреди символа), и
 * участники без открытой почты — им место только в тексте повестки, а не в
 * свойстве `ATTENDEE`, которое требует адрес.
 */
import { describe, expect, it } from 'vitest';
import {
	buildMeetingInvite,
	escapeIcsText,
	nextMeetingIdentity,
	type MeetingInviteInput
} from '../../../src/modules/meetings/server/ics';
import {
	googleCalendarUrl,
	meetingInviteEmail,
	meetingJoinUrl
} from '$lib/server/mail/meeting-invite';

function baseInput(overrides: Partial<MeetingInviteInput> = {}): MeetingInviteInput {
	return {
		uid: 'meeting-test@lct-crm.local',
		sequence: 0,
		summary: 'Встреча: СЗПУ',
		agenda: 'Обсудить программы',
		location: null,
		start: new Date('2026-10-05T11:00:00.000Z'),
		durationMinutes: 60,
		organizer: { name: 'Иванов Иван', email: 'ivanov@lct-crm.local' },
		attendeesWithEmail: [],
		attendeeNamesWithoutEmail: [],
		generatedAt: new Date('2026-10-01T09:00:00.000Z'),
		...overrides
	};
}

/** Разворачивает свёрнутые строки обратно — убирает `CRLF` и один пробел продолжения. */
function unfold(ics: string): string[] {
	return ics
		.replace(/\r\n /g, '')
		.split('\r\n')
		.filter((line) => line !== '');
}

describe('сборка приглашения на встречу (.ics)', () => {
	it('METHOD:REQUEST, время в UTC и переносы строк только через CRLF', () => {
		const ics = buildMeetingInvite(baseInput());
		const lines = unfold(ics);

		expect(lines[0]).toBe('BEGIN:VCALENDAR');
		expect(lines.at(-1)).toBe('END:VCALENDAR');
		expect(lines).toContain('METHOD:REQUEST');
		expect(lines).toContain('DTSTART:20261005T110000Z');
		expect(lines).toContain('DTEND:20261005T120000Z');
		expect(lines).toContain('ORGANIZER;CN=Иванов Иван:mailto:ivanov@lct-crm.local');
		// Голого \n без предшествующего \r в файле быть не должно.
		expect(/(?<!\r)\n/.test(ics)).toBe(false);
	});

	it('не пишет LOCATION, когда место не указано, и экранирует его, когда указано', () => {
		expect(
			unfold(buildMeetingInvite(baseInput())).some((line) => line.startsWith('LOCATION'))
		).toBe(false);

		const withLocation = buildMeetingInvite(
			baseInput({ location: 'Переговорная, 4 этаж; вход со двора' })
		);
		expect(unfold(withLocation)).toContain('LOCATION:Переговорная\\, 4 этаж\\; вход со двора');
	});

	it('экранирует запятую, точку с запятой, обратную косую и перенос строки по RFC 5545', () => {
		const ics = buildMeetingInvite(
			baseInput({
				summary: 'Встреча, ИТ-школа; обсуждение\\деталей',
				agenda: 'Пункт один\nПункт два, три; четыре\\пять'
			})
		);
		const lines = unfold(ics);

		expect(lines).toContain('SUMMARY:Встреча\\, ИТ-школа\\; обсуждение\\\\деталей');
		expect(lines.find((line) => line.startsWith('DESCRIPTION:'))).toBe(
			'DESCRIPTION:Пункт один\\nПункт два\\, три\\; четыре\\\\пять'
		);
	});

	it('переносит длинную строку по 75 октетам без потерь и без разреза символа', () => {
		const longAgenda = 'Повестка встречи с подразделением цифровой трансформации: '.repeat(4);
		const ics = buildMeetingInvite(baseInput({ agenda: longAgenda }));
		const rawLines = ics.split('\r\n');
		const start = rawLines.findIndex((line) => line.startsWith('DESCRIPTION:'));

		expect(start).toBeGreaterThanOrEqual(0);

		const physical = [rawLines[start]];
		let i = start;
		while (rawLines[i + 1]?.startsWith(' ')) {
			i += 1;
			physical.push(rawLines[i]);
		}

		// Свёрнута больше чем в одну физическую строку — иначе тест ничего не проверяет.
		expect(physical.length).toBeGreaterThan(1);

		const encoder = new TextEncoder();
		for (const line of physical) {
			expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
		}

		// Разворачивание (снять CRLF и один ведущий пробел продолжения) даёт ровно
		// исходную экранированную строку — символ ни разу не разрезан пополам.
		const rebuilt = physical.map((line, idx) => (idx === 0 ? line : line.slice(1))).join('');
		expect(rebuilt).toBe(`DESCRIPTION:${escapeIcsText(longAgenda.trim())}`);
	});

	it('участник без открытой почты попадает в файл только именем, а не свойством ATTENDEE', () => {
		const ics = buildMeetingInvite(
			baseInput({
				attendeesWithEmail: [{ name: 'Петров Пётр Ильич', email: 'petrov@vuz.ru' }],
				attendeeNamesWithoutEmail: ['Сидорова Анна Дмитриевна']
			})
		);
		const lines = unfold(ics);
		const attendeeLines = lines.filter((line) => line.startsWith('ATTENDEE'));

		expect(attendeeLines).toHaveLength(1);
		expect(attendeeLines[0]).toContain('mailto:petrov@vuz.ru');
		expect(attendeeLines[0]).not.toContain('Сидорова');
		expect(lines.find((line) => line.startsWith('DESCRIPTION:'))).toContain(
			'Сидорова Анна Дмитриевна'
		);
	});

	it('без участников с открытой почтой файл не несёт свойства ATTENDEE вовсе', () => {
		const ics = buildMeetingInvite(baseInput({ attendeeNamesWithoutEmail: ['Кузнецов Кузьма'] }));

		expect(ics).not.toContain('ATTENDEE');
	});
});

describe('перенос встречи в календаре', () => {
	const now = new Date('2026-10-01T09:00:00.000Z');

	it('встреча впереди переносится: тот же UID, SEQUENCE растёт и попадает в файл', () => {
		const next = nextMeetingIdentity(
			{ uid: 'meeting-a@lct-crm.local', sequence: 1, start: new Date('2026-10-05T11:00:00.000Z') },
			now
		);

		expect(next).toEqual({ uid: 'meeting-a@lct-crm.local', sequence: 2 });
		expect(unfold(buildMeetingInvite(baseInput(next)))).toContain('SEQUENCE:2');
	});

	it('после прошедшей встречи назначается следующая — свой UID, SEQUENCE с нуля', () => {
		const next = nextMeetingIdentity(
			{ uid: 'meeting-a@lct-crm.local', sequence: 3, start: new Date('2026-09-20T11:00:00.000Z') },
			now
		);

		expect(next.uid).not.toBe('meeting-a@lct-crm.local');
		expect(next.sequence).toBe(0);
		expect(nextMeetingIdentity(null, now).sequence).toBe(0);
	});
});

describe('письмо-приглашение и отмена', () => {
	it('REQUEST несёт участников и редакцию, CANCEL — тот же UID и STATUS:CANCELLED', () => {
		const attendees = [{ name: 'Петров Пётр', email: 'petrov@vuz.ru' }];
		const request = unfold(
			buildMeetingInvite(baseInput({ sequence: 1, attendeesWithEmail: attendees }))
		);

		expect(request).toContain('METHOD:REQUEST');
		expect(request).toContain('SEQUENCE:1');
		expect(request).toContain('STATUS:CONFIRMED');
		expect(
			request.some((line) => line.startsWith('ATTENDEE') && line.endsWith(':mailto:petrov@vuz.ru'))
		).toBe(true);

		const cancel = unfold(
			buildMeetingInvite(
				baseInput({ method: 'CANCEL', sequence: 2, attendeesWithEmail: attendees })
			)
		);

		expect(cancel).toContain('METHOD:CANCEL');
		expect(cancel).toContain('STATUS:CANCELLED');
		expect(cancel).toContain('SEQUENCE:2');
		expect(cancel).toContain('UID:meeting-test@lct-crm.local');
		expect(cancel).not.toContain('STATUS:CONFIRMED');
	});

	it('ссылка Google Календаря закодирована, место-ссылка становится кнопкой, текст экранирован', () => {
		const location = 'https://meet.example.org/room?id=1&pin=2';
		const start = new Date('2026-10-05T11:00:00.000Z');
		const url = new URL(
			googleCalendarUrl({
				summary: 'Встреча: СЗПУ & партнёры',
				start,
				durationMinutes: 90,
				details: 'Повестка: пункт 1\nпункт 2',
				location
			})
		);

		expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
		expect(url.searchParams.get('action')).toBe('TEMPLATE');
		expect(url.searchParams.get('text')).toBe('Встреча: СЗПУ & партнёры');
		expect(url.searchParams.get('dates')).toBe('20261005T110000Z/20261005T123000Z');
		expect(url.searchParams.get('details')).toBe('Повестка: пункт 1\nпункт 2');
		expect(url.searchParams.get('location')).toBe(location);

		const email = meetingInviteEmail({
			kind: 'update',
			institutionName: 'СЗПУ',
			summary: 'Встреча: <b>СЗПУ</b>',
			topic: 'Партнёрство <b>2026</b>',
			recipientName: 'Анна Дмитриевна',
			start,
			durationMinutes: 90,
			location,
			agenda: 'Обсудить <script>',
			sender: { name: 'Иванов Иван', email: 'ivanov@lct-crm.local' },
			isTest: true
		});

		expect(email.subject).toBe('[Тест] Перенос встречи — СЗПУ');
		expect(email.html).toContain('Подключиться');
		expect(email.html).toContain('href="https://meet.example.org/room?id=1&amp;pin=2"');
		expect(email.html).not.toContain('<script>');
		expect(email.html).not.toContain('<b>2026</b>');
		expect(email.html).toContain('Партнёрство &lt;b&gt;2026');
		expect(email.text).toContain('14:00 по Москве');
		expect(meetingInviteEmail({ ...baseEmail(), kind: 'cancel' }).subject).toBe(
			'Встреча отменена — СЗПУ'
		);
		// Не адрес http(s) — не кнопка: `javascript:` в чужом письме ссылкой не становится.
		expect(meetingJoinUrl('javascript:alert(1)')).toBeNull();
		expect(meetingJoinUrl('Переговорная 4')).toBeNull();
	});
});

function baseEmail(): Parameters<typeof meetingInviteEmail>[0] {
	return {
		kind: 'invite',
		institutionName: 'СЗПУ',
		summary: 'Встреча: СЗПУ',
		topic: 'Партнёрство 2026',
		recipientName: null,
		start: new Date('2026-10-05T11:00:00.000Z'),
		durationMinutes: 60,
		location: null,
		agenda: '',
		sender: { name: 'Иванов Иван', email: 'ivanov@lct-crm.local' },
		isTest: false
	};
}
