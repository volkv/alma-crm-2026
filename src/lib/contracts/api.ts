/**
 * Контракт публичного API.
 *
 * Здесь то, что видит интегратор: конверт ошибки, конверт страницы, ключи
 * доступа и представления записей в том виде, в каком они уезжают в JSON.
 * Внутренние представления (`OrganizationView` и прочие) отличаются от них
 * типами: в сервисах момент времени — это `Date`, а в JSON — строка ISO 8601.
 * Перевод делается здесь явно, иначе формат ответа менялся бы вместе с
 * внутренним типом, о котором интегратор ничего не знает.
 *
 * Серверных импортов в файле нет: те же схемы читает браузер и по ним же
 * собирается OpenAPI.
 */
import { z } from 'zod';
import { id, requiredText } from './common';
import { EDUCATION_LEVELS, ORGANIZATION_KINDS, type OrganizationView } from './directory';

/**
 * Коды ошибок API. Первые четыре повторяют коды предметных ошибок
 * (`$lib/server/errors`), остальные описывают то, что случилось в транспорте и
 * до сервиса не дошло.
 */
export const API_ERROR_CODES = [
	'validation',
	'forbidden',
	'not_found',
	'conflict',
	'unauthorized',
	'rate_limited',
	'idempotency_mismatch',
	'internal'
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Тело любого неуспешного ответа. `requestId` тот же, что в заголовке
 * `x-request-id`: по нему обращение интегратора находится в журнале и в логе
 * одной строкой. Ни стека, ни текста SQL здесь не бывает.
 */
export const apiErrorSchema = z.object({
	error: z.object({
		code: z.enum(API_ERROR_CODES),
		message: z.string(),
		requestId: z.string(),
		/** Разбор по полям у ошибок проверки и подсказки у остальных. */
		details: z.record(z.string(), z.unknown()).optional()
	})
});

export type ApiErrorBody = z.output<typeof apiErrorSchema>;

/**
 * Страница результатов. Поля те же, что у внутреннего `PageResult`, и имена
 * параметров запроса те же, что у `pageQuerySchema` (`page`, `pageSize`):
 * второй словарь для одного и того же понятия — это способ однажды разойтись.
 */
export function apiPageSchema<TItem extends z.ZodType>(item: TItem) {
	return z.object({
		items: z.array(item),
		total: z.number().int().nonnegative().describe('Сколько записей под фильтром всего'),
		page: z.number().int().min(1).describe('Номер выданной страницы, с единицы'),
		pageSize: z.number().int().min(1).describe('Размер страницы')
	});
}

export const apiOrganizationSchema = z.object({
	id: z.uuid(),
	kind: z.enum(ORGANIZATION_KINDS).describe('Вуз, компания-заказчик или оператор'),
	educationLevel: z
		.enum(EDUCATION_LEVELS)
		.nullable()
		.describe('Уровень образования; заполнен только у учебных заведений'),
	legalName: z.string(),
	shortName: z.string(),
	inn: z.string().nullable(),
	kpp: z.string().nullable(),
	ogrn: z.string().nullable(),
	region: z.string().nullable(),
	website: z.string().nullable(),
	notes: z.string().nullable(),
	isActive: z.boolean(),
	externalSource: z.string().nullable().describe('Система, из которой приехала запись'),
	externalId: z.string().nullable().describe('Идентификатор записи в этой системе'),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime()
});

export type ApiOrganization = z.output<typeof apiOrganizationSchema>;

export function toApiOrganization(view: OrganizationView): ApiOrganization {
	return {
		...view,
		createdAt: view.createdAt.toISOString(),
		updatedAt: view.updatedAt.toISOString()
	};
}

/**
 * Системы обмена, от имени которых бывает выпущен ключ. `crm` в этот список не
 * входит: ключ выпускают внешней системе, а не себе.
 */
export const API_KEY_EXCHANGE_SYSTEMS = ['cms', 'lms'] as const;

export type ApiKeyExchangeSystem = (typeof API_KEY_EXCHANGE_SYSTEMS)[number];

export const API_KEY_EXCHANGE_SYSTEM_LABELS: Record<ApiKeyExchangeSystem, string> = {
	cms: 'Сайт (CMS): заявки и статусы',
	lms: 'Система обучения (LMS): результаты групп'
};

/**
 * Ключ доступа выпускается на пользователя и действует его правами: у машины
 * не может быть прав больше, чем у человека, от имени которого она ходит.
 *
 * У ключа машинного субъекта есть вторая половина — подключение обмена, от
 * имени которого он работает. Права роли `service` одинаковы у всех таких
 * ключей, и без этого поля ключ сайта подавал бы результаты учебных групп, а
 * ключ системы обучения — заявки. У ключа на человека поле пустое: маршруты
 * обмена ему закрыты границей машинного субъекта.
 */
export const createApiKeySchema = z.object({
	name: requiredText(200, 'Укажите название ключа'),
	ownerUserId: id('Выберите владельца ключа'),
	exchangeSystem: z.enum(API_KEY_EXCHANGE_SYSTEMS).nullable().default(null)
});

export type CreateApiKeyInput = z.output<typeof createApiKeySchema>;

/** Ключ в списке. Самого ключа здесь нет и быть не может: в базе только хеш. */
export type ApiKeyView = {
	id: string;
	name: string;
	ownerUserId: string;
	/** Подключение обмена ключа; `null` — ключ выпущен на человека. */
	exchangeSystem: ApiKeyExchangeSystem | null;
	exchangeInstance: string | null;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
	createdAt: Date;
};

/**
 * Только что выпущенный ключ. `key` возвращается один раз — при создании; после
 * этого восстановить его неоткуда, и потерянный ключ можно только отозвать и
 * выпустить заново.
 */
export type CreatedApiKey = ApiKeyView & { key: string };
