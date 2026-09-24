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
	isFinalLearningResult,
	isSupportedSchemaVersion,
	isTrainingCompleted,
	learningGroupResultSchema,
	lmsEvidenceSchema,
	MAX_APPLICATION_REVISION,
	parseExternalSource,
	PROCESS_GROUP_BY_APPLICANT,
	sendLearningGroupSchema
} from '$lib/contracts/exchange';

const APPLICATION = {
	schemaVersion: '2.0',
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
	schemaVersion: '2.0',
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
		expect(isSupportedSchemaVersion('2.0')).toBe(true);
		expect(isSupportedSchemaVersion('2.7')).toBe(true);
		expect(isSupportedSchemaVersion('1.1')).toBe(false);
		expect(isSupportedSchemaVersion('3.0')).toBe(false);
		expect(EXCHANGE_SCHEMA_VERSION).toBe('2.0');
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

	it('не принимает ревизию выше потолка: ею заявку выключают', () => {
		// Порядок применения снимков задаёт только сравнение ревизий, поэтому
		// ревизия, улетевшая вперёд, замораживает заявку навсегда: все законные
		// сообщения по ней отвечали бы `unchanged`.
		expect(() =>
			applicationSubmittedSchema.parse({
				...APPLICATION,
				data: { ...APPLICATION.data, revision: Number.MAX_SAFE_INTEGER }
			})
		).toThrow();
		expect(() =>
			applicationSubmittedSchema.parse({
				...APPLICATION,
				data: { ...APPLICATION.data, revision: MAX_APPLICATION_REVISION + 1 }
			})
		).toThrow();

		expect(
			applicationSubmittedSchema.parse({
				...APPLICATION,
				data: { ...APPLICATION.data, revision: MAX_APPLICATION_REVISION }
			}).data.revision
		).toBe(MAX_APPLICATION_REVISION);
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

describe('итог обучения', () => {
	it('итоговым считает только результат с завершившими и датой окончания', () => {
		expect(isFinalLearningResult({ completed: 38, finishedOn: '2027-05-20' })).toBe(true);
		// Промежуточный результат: обучение идёт, выпускников ещё нет.
		expect(isFinalLearningResult({ completed: 0, finishedOn: '2027-05-20' })).toBe(false);
		// Числа есть, а дата окончания не названа — поток не закончен.
		expect(isFinalLearningResult({ completed: 38, finishedOn: null })).toBe(false);
		expect(isFinalLearningResult({ completed: null, finishedOn: '2027-05-20' })).toBe(false);
	});

	it('различает факт результата и отметку сотрудника', () => {
		const result = lmsEvidenceSchema.parse({
			kind: 'result',
			system: 'lms',
			instance: 'moodle-itschool',
			groupExternalId: '2481',
			learningGroupId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
			occurredAt: '2027-01-10T06:00:00.000Z',
			enrolled: 45,
			completed: 0,
			expelled: 1,
			finishedOn: null,
			periodStart: null,
			periodEnd: null
		});
		const mark = lmsEvidenceSchema.parse({
			kind: 'manual',
			learningGroupId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
			groupExternalId: null,
			streamNumber: 1,
			markedAt: '2027-05-21T06:00:00.000Z',
			markedByUserId: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
			comment: 'Итоговая ведомость пришла бумагой'
		});

		expect(isTrainingCompleted(result)).toBe(false);
		expect(isTrainingCompleted(mark)).toBe(true);
		// Снимок без вида — прежняя форма до разделения — больше не разбирается.
		expect(lmsEvidenceSchema.safeParse({ ...result, kind: undefined }).success).toBe(false);
	});
});

describe('заявка на учебную группу', () => {
	const FORM = {
		interactionId: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
		streamNumber: '1',
		plannedSeats: '45',
		startsOn: null,
		endsOn: null
	};

	it('требует назначения обучения: для кого поток, выбирает сотрудник', () => {
		const refused = sendLearningGroupSchema.safeParse(FORM);

		expect(refused.success).toBe(false);
		expect(refused.error?.issues.map((issue) => issue.message)).toContain(
			'Укажите, для кого обучение: студенты, преподаватели или повышение квалификации'
		);

		expect(sendLearningGroupSchema.parse({ ...FORM, purpose: 'teachers' })).toMatchObject({
			purpose: 'teachers',
			programId: null,
			productIds: []
		});
	});

	it('не принимает один продукт дважды', () => {
		const id = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

		expect(
			sendLearningGroupSchema.safeParse({ ...FORM, purpose: 'students', productIds: [id, id] })
				.success
		).toBe(false);
	});
});
