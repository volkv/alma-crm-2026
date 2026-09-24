/**
 * Текст письма.
 *
 * Письмо уходит наружу и обратно не отзывается, поэтому проверяется не только
 * то, что в нём есть (стадия, срок, ссылка на карточку), но и то, чего в нём
 * быть не должно: фамилий. Имя организации и название взаимодействия — потолок,
 * дальше человек идёт в карточку, а карточка закрыта входом.
 */
import { describe, expect, it } from 'vitest';
import type { MyDay } from '$lib/contracts/my-day';
import {
	digestNotificationMessage,
	interactionUrl,
	stuckNotificationMessage,
	type StuckNotificationFacts
} from '$lib/server/notifications/message';

const FACTS: StuckNotificationFacts = {
	interactionId: '2f3a5a2e-0f3a-4a5e-9c3f-0c9a1e2b3c4d',
	interactionTitle: 'СПбПУ: подготовка DevOps-инженеров, 2026/2027',
	organizationName: 'СПбПУ',
	isPersonal: false,
	stageName: 'Поиск контакта',
	standingDays: 21,
	thresholdDays: 7
};

describe('письмо о зависшем взаимодействии', () => {
	it('называет запись, сторону, стадию и срок', () => {
		const message = stuckNotificationMessage(FACTS, 'https://crm.example.org');

		expect(message.subject).toContain('СПбПУ: подготовка DevOps-инженеров, 2026/2027');
		expect(message.text).toContain('«Поиск контакта»');
		expect(message.text).toContain('21 день');
		expect(message.text).toContain('(СПбПУ)');
	});

	it('ведёт на карточку от адреса установки', () => {
		const message = stuckNotificationMessage(FACTS, 'https://crm.example.org/');

		expect(message.text).toContain(`https://crm.example.org/interactions/${FACTS.interactionId}`);
		expect(interactionUrl('https://crm.example.org', FACTS.interactionId)).toBe(
			`https://crm.example.org/interactions/${FACTS.interactionId}`
		);
	});

	it('не несёт ни одной фамилии', () => {
		// Ни ответственного, ни адресата, ни контактного лица вуза: почтовый
		// сервер получателя прочитает письмо целиком, а отозвать его нельзя.
		const message = stuckNotificationMessage(FACTS, 'https://crm.example.org');
		const body = `${message.subject}\n${message.text}`;

		for (const name of ['Вересова', 'Зотов', 'Дроздова']) {
			expect(body).not.toContain(name);
		}
	});

	it('склоняет дни и не выдумывает сутки, которых не прошло', () => {
		expect(stuckNotificationMessage({ ...FACTS, standingDays: 1 }, 'https://x').text).toContain(
			'1 день'
		);
		expect(stuckNotificationMessage({ ...FACTS, standingDays: 3 }, 'https://x').text).toContain(
			'3 дня'
		);
		expect(stuckNotificationMessage({ ...FACTS, standingDays: 11 }, 'https://x').text).toContain(
			'11 дней'
		);
		expect(stuckNotificationMessage({ ...FACTS, standingDays: 0 }, 'https://x').text).toContain(
			'меньше суток'
		);
	});

	it('при нулевом пороге объясняет правило словами, а не «дольше 0 дней»', () => {
		const message = stuckNotificationMessage(
			{ ...FACTS, thresholdDays: 0, standingDays: 0 },
			'https://x'
		);

		expect(message.text).toContain('сразу, как только по ней открыта запись');
		expect(message.text).not.toContain('дольше 0');
	});

	it('обходится без названия стороны, когда сторон ещё нет', () => {
		const message = stuckNotificationMessage(
			{ ...FACTS, organizationName: null },
			'https://crm.example.org'
		);

		expect(message.text).not.toContain('()');
		expect(message.text).toContain('«Поиск контакта»');
	});

	it('у физического лица не называет ни дело, ни сторону: это ФИО', () => {
		const message = stuckNotificationMessage(
			{
				...FACTS,
				interactionTitle: 'Заявка: Петрова Анна Сергеевна',
				organizationName: 'Петрова Анна Сергеевна',
				isPersonal: true
			},
			'https://crm.example.org'
		);
		const body = `${message.subject}\n${message.text}`;

		expect(body).not.toContain('Петрова');
		expect(message.text).toContain('Взаимодействие с физическим лицом остаётся на стадии');
		expect(message.text).toContain(`/interactions/${FACTS.interactionId}`);
	});
});

describe('утренняя сводка', () => {
	const DAY: MyDay = {
		generatedAt: new Date('2026-09-24T05:00:00Z'),
		basis: 'own',
		sections: [
			{
				kind: 'overdue',
				total: 2,
				items: [
					{
						kind: 'overdue',
						target: { type: 'interaction', id: FACTS.interactionId },
						title: 'Заявка с сайта: Иванов Пётр — Управление проектами',
						organizationName: 'Иванов Пётр Сергеевич',
						isPersonal: true,
						detail: 'стадия «Первичный контакт», срок прошёл 2 дня назад',
						note: 'Иванов не отвечает на звонки'
					},
					{
						kind: 'overdue',
						target: { type: 'interaction', id: '0c9a1e2b-0f3a-4a5e-9c3f-2f3a5a2e3c4d' },
						title: 'СПбПУ: подготовка DevOps-инженеров',
						organizationName: 'СПбПУ',
						isPersonal: false,
						detail: 'стадия «Поиск контакта», срок прошёл сегодня',
						note: 'Ждём ректора Петрову'
					}
				]
			}
		]
	};

	it('не несёт ни ФИО физического лица, ни свободного текста сотрудников', () => {
		const message = digestNotificationMessage({ day: DAY, dayLabel: '24.09.2026' }, 'https://x');
		const whole = `${message.subject}\n${message.text}`;

		expect(whole).not.toMatch(/Иванов|Петров/);
		expect(message.text).toContain('Взаимодействие с физическим лицом');
		expect(message.text).toContain('«СПбПУ: подготовка DevOps-инженеров» (СПбПУ)');
		expect(message.text).toContain(`https://x/interactions/${FACTS.interactionId}`);
		expect(message.subject).toBe('Утренняя сводка на 24.09.2026: 2 дела');
	});
});
