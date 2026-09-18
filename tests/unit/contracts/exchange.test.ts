/**
 * Конверт обмена и тела четырёх направлений.
 *
 * Проверяется ровно то, на что контракт даёт обещание отправителю: строгий
 * разбор конверта, терпимость к неизвестным полям **внутри** `data`, разбор
 * версии схемы и правило «вид заявителя решает всё, поле `form` — только
 * проверка».
 */
import { describe, expect, it } from 'vitest';
import {
	applicationSubmittedSchema,
	EXCHANGE_SCHEMA_VERSION,
	externalSourceOf,
	isSupportedSchemaVersion,
	learningGroupResultSchema,
	parseExternalSource,
	PROCESS_GROUP_BY_APPLICANT
} from '$lib/contracts/exchange';

const APPLICATION = {
	schemaVersion: '1.0',
	eventId: '9f1c1f9e-2c7b-4c3a-9a41-6d0a1f5e2b33',
	eventType: 'application.submitted',
	occurredAt: '2026-09-16T09:41:07Z',
	source: { system: 'cms', instance: 'itschool-site' },
	data: {
		externalId: 'site-2026-000123',
		revision: 3,
		form: 'b2b',
		applicant: {
			kind: 'educational_institution',
			name: 'Московский технический университет связи и информатики',
			inn: '0000000096',
			ogrn: '1027800000123',
			educationLevel: 'vo'
		},
		contact: {
			lastName: 'Кузьмина',
			firstName: 'Наталья',
			email: 'kuzmina@mtuci.example.org',
			phone: '+7 900 000-00-11',
			position: 'Проректор по цифровому развитию'
		},
		interest: 'Программа подготовки DevOps-инженеров',
		programCodes: ['VO-BAK-01'],
		productCodes: ['RT-DEVOPS'],
		comment: 'Просим связаться до конца недели.',
		transferStatus: 'not_started',
		attachments: []
	}
};

const RESULT = {
	schemaVersion: '1.0',
	eventId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
	eventType: 'learning_group.result',
	occurredAt: '2027-05-21T06:00:00Z',
	source: { system: 'lms', instance: 'moodle-itschool' },
	data: {
		groupExternalId: '2481',
		requestExternalId: 'crm-group-2f1c9a0e-1',
		period: { start: '2026-10-01', end: '2027-05-31' },
		finishedOn: '2027-05-20',
		counters: { enrolled: 45, completed: 38, expelled: 4 }
	}
};

describe('конверт сообщения', () => {
	it('принимает пример из контракта слово в слово', () => {
		expect(applicationSubmittedSchema.parse(APPLICATION).data.externalId).toBe('site-2026-000123');
		expect(learningGroupResultSchema.parse(RESULT).data.counters.completed).toBe(38);
	});

	it('отвергает неизвестное поле верхнего уровня', () => {
		// Конверт разбирается строго: лишнее поле — это либо опечатка, либо чужая
		// договорённость, и принимать её молча значит согласиться на неё.
		expect(() =>
			applicationSubmittedSchema.parse({ ...APPLICATION, correlationId: '1' })
		).toThrow();
	});

	it('не замечает неизвестных полей внутри data', () => {
		// Отправитель вправе добавить необязательное поле, не спрашивая нас, а
		// сообщение целиком всё равно остаётся в журнале обмена.
		const parsed = applicationSubmittedSchema.parse({
			...APPLICATION,
			data: { ...APPLICATION.data, utmSource: 'mailing' }
		});

		expect(parsed.data).not.toHaveProperty('utmSource');
	});

	it('не принимает сообщение чужого типа и чужого отправителя', () => {
		expect(() =>
			applicationSubmittedSchema.parse({ ...APPLICATION, eventType: 'application.status' })
		).toThrow();
		expect(() =>
			applicationSubmittedSchema.parse({
				...APPLICATION,
				source: { system: 'lms', instance: 'itschool-site' }
			})
		).toThrow();
	});

	it('требует имя экземпляра: по нему различаются стенд и промышленная установка', () => {
		expect(() =>
			applicationSubmittedSchema.parse({ ...APPLICATION, source: { system: 'cms', instance: '' } })
		).toThrow();
	});

	it('считает совместимым тот же major и только его', () => {
		expect(isSupportedSchemaVersion('1.0')).toBe(true);
		expect(isSupportedSchemaVersion('1.7')).toBe(true);
		expect(isSupportedSchemaVersion('2.0')).toBe(false);
		expect(EXCHANGE_SCHEMA_VERSION).toBe('1.0');
	});
});

describe('внешняя ссылка', () => {
	it('собирается и разбирается обратно', () => {
		const source = externalSourceOf('cms', 'itschool-site');

		expect(source).toBe('cms:itschool-site');
		expect(parseExternalSource(source)).toEqual({ system: 'cms', instance: 'itschool-site' });
	});

	it('не узнаёт строку без системы из словаря', () => {
		expect(parseExternalSource('site')).toBeNull();
		expect(parseExternalSource('crm2:stand')).toBeNull();
		expect(parseExternalSource(null)).toBeNull();
	});
});

describe('заявка', () => {
	it('связывает вид заявителя с группой процесса одной таблицей', () => {
		expect(PROCESS_GROUP_BY_APPLICANT).toEqual({
			educational_institution: 'b2b',
			legal_entity: 'b2c',
			individual: 'b2c'
		});
	});

	it('требует монотонной ревизии отправителя', () => {
		expect(() =>
			applicationSubmittedSchema.parse({
				...APPLICATION,
				data: { ...APPLICATION.data, revision: 0 }
			})
		).toThrow();
	});

	it('проверяет ИНН контрольной суммой', () => {
		expect(() =>
			applicationSubmittedSchema.parse({
				...APPLICATION,
				data: {
					...APPLICATION.data,
					applicant: { ...APPLICATION.data.applicant, inn: '7802450128' }
				}
			})
		).toThrow();
	});

	it('принимает физлицо с согласием и без реквизитов', () => {
		const parsed = applicationSubmittedSchema.parse({
			...APPLICATION,
			data: {
				...APPLICATION.data,
				form: 'b2c',
				applicant: { kind: 'individual', lastName: 'Ветров', firstName: 'Илья' },
				consent: { given: true, at: '2026-09-16T09:40:55Z', policyVersion: '2026-01' }
			}
		});

		expect(parsed.data.applicant.kind).toBe('individual');
		expect(parsed.data.consent?.given).toBe(true);
	});
});

describe('результат учебной группы', () => {
	it('не принимает счётчики, которые противоречат друг другу', () => {
		// «Ещё учатся» не передаётся, а вычисляется как остаток: два поля,
		// противоречащих друг другу, однажды разойдутся, и отчёт покажет неправду.
		expect(() =>
			learningGroupResultSchema.parse({
				...RESULT,
				data: { ...RESULT.data, counters: { enrolled: 10, completed: 8, expelled: 5 } }
			})
		).toThrow();
	});

	it('требует идентификатор группы: без него результат некуда отнести', () => {
		expect(() =>
			learningGroupResultSchema.parse({
				...RESULT,
				data: { ...RESULT.data, groupExternalId: '' }
			})
		).toThrow();
	});
});
