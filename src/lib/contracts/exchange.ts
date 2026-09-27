/**
 * Контракт обмена v1: конверт сообщения и тела четырёх направлений.
 *
 * Здесь описано всё, что ездит между CRM, CMS публичного сайта и системой
 * обучения (`docs/exchange-contract.md`). Схемы читают и приём сообщения, и
 * сборка исходящего, и документация OpenAPI — второго описания одного и того же
 * сообщения не существует, поэтому разойтись им негде.
 *
 * Конверт разбирается **строго**: неизвестное поле верхнего уровня — отказ.
 * Внутри `data` неизвестные поля, наоборот, отбрасываются: отправитель вправе
 * добавить необязательное поле, не спрашивая нас, а целиком сообщение всё равно
 * остаётся в журнале обмена — по нему видно, что прислали на самом деле.
 */
import { z } from 'zod';
import { isValidInn } from '$lib/validation/inn';
import { optionalId, optionalIsoDate, optionalText, pageQuerySchema, requiredText } from './common';
import { EDUCATION_LEVELS } from './directory';

/**
 * Версия схемы, на которой говорит контракт v1. `2.0` убрала из заявки на
 * учебную группу одиночное поле `product` — состав продуктов группы ездит
 * только списком `products`. Удаление поля несовместимо, поэтому сменился
 * `major`, и сообщения `1.x` получают отказ во всех направлениях. `2.1`
 * добавила в ту же заявку необязательный поимённый список слушателей
 * `learners` — добавление необязательного поля совместимо, `major` прежний.
 */
export const EXCHANGE_SCHEMA_VERSION = '2.1';

/** Чей это экземпляр: `crm` — наша система, остальные — чужие. */
export const EXCHANGE_SYSTEMS = ['cms', 'lms', 'crm'] as const;

export type ExchangeSystem = (typeof EXCHANGE_SYSTEMS)[number];

/**
 * Коды событий обмена: по одному на направление и `payment.confirmed` —
 * запись файла оплат с сайта, загруженного администратором
 * (`docs/exchange-contract.md`, «Загрузка оплат с сайта»).
 */
export const EXCHANGE_EVENT_TYPES = {
	applicationSubmitted: 'application.submitted',
	applicationStatus: 'application.status',
	learningGroupRequested: 'learning_group.requested',
	learningGroupResult: 'learning_group.result',
	paymentConfirmed: 'payment.confirmed'
} as const;

/**
 * Внешняя ссылка взаимодействия: `<система>:<экземпляр>`.
 *
 * Экземпляр входит в ключ дедупликации везде: `cms` — это не одна система, а
 * столько, сколько подключений заведено, и заявка `site-2026-000123` со стенда
 * не та же самая, что с боевого сайта.
 */
export function externalSourceOf(system: ExchangeSystem, instance: string): string {
	return `${system}:${instance}`;
}

/** Разбор внешней ссылки обратно; `null` — строка не в этой форме. */
export function parseExternalSource(
	value: string | null
): { system: ExchangeSystem; instance: string } | null {
	if (value === null) {
		return null;
	}

	const colon = value.indexOf(':');

	if (colon <= 0 || colon === value.length - 1) {
		return null;
	}

	const system = value.slice(0, colon);
	const instance = value.slice(colon + 1);

	return (EXCHANGE_SYSTEMS as readonly string[]).includes(system)
		? { system: system as ExchangeSystem, instance }
		: null;
}

/** Имя объекта у отправителя: устойчивое и неизменное. */
const externalIdField = requiredText(200, 'Укажите идентификатор объекта во внешней системе');

const instanceField = requiredText(100, 'Укажите имя экземпляра системы-отправителя');

/**
 * Конверт сообщения. Один и тот же у всех четырёх направлений: отличается
 * только `data`, а версия, идентификатор события, момент и отправитель стоят
 * на своих местах всегда.
 *
 * `eventType` и `source.system` заданы литералами: сообщение не того типа на
 * этом адресе — ошибка отправителя, а не повод разбираться в теле.
 */
function exchangeEnvelopeSchema<
	TType extends string,
	TSystem extends ExchangeSystem,
	TData extends z.ZodType
