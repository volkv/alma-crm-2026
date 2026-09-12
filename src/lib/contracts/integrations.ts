/**
 * Интеграции: подписки на события журнала (вебхуки), выгрузка из системы
 * обучения и приём заявок с сайта.
 *
 * Общее у всех трёх — они соединяют систему с чужой, поэтому договорённость
 * описана здесь один раз: её читает и форма настроек, и сервер, и внешний
 * интегратор через OpenAPI.
 *
 * Состояние интеграций не хранится в PostgreSQL: подписки, курсоры журнала,
 * попытки доставки и отметки о выгрузке живут в Redis, а настройки — в
 * `app_settings`. Это не оптимизация: у всего перечисленного есть срок жизни и
 * нет истории, за которую кто-то отвечает, а таблица притворялась бы, что есть.
 */
import { z } from 'zod';
import { isValidInn } from '$lib/validation/inn';
import { AUDIT_EVENT_TYPES } from './audit';
import { optionalId, optionalText, requiredText } from './common';
import { EDUCATION_LEVELS, ORGANIZATION_KINDS } from './directory';

/* ------------------------------------------------------------------ */
/* Подписка на события журнала                                         */
/* ------------------------------------------------------------------ */

/** Раздел кода события: `interactions.completed` → `interactions`. */
export function eventPrefix(type: string): string {
	const dot = type.indexOf('.');

	return dot === -1 ? type : type.slice(0, dot);
}

/** Разделы, по которым можно подписаться целиком. */
export const AUDIT_EVENT_PREFIXES: readonly string[] = [
	...new Set(AUDIT_EVENT_TYPES.map((type) => eventPrefix(type)))
];

/** Подписка на весь раздел записывается так: `interactions.*`. */
export function prefixPattern(prefix: string): string {
	return `${prefix}.*`;
}

const EVENT_TYPES = new Set<string>(AUDIT_EVENT_TYPES);
const PREFIX_PATTERNS = new Set(AUDIT_EVENT_PREFIXES.map(prefixPattern));

/**
 * Допустимая строка фильтра: либо точный код события из словаря, либо весь
 * раздел. Произвольная маска не принимается: подписка, которая ни на что не
 * похожа, молча не получала бы ничего.
 */
export function isWebhookEventPattern(value: string): boolean {
	return EVENT_TYPES.has(value) || PREFIX_PATTERNS.has(value);
}

/** Попадает ли событие под фильтр подписки. */
export function matchesWebhookEvent(patterns: readonly string[], type: string): boolean {
	return patterns.some(
		(pattern) => pattern === type || pattern === prefixPattern(eventPrefix(type))
	);
}

/**
 * Куда можно слать вебхук.
 *
 * Только `https`: тело несёт коды событий и ссылки на записи, и по открытому
 * каналу их читает любой посредник. Исключение — адрес на этой же машине
 * (`http://localhost`, `127.0.0.1`, `[::1]`) и `host.docker.internal`: на
 * демонстрации приёмник поднимают рядом, и требовать от него сертификат
 * значило бы запретить проверку самой связки.
 *
 * Возвращает претензию словами или `null`, если адрес годится.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal']);

export function webhookUrlIssue(raw: string): string | null {
	let parsed: URL;

	try {
		parsed = new URL(raw);
	} catch {
		return 'Адрес указывают полностью, вместе с https://';
	}

	if (parsed.protocol === 'https:') {
		return null;
	}

	if (parsed.protocol !== 'http:') {
		return 'Вебхук отправляется по http или https';
	}

	return LOOPBACK_HOSTS.has(parsed.hostname)
		? null
		: 'По http принимает только адрес на этой же машине (localhost, 127.0.0.1, host.docker.internal); остальным нужен https';
}

const webhookUrlField = z
	.string({ error: 'Укажите адрес приёмника' })
	.trim()
	.min(1, { error: 'Укажите адрес приёмника' })
	.max(2000, { error: 'Адрес не длиннее 2000 символов' })
	.refine((value) => webhookUrlIssue(value) === null, {
		error: (issue) => webhookUrlIssue(String(issue.input)) ?? 'Адрес не годится'
	});

const webhookEventField = z
	.string()
	.refine(isWebhookEventPattern, { error: 'Такого события нет в словаре журнала' });

/**
 * Набор событий в каноническом виде: без повторов и в одном порядке. «Тот же
 * набор» не должен зависеть от порядка галочек в форме — по нему сравниваются
 * подписки и считается список изменённых полей.
 *
 * Отдельной функцией, а не преобразованием внутри схемы: схема с `transform`
 * перестаёт отдавать значение по умолчанию для пустой формы, и форма на
 * странице остаётся без списка вовсе.
 */
