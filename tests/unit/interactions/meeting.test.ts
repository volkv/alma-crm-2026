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