>(eventType: TType, system: TSystem, data: TData) {
	return z.strictObject({
		schemaVersion: z
			.string()
			.regex(/^\d+\.\d+$/, { error: 'Версия схемы имеет вид <major>.<minor>' }),
		eventId: requiredText(200, 'Укажите идентификатор события'),
		eventType: z.literal(eventType),
		occurredAt: z.iso.datetime({ offset: true, error: 'Момент события — ISO 8601 со смещением' }),
		source: z.strictObject({
			system: z.literal(system),
			instance: instanceField
		}),
		data
	});
}

/** Старший номер версии схемы: несовпадение — отказ. */
function schemaMajor(version: string): string {
	return version.split('.')[0];
}

/** Совместима ли присланная версия схемы с нашей. */
export function isSupportedSchemaVersion(version: string): boolean {
	return schemaMajor(version) === schemaMajor(EXCHANGE_SCHEMA_VERSION);
}

/* ------------------------------------------------------------------ */
/* Направление 1: CMS → CRM, заявка                                    */
/* ------------------------------------------------------------------ */

/** Какую форму на сайте заполнили. Сверяется с видом заявителя. */
export const APPLICATION_FORMS = ['b2b', 'b2c'] as const;

export type ApplicationForm = (typeof APPLICATION_FORMS)[number];

/** Виды заявителя, которые сайт вправе прислать. */
export const APPLICANT_KINDS = ['educational_institution', 'legal_entity', 'individual'] as const;

export type ApplicantKind = (typeof APPLICANT_KINDS)[number];

/**
 * Вид заявителя → группа процесса. Таблица соответствий одна на продукт
 * (`docs/domain.md`, раздел 2); здесь она только пересказана для проверки поля
 * `form`, которое присылает сайт.
 */
export const PROCESS_GROUP_BY_APPLICANT: Record<ApplicantKind, ApplicationForm> = {
	educational_institution: 'b2b',
	legal_entity: 'b2c',
	individual: 'b2c'
};

const innField = optionalText(12).refine((value) => value === null || isValidInn(value), {
	error: 'ИНН состоит из 10 или 12 цифр и проходит проверку контрольной суммы'
});

const organizationApplicantFields = {
	name: requiredText(500, 'Укажите название организации'),
	inn: innField,
	ogrn: optionalText(15)
};

const applicantSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('educational_institution'),
		...organizationApplicantFields,
		educationLevel: z.enum(EDUCATION_LEVELS).nullable().default('vo')
	}),
	z.object({ kind: z.literal('legal_entity'), ...organizationApplicantFields }),
	z.object({
		kind: z.literal('individual'),
		lastName: requiredText(100, 'Укажите фамилию заявителя'),
		firstName: requiredText(100, 'Укажите имя заявителя'),
		middleName: optionalText(100)
	})
]);

const contactSchema = z.object({
	lastName: requiredText(100, 'Укажите фамилию контактного лица'),
	firstName: requiredText(100, 'Укажите имя контактного лица'),
	middleName: optionalText(100),
	email: z.email({ error: 'Электронная почта указана неверно' }),
	phone: optionalText(50).refine((value) => value === null || /^[\d\s+()-]{5,}$/.test(value), {
		error: 'Телефон может содержать только цифры, пробелы и знаки + ( ) -'
	}),
	position: optionalText(300)
});

/**
 * Ссылка на файл. Файлы внутри сообщений не ездят никогда: получатель забирает
 * их по ключу объекта, проверяя размер и отпечаток (раздел 2 контракта).
 */
export const exchangeAttachmentSchema = z.object({
	documentId: z.uuid().nullable().default(null),
	kind: optionalText(60),
	name: requiredText(300, 'Укажите имя файла'),
	mime: requiredText(200, 'Укажите тип файла'),
	sizeBytes: z.number().int().min(0),
	sha256: z
		.string()
		.regex(/^[0-9a-f]{64}$/, { error: 'Отпечаток файла — 64 шестнадцатеричные цифры' }),
	storageKey: requiredText(500, 'Укажите ключ объекта в хранилище')
});