export function normalizeWebhookEvents(events: readonly string[]): string[] {
	return [...new Set(events)].sort();
}

export const createWebhookSchema = z.object({
	name: requiredText(200, 'Назовите подписку так, чтобы было понятно, чья это система'),
	url: webhookUrlField,
	events: z
		.array(webhookEventField)
		.min(1, { error: 'Выберите хотя бы одно событие' })
		.max(AUDIT_EVENT_TYPES.length + AUDIT_EVENT_PREFIXES.length),
	enabled: z.boolean().default(true)
});

export type CreateWebhookInput = z.output<typeof createWebhookSchema>;

/**
 * Форма подписки: одна на заведение и на правку. Пустой идентификатор означает
 * новую подписку — второй формы ради одного поля заводить незачем.
 */
export const webhookFormSchema = createWebhookSchema.extend({
	id: optionalId('Некорректный идентификатор подписки')
});

export type WebhookFormInput = z.output<typeof webhookFormSchema>;

/** Состояние доставок подписки: то, что о ней знает цикл доставки. */
export const WEBHOOK_STATES = ['idle', 'delivering', 'failed'] as const;

export type WebhookState = (typeof WEBHOOK_STATES)[number];

export const WEBHOOK_STATE_LABELS: Record<WebhookState, string> = {
	idle: 'Доставляется',
	delivering: 'Есть неотправленные',
	failed: 'Доставка не удалась'
};

/** Одна попытка доставки — то, что видно сотруднику в разделе интеграций. */
export type WebhookDelivery = {
	eventId: string;
	eventType: string;
	/** Номер попытки, с единицы. */
	attempt: number;
	/** Код ответа приёмника; `null` — до ответа дело не дошло. */
	status: number | null;
	/** Что пошло не так — словами; `null` у успешной попытки. */
	error: string | null;
	/** Момент попытки, ISO 8601: состояние живёт в Redis, а не в базе. */
	at: string;
	ok: boolean;
};

/**
 * Подписка в том виде, в каком её отдают наружу. Секрета здесь нет и быть не
 * может: он показывается один раз при заведении, дальше им только подписывают.
 */
export type WebhookView = {
	id: string;
	name: string;
	url: string;
	events: string[];
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	state: WebhookState;
	/** Сколько событий ждут повторной попытки. */
	pending: number;
	lastDeliveries: WebhookDelivery[];
};

/** Только что заведённая подписка вместе с секретом — единственный раз. */
export type CreatedWebhook = { webhook: WebhookView; secret: string };

/**
 * Тело доставки. `type` — код события журнала либо `webhook.test` у проверочной
 * отправки: придумывать ради кнопки «проверить» несуществующее событие журнала
 * значило бы засорять словарь, по которому строят отчёты.
 */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

export const webhookPayloadSchema = z.object({
	/** Идентификатор записи журнала; у проверочной отправки — свой. */
	id: z.string(),
	type: z.string(),
	occurredAt: z.iso.datetime(),
	subject: z.object({ type: z.string(), id: z.string() }).nullable(),
	/**
	 * Подробности записи журнала. Персональных данных там не бывает — это
	 * держит `validateAuditDetails`, — поэтому тело уезжает как есть.
	 */
	details: z.record(z.string(), z.unknown())
});

export type WebhookPayload = z.output<typeof webhookPayloadSchema>;

/* ------------------------------------------------------------------ */
/* Настройки интеграций                                                */
/* ------------------------------------------------------------------ */

/**
 * Ключи настроек интеграций в `app_settings`. Свои, а не в общем словаре
 * `settingSchemas`: тот описывает правила входа и блокировки, которые читает
 * каждый запрос, а эти — адрес чужой системы и периодичность фоновой работы.
 */
export const INTEGRATION_SETTING_KEYS = {
	lms: 'integrations.lms',
	delivery: 'integrations.delivery'
} as const;

export const lmsSettingsSchema = z.object({
	/** Адрес Moodle без хвоста: `https://lms.example.org`. */
	baseUrl: z
		.url({ error: 'Адрес указывают полностью, вместе с https://', protocol: /^https?$/ })
		.nullable()
		.default(null),
	/** Токен веб-сервиса. Наружу не отдаётся — только признак «сохранён». */
	token: z.string().max(500).nullable().default(null),
	/** Забирать ли выгрузку по таймеру. Кнопка в разделе работает и без этого. */
	enabled: z.boolean().default(false),
	syncIntervalMinutes: z
		.number({ error: 'Укажите периодичность в минутах' })
		.int()
		.min(5, { error: 'Не чаще раза в 5 минут' })
		.max(1440, { error: 'Не реже раза в сутки' })
		.default(60)
});

