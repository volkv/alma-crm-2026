/**
 * Журнал действий: словарь событий, правила для их подробностей и фильтр
 * выборки.
 *
 * Журнал — доказательство того, кто и что сделал, поэтому он неизменяем на
 * уровне базы, а в подробности события нельзя положить персональные данные:
 * иначе удалить их по требованию субъекта будет невозможно, не сломав журнал.
 */
import { z } from 'zod';
import { optionalId, optionalText, searchQuery } from './common';

/** Откуда пришло действие. */
export const AUDIT_SOURCES = ['ui', 'api', 'system'] as const;
/** Чем оно кончилось: сделано, не получилось, запрещено правами. */
export const AUDIT_OUTCOMES = ['success', 'failure', 'denied'] as const;

export type AuditSource = (typeof AUDIT_SOURCES)[number];
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * Полный словарь событий. Событие, которого здесь нет, записать нельзя:
 * так журнал остаётся пригодным для выборок и отчётов, а не превращается в
 * свалку произвольных строк.
 */
export const AUDIT_EVENT_TYPES = [
	'auth.login',
	'auth.logout',
	'auth.login_failed',
	'auth.locked',
	'auth.password_changed',
	'users.created',
	'users.updated',
	'users.role_changed',
	'users.activated',
	'users.deactivated',
	'settings.updated',
	'api_keys.created',
	'api_keys.revoked',
	'organizations.created',
	'organizations.updated',
	'organizations.deactivated',
	'organizations.site_created',
	'organizations.site_updated',
	'people.created',
	'people.updated',
	'people.affiliation_created',
	'people.affiliation_updated',
	'people.pii_viewed',
	'programs.created',
	'programs.updated',
	'programs.version_created',
	'programs.archived',
	'products.created',
	'products.updated',
	'products.archived',
	'interactions.created',
	'interactions.updated',
	'interactions.stage_advanced',
	'interactions.stage_returned',
	'interactions.stage_skipped',
	'interactions.paused',
	'interactions.resumed',
	'interactions.blocker_raised',
	'interactions.blocker_resolved',
	'interactions.confirmed',
	'documents.uploaded',
	'documents.generated',
	'documents.downloaded',
	'documents.status_changed',
	'audit.exported',
	'api.request'
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/**
 * Подробности события. Разрешены ссылки на другие записи (ключ заканчивается на
 * `Id`), список изменённых полей и закрытый список служебных полей запроса —
 * то есть то, что позволяет найти объект и понять, что происходило, но само по
 * себе ничего не рассказывает о человеке.
 */
export type AuditDetails = {
	changedFields?: readonly string[];
	/** Маршрут, по которому пришёл запрос к API: `/api/v1/organizations/[id]`. */
	route?: string;
	/** Метод запроса: `GET`, `POST`, … */
	method?: string;
	/** Код ответа, которым кончился запрос. */
	status?: number;
	/** Вход в публичную демонстрацию: учётная запись общая, а не личная. */
	demo?: boolean;
	[key: `${string}Id`]: string | undefined;
};

/**
 * Служебные поля и их типы. Список закрыт намеренно: маршрут, метод, код ответа
 * и признак демонстрационного входа персональных данных не несут, а любое поле
 * «ещё немного контекста» рано или поздно окажется текстом, который писал
 * человек.
 */
const REQUEST_DETAIL_KEYS = new Map<string, 'string' | 'number' | 'boolean'>([
	['route', 'string'],
	['method', 'string'],
	['status', 'number'],
	['demo', 'boolean']
]);

/** Ключи, которые в журнале запрещены прямо: за ними всегда стоят перс. данные. */
const FORBIDDEN_DETAIL_KEYS = new Set([
	'email',
	'phone',
	'password',
	'lastName',
	'firstName',
	'middleName'
]);

/**
 * Проверяет подробности события. Возвращает список претензий; пустой список —
 * значит, записывать можно. Функция чистая и не знает про HTTP: превращает
 * претензии в ошибку тот, кто пишет событие.
 */
export function validateAuditDetails(details: object): string[] {
	const issues: string[] = [];

	for (const [key, value] of Object.entries(details)) {
		if (key === 'changedFields') {
			if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
				issues.push('changedFields: ожидается список имён полей');
			}
			continue;
		}

		if (FORBIDDEN_DETAIL_KEYS.has(key)) {
			issues.push(`${key}: персональные данные в журнал не записываются`);
			continue;
		}

		const expected = REQUEST_DETAIL_KEYS.get(key);
		if (expected !== undefined) {
			if (typeof value !== expected) {
				issues.push(`${key}: ожидается значение типа ${expected}`);
			}
			continue;
		}

		if (!key.endsWith('Id')) {
			issues.push(
				`${key}: в подробностях допустимы ссылки вида <что-то>Id и поля ${[...REQUEST_DETAIL_KEYS.keys()].join(', ')}`
			);
			continue;
		}

		if (typeof value !== 'string') {
			issues.push(`${key}: идентификатор должен быть строкой`);
		}
	}

	return issues;
}

export const auditFilterSchema = z.object({
	/** Нижняя граница периода включительно. */
	from: z.iso
		.datetime({ offset: true, error: 'Дата начала указана неверно' })
		.nullable()
		.default(null),
	/** Верхняя граница периода включительно. */
	to: z.iso
		.datetime({ offset: true, error: 'Дата окончания указана неверно' })
		.nullable()
		.default(null),
	eventType: z.array(z.enum(AUDIT_EVENT_TYPES)).default([]),
	outcome: z.array(z.enum(AUDIT_OUTCOMES)).default([]),
	source: z.array(z.enum(AUDIT_SOURCES)).default([]),
	actorUserId: optionalId('Некорректный идентификатор пользователя'),
	subjectType: optionalText(100),
	subjectId: optionalId('Некорректный идентификатор объекта'),
	/** Поиск по подписи действующего лица и типу события. */
	q: searchQuery
});

export type AuditFilter = z.output<typeof auditFilterSchema>;

/** Формат выгрузки журнала. */
export const AUDIT_EXPORT_FORMATS = ['csv', 'json'] as const;

export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

export type AuditEventView = {
	id: string;
	occurredAt: Date;
	requestId: string;
	source: AuditSource;
	eventType: AuditEventType;
	outcome: AuditOutcome;
	actorUserId: string | null;
	apiKeyId: string | null;
	actorLabel: string;
	ip: string | null;
	userAgent: string | null;
	subjectType: string | null;
	subjectId: string | null;
	details: Record<string, unknown>;
};