/** Согласие на обработку персональных данных: без него физлицо не заводится. */
const consentSchema = z.object({
	given: z.boolean(),
	at: z.iso.datetime({ offset: true, error: 'Момент согласия — ISO 8601 со смещением' }),
	policyVersion: requiredText(60, 'Укажите версию текста согласия')
});

/**
 * Потолок ревизии заявки — миллиард.
 *
 * Порядок применения снимков задаёт только сравнение ревизий: сообщение с
 * ревизией не больше применённой не применяется вовсе. Значит, ревизия,
 * улетевшая вперёд, замораживает заявку — все последующие законные сообщения по
 * ней отвечают `unchanged`, и вернуть её нечем, кроме правки в базе. Миллиард
 * изменений одной заявки отправитель не сделает: это больше тридцати лет по
 * изменению в секунду, — а всё, что выше, либо опечатка, либо попытка выключить
 * заявку. Потолок ниже `2^31`, поэтому он по карману и счётчику отправителя, у
 * которого ревизия — обычное 32-битное целое. Хранению он не мешает: колонка
 * `interactions.external_revision` — `bigint`.
 */
export const MAX_APPLICATION_REVISION = 1_000_000_000;

/**
 * Наибольший шаг ревизии вперёд — тысяча.
 *
 * Потолок {@link MAX_APPLICATION_REVISION} закрывает только край диапазона:
 * заявку замораживает не «слишком большое» число, а любое, до которого
 * отправитель не дойдёт своим счётчиком. Поэтому проверяется не значение, а
 * расстояние: ревизия растёт на единицу с каждым изменением заявки, и разрыв
 * даже в сотню изменений одной заявки — это уже не рабочий случай, а потерянный
 * счётчик, чужая нумерация или попытка выключить заявку. Тысяча — запас на
 * порядок к самому частому сценарию разрыва: сообщения, которые до нас не
 * доехали.
 *
 * Применённой ревизией у заявки, которой в CRM ещё нет, считается ноль:
 * заморозить её можно и первым сообщением, и правило тогда было бы половинным.
 */
export const MAX_REVISION_STEP = 1000;

export const applicationSubmittedDataSchema = z.object({
	externalId: externalIdField,
	/** Монотонная ревизия отправителя: снимок старее применённого не применяется. */
	revision: z
		.number({ error: 'Ревизия заявки — целое число' })
		.int()
		.min(1)
		.max(MAX_APPLICATION_REVISION, {
			error: `Ревизия заявки — не больше ${MAX_APPLICATION_REVISION}`
		}),
	form: z.enum(APPLICATION_FORMS, { error: 'Форма заявки — b2b или b2c' }),
	applicant: applicantSchema,
	contact: contactSchema,
	interest: optionalText(1000),
	programCodes: z.array(requiredText(100, 'Код программы')).max(50).default([]),
	productCodes: z.array(requiredText(100, 'Код продукта')).max(50).default([]),
	comment: optionalText(4000),
	/** Статус по передаче из каталога заказчика: ложится на позицию договора. */
	transferStatus: optionalText(60),
	consent: consentSchema.nullable().default(null),
	attachments: z.array(exchangeAttachmentSchema).max(20).default([])
});

export type ApplicationSubmittedData = z.output<typeof applicationSubmittedDataSchema>;

export const applicationSubmittedSchema = exchangeEnvelopeSchema(
	EXCHANGE_EVENT_TYPES.applicationSubmitted,
	'cms',
	applicationSubmittedDataSchema
);

export type ApplicationSubmittedMessage = z.output<typeof applicationSubmittedSchema>;

/** Что сделал приём: завёл, обновил или ничего (сообщение не новее применённого). */
export const EXCHANGE_RESULTS = ['created', 'updated', 'unchanged'] as const;

export type ExchangeResult = (typeof EXCHANGE_RESULTS)[number];

/**
 * Состояние заявки для карточки на сайте. Словарь короткий намеренно: заявитель
 * видит не четырнадцать стадий процесса, а понятное ему состояние.
 */