export type LmsSettings = z.output<typeof lmsSettingsSchema>;

/** Те же настройки для экрана: вместо токена — знает ли система токен вообще. */
export type LmsSettingsView = Omit<LmsSettings, 'token'> & { hasToken: boolean };

/**
 * Форма настроек LMS. Пустое поле токена означает «оставить прежний»:
 * показать сохранённый токен на экране нельзя, а заставлять набирать его
 * заново ради смены адреса — значит провоцировать на хранение его в переписке.
 */
export const lmsSettingsFormSchema = z.object({
	baseUrl: z
		.string()
		.trim()
		.max(2000)
		.refine((value) => value === '' || /^https?:\/\/\S+$/.test(value), {
			error: 'Адрес указывают полностью, вместе с https://'
		}),
	token: optionalText(500),
	enabled: z.boolean().default(false),
	syncIntervalMinutes: lmsSettingsSchema.shape.syncIntervalMinutes
});

export type LmsSettingsFormInput = z.output<typeof lmsSettingsFormSchema>;

export const deliverySettingsSchema = z.object({
	/** Как часто цикл доставки просыпается. */
	intervalSeconds: z
		.number({ error: 'Укажите периодичность в секундах' })
		.int()
		.min(5, { error: 'Не чаще раза в 5 секунд' })
		.max(600, { error: 'Не реже раза в 10 минут' })
		.default(15)
});

export type DeliverySettings = z.output<typeof deliverySettingsSchema>;

/** Чем кончилась последняя синхронизация с LMS. */
export type LmsSyncState = {
	startedAt: string;
	finishedAt: string;
	ok: boolean;
	/** Итог словами: что забрали или почему не вышло. */
	message: string;
	/** Снимок, который получился; `null` — если ничего не изменилось или сбой. */
	snapshotId: string | null;
	rows: number;
};

/* ------------------------------------------------------------------ */
/* Заявка с сайта                                                      */
/* ------------------------------------------------------------------ */

const applicationInn = optionalText(12).refine((value) => value === null || isValidInn(value), {
	error: 'ИНН должен состоять из 10 или 12 цифр и проходить проверку контрольной суммы'
});

const applicationOrganizationSchema = z
	.object({
		name: requiredText(500, 'Укажите название организации'),
		/** Единственный ключ сверки: по названию организации не объединяются. */
		inn: applicationInn,
		kind: z.enum(ORGANIZATION_KINDS).default('educational_institution'),
		educationLevel: z.enum(EDUCATION_LEVELS).nullable().default(null)
	})
	.refine(
		(value) => (value.educationLevel !== null) === (value.kind === 'educational_institution'),
		{
			error: 'Уровень образования заполняют только у учебных заведений и обязательно у них',
			path: ['educationLevel']
		}
	);

const applicationContactSchema = z.object({
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
 * Заявка с сайта. Приходит ключом API, а не анонимно: у заявки есть владелец —
 * тот, чьим ключом её принесли, — и он же становится ответственным за
 * взаимодействие. Анонимный приём означал бы, что заводить организации и людей
 * в справочнике может кто угодно.
 */
export const applicationIntakeSchema = z.object({
	/** Идентификатор заявки в системе сайта: по нему повтор не создаёт дубля. */
	externalId: requiredText(200, 'Укажите идентификатор заявки во внешней системе'),
	organization: applicationOrganizationSchema,
	contact: applicationContactSchema,
	/** Чем интересуются — свободным текстом, как это написали на сайте. */
	interest: optionalText(1000),
	/** Программа справочника, если сайт знает её идентификатор. */
	programId: optionalId('Некорректный идентификатор программы'),
	/** Продукт справочника, если сайт знает его идентификатор. */
	productId: optionalId('Некорректный идентификатор продукта'),
	comment: optionalText(4000)
});

export type ApplicationIntakeInput = z.output<typeof applicationIntakeSchema>;

export const applicationResultSchema = z.object({
	interactionId: z.uuid().describe('Взаимодействие, которым стала заявка'),
	created: z
		.boolean()
		.describe('`false` — заявка с таким `externalId` уже принималась, вернулась прежняя запись')
});

export type ApplicationResult = z.output<typeof applicationResultSchema>;