export const APPLICATION_STATUSES = [
	'received',
	'in_progress',
	'on_hold',
	'completed',
	'cancelled'
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const applicationIntakeResponseSchema = z.object({
	schemaVersion: z.literal(EXCHANGE_SCHEMA_VERSION),
	result: z.enum(EXCHANGE_RESULTS),
	data: z.object({
		externalId: z.string(),
		interactionId: z.uuid(),
		organizationId: z.uuid(),
		contactPersonId: z.uuid().nullable(),
		applicationStatus: z.enum(APPLICATION_STATUSES),
		processGroup: z.string(),
		/** Реквизитов не прислали — контрагента заводили вслепую, нужна сверка. */
		needsReview: z.boolean()
	})
});

export type ApplicationIntakeResponse = z.output<typeof applicationIntakeResponseSchema>;

/* ------------------------------------------------------------------ */
/* Направление 2: CRM → CMS, статус заявки                             */
/* ------------------------------------------------------------------ */

export const applicationStatusDataSchema = z.object({
	externalId: z.string(),
	interactionId: z.uuid(),
	applicationStatus: z.enum(APPLICATION_STATUSES),
	stage: z.object({ key: z.string(), name: z.string(), position: z.number().int() }).nullable(),
	responsible: z.object({ userId: z.uuid(), name: z.string() }).nullable(),
	dueAt: z.string().nullable(),
	lastComment: z.string().nullable(),
	updatedAt: z.string()
});

/* ------------------------------------------------------------------ */
/* Направление 3: CRM → LMS, заявка на учебную группу                  */
/* ------------------------------------------------------------------ */

/**
 * Для кого обучение: студенты вуза или колледжа, преподаватели, повышение
 * квалификации работающих. Назначение закрепляет группа, а не взаимодействие:
 * по одному соглашению с вузом идут и поток студентов, и поток преподавателей.
 */
export const LEARNING_PURPOSES = ['students', 'teachers', 'upskilling'] as const;

export type LearningPurpose = (typeof LEARNING_PURPOSES)[number];

export const LEARNING_PURPOSE_LABELS: Record<LearningPurpose, string> = {
	students: 'Обучение студентов',
	teachers: 'Обучение преподавателей',
	upskilling: 'Повышение квалификации'
};

const catalogRefSchema = z.object({ id: z.uuid(), code: z.string() });

/**
 * Слушатель в заявке на группу: ФИО и почта, по которой система обучения
 * заводит или находит учётную запись. `personId` — наш устойчивый
 * идентификатор человека: по нему получатель отличает однофамильцев, а мы
 * находим отправленное, когда данные человека уничтожают. Телефон не едет:
 * системе обучения он не нужен, а лишний контакт — лишние персональные данные.
 */
export const learningGroupLearnerEntrySchema = z.object({
	personId: z.uuid(),
	lastName: z.string(),
	firstName: z.string(),
	middleName: z.string().nullable(),
	email: z.string()
});

export type LearningGroupLearnerEntry = z.output<typeof learningGroupLearnerEntrySchema>;

export const learningGroupRequestedDataSchema = z.object({
	externalId: z.string(),
	interactionId: z.uuid(),
	organization: z.object({ id: z.uuid(), inn: z.string().nullable(), name: z.string() }),
	/**
	 * Программа, закреплённая за группой. `null` — только у групп, заведённых
	 * до закрепления выбора (миграция `0023`).
	 */
	program: catalogRefSchema.nullable(),
	/** Продукты группы — подмножество продуктов взаимодействия. */
	products: z.array(catalogRefSchema),
	/** Для кого обучение. `null` — только у групп, заведённых до закрепления выбора. */
	purpose: z.enum(LEARNING_PURPOSES).nullable(),
	contract: z.object({ id: z.uuid(), number: z.string() }).nullable(),
	stream: z.object({
		number: z.number().int().min(1),
		plannedSeats: z.number().int().min(1),
		startsOn: z.string().nullable(),
		endsOn: z.string().nullable()
	}),
	responsible: z.object({ userId: z.uuid() }),
	documents: z.array(exchangeAttachmentSchema),
	/**
	 * Поимённый список слушателей группы (`2.1`) — полный снимок состава, а не
	 * добавка. Поля нет — заявка о составе ничего не говорит, и получатель
	 * прежний состав не трогает; пустой список — «слушателей нет».
	 */
	learners: z.array(learningGroupLearnerEntrySchema).optional()
});

/**
 * Ответ системы обучения на заявку. Разбирается мягко: обязателен только
 * идентификатор группы — всё остальное чужая система вправе не прислать, а
 * заводить группу без её имени у себя мы не станем.
 */
export const learningGroupReplySchema = z.object({
	result: z.string().optional(),
	data: z.object({
		externalId: z.string().optional(),
		groupExternalId: requiredText(200, 'Система обучения не вернула идентификатор группы'),
		courseExternalId: z.string().nullish(),
		url: z.string().nullish()
	})
});

/** Параметры отправки группы: их подтверждает человек, а не стадия. */
export const sendLearningGroupSchema = z.object({
	interactionId: z.uuid({ error: 'Некорректный идентификатор взаимодействия' }),
	streamNumber: z.coerce
		.number({ error: 'Номер потока — целое число' })
		.int()
		.min(1, { error: 'Номер потока начинается с единицы' })
		.max(99, { error: 'Больше девяноста девяти потоков у одного взаимодействия не бывает' }),
	plannedSeats: z.coerce
		.number({ error: 'Число мест — целое число' })
		.int()
		.min(1, { error: 'В потоке хотя бы одно место' })
		.max(10_000, { error: 'Больше десяти тысяч мест в потоке не бывает' }),
	// Пустое поле формы и отсутствие даты — одно и то же: у потока может не быть
	// названной даты начала, и требовать её значило бы запретить заводить группу
	// до того, как расписание согласовано.
	startsOn: optionalIsoDate('Дата начала занятий указана неверно'),
	endsOn: optionalIsoDate('Дата окончания занятий указана неверно'),
	// Программа и продукты выбираются из тех, что есть у взаимодействия. Пустой
	// выбор допустим только там, где выбирать не из чего или вариант один, —
	// это решает сервис, который знает состав взаимодействия; схема лишь
	// проверяет форму значений.
	programId: optionalId('Некорректный идентификатор программы'),
	productIds: z
		.array(z.uuid({ error: 'Некорректный идентификатор продукта' }))
		.max(50)
		.default([])
		.refine((ids) => new Set(ids).size === ids.length, {
			error: 'Продукт выбран дважды'
		}),
	purpose: z.enum(LEARNING_PURPOSES, {
		error: 'Укажите, для кого обучение: студенты, преподаватели или повышение квалификации'
	})
});

export type SendLearningGroupInput = z.output<typeof sendLearningGroupSchema>;

/**
 * Отметка сотрудника «обучение завершено». Нужна там, где система обучения
 * итога не прислала, а обучение закончилось: без объяснения такая отметка —
 * слово против отсутствия данных, поэтому комментарий обязателен.
 */
export const completeLearningGroupSchema = z.object({
	interactionId: z.uuid({ error: 'Некорректный идентификатор взаимодействия' }),
	learningGroupId: z.uuid({ error: 'Некорректный идентификатор учебной группы' }),
	comment: requiredText(
		1000,
		'Объясните, почему обучение считается завершённым без итога из системы обучения'
	)
});

export type CompleteLearningGroupInput = z.output<typeof completeLearningGroupSchema>;

/* ------------------------------------------------------------------ */
/* Поимённый список слушателей группы                                  */
/* ------------------------------------------------------------------ */

/**
 * Где слушатель в группе: `listed` — внесён в список в CRM, `transferred` —
 * система обучения приняла список, в котором он был.
 */
export const LEARNER_STATUSES = ['listed', 'transferred'] as const;

export type LearnerStatus = (typeof LEARNER_STATUSES)[number];

export const LEARNER_STATUS_LABELS: Record<LearnerStatus, string> = {
	listed: 'Не передан в LMS',
	transferred: 'Передан в LMS'
};

/** Сколько строк принимает один файл списка: поток — это десятки человек, не тысячи. */
export const ROSTER_MAX_ROWS = 500;

/** Форматы файла списка — те же, что читает общий разбор таблиц. */
export const ROSTER_FILE_FORMATS_HINT = 'XLSX, XLS или CSV: колонки «ФИО», «Почта», «Телефон»';

/** Группа, к которой относится действие со списком. */
export const learningGroupRosterSchema = z.object({
	interactionId: z.uuid({ error: 'Некорректный идентификатор взаимодействия' }),
	learningGroupId: z.uuid({ error: 'Некорректный идентификатор учебной группы' })
});

export type LearningGroupRosterInput = z.output<typeof learningGroupRosterSchema>;

export const removeLearnerSchema = learningGroupRosterSchema.extend({
	personId: z.uuid({ error: 'Некорректный идентификатор человека' })
});

export type RemoveLearnerInput = z.output<typeof removeLearnerSchema>;

/**
 * Что станет со строкой файла: `create` — заведём человека, `link` — человек
 * уже есть в справочнике (узнан по почте), `present` — он уже в этой группе,
 * `error` — строка не загрузится.
 */
export const ROSTER_ROW_ACTIONS = ['create', 'link', 'present', 'error'] as const;

export type RosterRowAction = (typeof ROSTER_ROW_ACTIONS)[number];

export const ROSTER_ROW_ACTION_LABELS: Record<RosterRowAction, string> = {
	create: 'Новый человек',
	link: 'Уже в справочнике',
	present: 'Уже в группе',
	error: 'Ошибка'
};

/** Строка файла списка после разбора и сверки. */
export type RosterRowView = {
	/** Номер строки в файле — как его видит человек в таблице. */
	rowNo: number;
	fullName: string;
	email: string | null;
	phone: string | null;
	action: RosterRowAction;
	issues: string[];
};

/** Предпросмотр или итог загрузки списка. */
export type RosterView = {
	rows: RosterRowView[];
	counts: Record<RosterRowAction, number>;
	/** Претензии к файлу целиком: нет колонки почты, пустой лист. */
	fileIssues: string[];
};

/** Слушатель группы в том виде, в каком его показывает карточка. */
export type LearningGroupLearnerView = {
	learningGroupId: string;
	personId: string;
	/** ФИО одной строкой; у обезличенного — пометка вместо имени. */
	fullName: string;
	/** Почта и телефон — через сериализатор людей: без права на ПДн замаскированы. */
	email: string | null;
	phone: string | null;
	status: LearnerStatus;
	addedAt: Date;
	transferredAt: Date | null;
};

/* ------------------------------------------------------------------ */
/* Направление 4: LMS → CRM, результат учебной группы                  */
/* ------------------------------------------------------------------ */

const countersSchema = z
	.object({
		enrolled: z.number({ error: 'Зачислено — целое число' }).int().min(0),
		completed: z.number({ error: 'Завершили — целое число' }).int().min(0),
		expelled: z.number({ error: 'Отчислены — целое число' }).int().min(0)
	})
	.refine((value) => value.completed + value.expelled <= value.enrolled, {
		error: 'Завершивших и отчисленных вместе не больше зачисленных',
		path: ['completed']
	});

export const learningGroupResultDataSchema = z.object({
	groupExternalId: externalIdField,
	requestExternalId: optionalText(200),
	period: z
		.object({
			start: z.iso.date({ error: 'Начало периода — дата вида ГГГГ-ММ-ДД' }).nullable(),
			end: z.iso.date({ error: 'Конец периода — дата вида ГГГГ-ММ-ДД' }).nullable()
		})
		.nullable()
		.default(null),
	finishedOn: z.iso
		.date({ error: 'Дата окончания — дата вида ГГГГ-ММ-ДД' })
		.nullable()
		.default(null),
	counters: countersSchema,
	report: exchangeAttachmentSchema.nullable().default(null)
});

export type LearningGroupResultData = z.output<typeof learningGroupResultDataSchema>;

export const learningGroupResultSchema = exchangeEnvelopeSchema(
	EXCHANGE_EVENT_TYPES.learningGroupResult,
	'lms',
	learningGroupResultDataSchema
);

export type LearningGroupResultMessage = z.output<typeof learningGroupResultSchema>;

export const learningGroupResultResponseSchema = z.object({
	schemaVersion: z.literal(EXCHANGE_SCHEMA_VERSION),
	result: z.enum(EXCHANGE_RESULTS),
	data: z.object({
		groupExternalId: z.string(),
		learningGroupId: z.uuid(),
		interactionId: z.uuid(),
		/** Засчитан ли факт открытой стадии; `false` — взаимодействие на другой. */
		stageConfirmed: z.boolean(),
		/** Что случилось со стадией — словами, для журнала отправителя. */
		note: z.string()
	})
});

export type LearningGroupResultResponse = z.output<typeof learningGroupResultResponseSchema>;

/**
 * Итоговый ли результат группы: обучение закончилось, и есть кому его
 * закончить. Промежуточный результат — это «данные получены», а не «обучение
 * завершено»: у него нет даты окончания или ещё нет ни одного завершившего.
 *
 * Правило одно на продукт: его спрашивают и приём результата, решая, закрывает
 * ли факт стадию, и карточка, объясняя сотруднику, чего стадия ещё ждёт.
 */
export function isFinalLearningResult(result: {
	completed: number | null;
	finishedOn: string | null;
}): boolean {
	return (result.completed ?? 0) > 0 && result.finishedOn !== null;
}

/**
 * Факт завершения обучения в том виде, в каком он ложится в `stage_entries
 * .lms_evidence` и показывается на карточке. Это снимок, а не ссылка: запись
 * стадии обязана объяснять подтверждение и тогда, когда группу уже удалили.
 *
 * Видов два. `result` — итоговый результат группы из системы обучения;
 * промежуточный сюда не попадает никогда. `manual` — отметка сотрудника
 * «обучение завершено» с комментарием: итога из чужой системы нет, а обучение
 * закончилось.
 */
export const lmsEvidenceSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('result'),
		system: z.string(),
		instance: z.string(),
		groupExternalId: z.string(),
		learningGroupId: z.uuid(),
		occurredAt: z.string(),
		enrolled: z.number().int(),
		completed: z.number().int(),
		expelled: z.number().int(),
		finishedOn: z.string().nullable(),
		periodStart: z.string().nullable(),
		periodEnd: z.string().nullable()
	}),
	z.object({
		kind: z.literal('manual'),
		learningGroupId: z.uuid(),
		groupExternalId: z.string().nullable(),
		streamNumber: z.number().int(),
		markedAt: z.string(),
		markedByUserId: z.uuid(),
		comment: z.string()
	})
]);

export type LmsEvidence = z.output<typeof lmsEvidenceSchema>;

/** Завершает ли факт обучение: итоговый результат либо отметка сотрудника. */
export function isTrainingCompleted(evidence: LmsEvidence): boolean {
	return evidence.kind === 'manual' || isFinalLearningResult(evidence);
}

/* ------------------------------------------------------------------ */
/* Журнал обмена                                                       */
/* ------------------------------------------------------------------ */

export const EXCHANGE_DIRECTIONS = ['inbound', 'outbound'] as const;

export type ExchangeDirection = (typeof EXCHANGE_DIRECTIONS)[number];

export const EXCHANGE_DIRECTION_LABELS: Record<ExchangeDirection, string> = {
	inbound: 'Входящее',
	outbound: 'Исходящее'
};

export const EXCHANGE_MESSAGE_STATES = [
	'pending',
	'retrying',
	'sent',
	'processed',
	'ignored_stale',
	'failed',
	'dismissed'
] as const;

export type ExchangeMessageState = (typeof EXCHANGE_MESSAGE_STATES)[number];

export const EXCHANGE_STATE_LABELS: Record<ExchangeMessageState, string> = {
	pending: 'Ждёт отправки',
	retrying: 'Повтор назначен',
	sent: 'Отправлено',
	processed: 'Принято',
	ignored_stale: 'Старее применённого',
	failed: 'Не доставлено',
	dismissed: 'Разобрано вручную'
};

/** Состояния, из которых сообщение ещё может уйти повтором. */
export const RETRIABLE_STATES: readonly ExchangeMessageState[] = ['failed', 'retrying'];

export type ExchangeMessageView = {
	id: string;
	direction: ExchangeDirection;
	system: string;
	instance: string;
	eventType: string;
	eventId: string;
	externalId: string | null;
	interactionId: string | null;
	interactionTitle: string | null;
	state: ExchangeMessageState;
	attempt: number;
	nextAttemptAt: Date | null;
	responseStatus: number | null;
	lastError: string | null;
	createdAt: Date;
	closedAt: Date | null;
};

/** Учебная группа взаимодействия в том виде, в каком её показывает карточка. */
export type LearningGroupView = {
	id: string;
	streamNumber: number;
	system: string;
	instance: string;
	groupExternalId: string | null;
	requestedAt: Date;
	plannedSeats: number | null;
	startsOn: string | null;
	endsOn: string | null;
	lastResultAt: Date | null;
	/** Состояние последнего сообщения о заявке на эту группу. */
	messageState: ExchangeMessageState | null;
	lastError: string | null;
	enrolled: number | null;
	completed: number | null;
	expelled: number | null;
	/** Дата окончания обучения из последнего результата. */
	finishedOn: string | null;
	/** Закреплённая программа; `null` — группа заведена до закрепления. */
	program: { id: string; code: string; name: string } | null;
	products: { id: string; code: string; name: string }[];
	purpose: LearningPurpose | null;
	/**
	 * Что известно об обучении: `awaiting` — результатов ещё нет,
	 * `in_progress` — данные получены, но итога нет, `completed` — итоговый
	 * результат или отметка сотрудника.
	 */
	trainingState: LearningTrainingState;
	/** Отметка «обучение завершено»; `null` — её не ставили. */
	completionMark: { at: Date; byName: string | null; comment: string } | null;
	/**
	 * Засчитывается ли группа стадии этого взаимодействия: её программа входит
	 * в программы взаимодействия, а назначение — в назначения, которые
	 * допускает стадия (пусто — любое). Группа по программе, которую из
	 * взаимодействия убрали, или назначения, которое стадия не считает, стадию
	 * не подтверждает.
	 */
	countsForStage: boolean;
	/** Сколько человек в поимённом списке группы. */
	learnerCount: number;
	/** Из них переданы в систему обучения. */
	transferredCount: number;
};

export const LEARNING_TRAINING_STATES = ['awaiting', 'in_progress', 'completed'] as const;

export type LearningTrainingState = (typeof LEARNING_TRAINING_STATES)[number];

/**
 * Как идёт обучение потока: завершено — есть отметка сотрудника или итоговый
 * результат (`isFinalLearningResult`), идёт — пришёл хоть какой-то результат,
 * иначе ждём данных. Одно правило на карточку и сводку потоков пространства.
 */
export function learningTrainingState(group: {
	completionMarked: boolean;
	finished: boolean;
	hasResult: boolean;
}): LearningTrainingState {
	if (group.completionMarked || group.finished) {
		return 'completed';
	}

	return group.hasResult ? 'in_progress' : 'awaiting';
}

export const exchangeFilterSchema = z.object({
	direction: z.enum(EXCHANGE_DIRECTIONS).nullable().default(null),
	system: z.enum(EXCHANGE_SYSTEMS).nullable().default(null),
	state: z.enum(EXCHANGE_MESSAGE_STATES).nullable().default(null),
	q: z
		.string()
		.trim()
		.max(200, { error: 'Поисковый запрос не длиннее 200 символов' })
		.nullable()
		.default(null)
		.transform((value) => (value === null || value === '' ? null : value))
});

export type ExchangeFilter = z.output<typeof exchangeFilterSchema>;

/** Тот же фильтр вместе со страницей: журнал читают глазами и по одной. */
export const exchangeQuerySchema = exchangeFilterSchema.extend(pageQuerySchema.shape);

export type ExchangeQuery = z.output<typeof exchangeQuerySchema>;

/** Пометить сообщение разобранным: причина обязательна, это признание. */
export const dismissMessageSchema = z.object({
	messageId: z.uuid({ error: 'Некорректный идентификатор сообщения' }),
	reason: requiredText(500, 'Объясните, как сообщение разобрали')
});

export type DismissMessageInput = z.output<typeof dismissMessageSchema>;

export const retryMessageSchema = z.object({
	messageId: z.uuid({ error: 'Некорректный идентификатор сообщения' })
});
