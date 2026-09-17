/**
 * Запись и чтение журнала действий.
 *
 * Журнал отвечает на вопрос «кто и что сделал», поэтому у него два свойства,
 * которых нет у обычной таблицы. Во-первых, он неизменяем: UPDATE и DELETE
 * запрещает триггер в базе. Во-вторых, неудача и отказ записываются отдельным
 * соединением — иначе откат транзакции, внутри которой всё и сломалось, унёс бы
 * с собой и запись о том, что кто-то пытался.
 */
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, type SQL } from 'drizzle-orm';
import type { PageQuery, PageResult } from '$lib/contracts/common';
import {
	maskAuditEvent,
	validateAuditDetails,
	type AuditDetails,
	type AuditEventType,
	type AuditEventView,
	type AuditExportFormat,
	type AuditFilter,
	type AuditOutcome
} from '$lib/contracts/audit';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { auditEvents } from '../db/schema';
import type { Tx } from '../db/transaction';
import { ValidationError } from '../errors';
import { actorScopeFilter, requirePermission } from '../rbac';
import { spreadsheetText } from '../spreadsheet';

export type { AuditEventType } from '$lib/contracts/audit';

/** Одно событие журнала в том виде, в каком его подаёт сервис. */
export type AuditEventInput = {
	type: AuditEventType;
	outcome: AuditOutcome;
	/** Над чем действовали: имя сущности и её идентификатор. */
	subject?: { type: string; id: string };
	details?: AuditDetails;
};

/** Подпись действующего лица на момент события. */
function actorLabel(ctx: ActorContext): string {
	if (ctx.user !== null) {
		return ctx.user.fullName;
	}

	return ctx.source === 'system' ? 'Система' : 'Аноним';
}

/**
 * Потолок строки клиента. Её задаёт тот, кто обращается: заголовок
 * `User-Agent` не проверяет никто, и без потолка одна запись журнала унесёт в
 * базу столько, сколько влезло в запрос. 512 байт — вдвое больше самой длинной
 * строки настоящего браузера.
 */
const USER_AGENT_MAX_BYTES = 512;

/**
 * Потолок подписи действующего лица. Имя приходит из учётной записи и уже
 * ограничено контрактом, но журнал пишется и с той стороны, где контракта нет
 * (сид, фоновые задачи), а столбец — `text` без длины.
 */
const ACTOR_LABEL_MAX_BYTES = 200;

/**
 * Обрезка строки по числу байт в UTF-8.
 *
 * Считается байтами, а не символами: место в базе и потолок на запись меряются
 * байтами, и кириллическая строка «в 512 символов» весит вдвое больше. Хвост
 * незавершённой последовательности отбрасывает потоковый декодер — иначе на
 * срезе посреди буквы в журнал легла бы «замена» вместо символа.
 */
function truncateBytes(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, 'utf8');

	if (bytes.byteLength <= maxBytes) {
		return value;
	}

	return new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true });
}

export async function recordAuditEvent(
	ctx: ActorContext,
	event: AuditEventInput,
	tx?: Tx
): Promise<void> {
	const details = event.details ?? {};
	const issues = validateAuditDetails(details);

	if (issues.length > 0) {
		throw new ValidationError('Подробности события журнала недопустимы', issues);
	}

	// Успех — часть той же транзакции, что и само действие: не случилось
	// действие — не должно остаться и записи о нём. Неудача и отказ пишутся
	// отдельным соединением, потому что транзакция вокруг них обычно
	// откатывается, а знать о попытке нужно именно тогда.
	const writer = tx !== undefined && event.outcome === 'success' ? tx : getDb();

	await writer.insert(auditEvents).values({
		requestId: ctx.requestId,
		source: ctx.source,
		eventType: event.type,
		outcome: event.outcome,
		actorUserId: ctx.user?.id ?? null,
		apiKeyId: ctx.apiKeyId,
		actorLabel: truncateBytes(actorLabel(ctx), ACTOR_LABEL_MAX_BYTES),
		ip: ctx.ip,
		userAgent: ctx.userAgent === null ? null : truncateBytes(ctx.userAgent, USER_AGENT_MAX_BYTES),
		subjectType: event.subject?.type ?? null,
		subjectId: event.subject?.id ?? null,
		details
	});
}

function auditWhere(ctx: ActorContext, filter: AuditFilter): SQL | undefined {
	// Срез области: руководитель видит, что делали его люди, — по действующему
	// лицу события, а не по записи, которой оно касалось. Предмет события
	// назван парой «тип — идентификатор», разрешать этот полиморфизм в SQL
	// дорого и легко ошибиться, а «что делали мои люди» — это тот самый вопрос,
	// ради которого руководителю журнал и нужен. События без действующего лица
	// (системные, фоновые) видит только полный доступ.
	const conditions: SQL[] = [actorScopeFilter(ctx, auditEvents.actorUserId)];

	if (filter.from !== null) {
		conditions.push(gte(auditEvents.occurredAt, new Date(filter.from)));
	}
	if (filter.to !== null) {
		conditions.push(lte(auditEvents.occurredAt, new Date(filter.to)));
	}
	if (filter.eventType.length > 0) {
		conditions.push(inArray(auditEvents.eventType, [...filter.eventType]));
	}
	if (filter.outcome.length > 0) {
		conditions.push(inArray(auditEvents.outcome, [...filter.outcome]));
	}
	if (filter.source.length > 0) {
		conditions.push(inArray(auditEvents.source, [...filter.source]));
	}
	if (filter.actorUserId !== null) {
		conditions.push(eq(auditEvents.actorUserId, filter.actorUserId));
	}
	if (filter.subjectType !== null) {
		conditions.push(eq(auditEvents.subjectType, filter.subjectType));
	}
	if (filter.subjectId !== null) {
		conditions.push(eq(auditEvents.subjectId, filter.subjectId));
	}
	if (filter.q !== null) {
		const pattern = `%${filter.q}%`;
		const search = or(
			ilike(auditEvents.actorLabel, pattern),
			ilike(auditEvents.eventType, pattern)
		);
		if (search !== undefined) {
			conditions.push(search);
		}
	}

	return conditions.length === 0 ? undefined : and(...conditions);
}

/** Строка базы приводится к представлению: наружу типы Drizzle не выходят. */
function toAuditEventView(row: typeof auditEvents.$inferSelect): AuditEventView {
	return {
		id: row.id,
		occurredAt: row.occurredAt,
		requestId: row.requestId,
		source: row.source,
		eventType: row.eventType as AuditEventType,
		outcome: row.outcome,
		actorUserId: row.actorUserId,
		apiKeyId: row.apiKeyId,
		actorLabel: row.actorLabel,
		ip: row.ip,
		userAgent: row.userAgent,
		subjectType: row.subjectType,
		subjectId: row.subjectId,
		details: (row.details ?? {}) as Record<string, unknown>
	};
}

export async function listAuditEvents(
	ctx: ActorContext,
	filter: AuditFilter,
	page: PageQuery
): Promise<PageResult<AuditEventView>> {
	requirePermission(ctx, 'audit.read');

	const where = auditWhere(ctx, filter);
	const db = getDb();

	const [rows, totals] = await Promise.all([
		db
			.select()
			.from(auditEvents)
			.where(where)
			.orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
			.limit(page.pageSize)
			.offset((page.page - 1) * page.pageSize),
		db.select({ value: count() }).from(auditEvents).where(where)
	]);

	return {
		items: rows.map(toAuditEventView),
		total: totals[0]?.value ?? 0,
		page: page.page,
		pageSize: page.pageSize
	};
}

/** Потолок выгрузки: больше — это уже дамп базы, а не отчёт за период. */
export const AUDIT_EXPORT_MAX_ROWS = 50_000;

export type AuditExport = {
	fileName: string;
	contentType: string;
	body: string;
};

/**
 * Календарные сутки по Москве — те же, которыми задаются границы фильтра. По
 * UTC выгрузка, снятая вечером, называлась бы вчерашним числом, и два файла за
 * один рабочий день оператора разъехались бы по датам. `en-CA` даёт ровно
 * `2026-09-12`: имя файла читают и глазами, и сортировкой по имени.
 */
const exportStampFormat = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'Europe/Moscow',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});

const CSV_COLUMNS = [
	'occurred_at',
	'request_id',
	'source',
	'event_type',
	'outcome',
	'actor_label',
	'actor_user_id',
	'api_key_id',
	'ip',
	'user_agent',
	'subject_type',
	'subject_id',
	'details'
] as const;

function csvCell(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}

	const text = value instanceof Date ? value.toISOString() : String(value);

	// Кавычки вокруг ячейки формулу не обезвреживают: таблица разбирает
	// содержимое уже после них, и `=HYPERLINK(...)`, приехавший строкой клиента
	// в журнал, выполнится у того, кто открыл выгрузку. Обезвреживает
	// `spreadsheetText` — правило одно на все выгрузки продукта.
	return `"${spreadsheetText(text).replaceAll('"', '""')}"`;
}

export async function exportAuditEvents(
	ctx: ActorContext,
	filter: AuditFilter,
	format: AuditExportFormat
): Promise<AuditExport> {
	requirePermission(ctx, 'audit.export');

	// Тот же срез, что у ленты: «файл содержит ровно те строки, что экран» —
	// потому что условие собирается одной функцией, а не двумя похожими.
	const where = auditWhere(ctx, filter);
	const db = getDb();

	const [totals] = await db.select({ value: count() }).from(auditEvents).where(where);
	const total = totals?.value ?? 0;

	if (total > AUDIT_EXPORT_MAX_ROWS) {
		throw new ValidationError(`Под фильтр попало ${total} записей — сузьте период или условия`, [
			`За один раз выгружается не больше ${AUDIT_EXPORT_MAX_ROWS} записей`
		]);
	}

	const rows = await db
		.select()
		.from(auditEvents)
		.where(where)
		.orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));

	// Огрубление то же, что на экране: выгрузка — это экран файлом, и если она
	// уносит настоящий адрес и клиента посетителей стенда, то показанное на
	// экране огрубление ничего не значит.
	const views = rows
		.map(toAuditEventView)
		.map((view) => (ctx.user?.isDemo === true ? maskAuditEvent(view) : view));
	const stamp = exportStampFormat.format(new Date());

	await recordAuditEvent(ctx, { type: 'audit.exported', outcome: 'success' });

	if (format === 'json') {
		return {
			fileName: `audit-${stamp}.json`,
			contentType: 'application/json; charset=utf-8',
			body: JSON.stringify(views, null, 2)
		};
	}

	const lines = [CSV_COLUMNS.join(';')];
	for (const view of views) {
		lines.push(
			[
				csvCell(view.occurredAt),
				csvCell(view.requestId),
				csvCell(view.source),
				csvCell(view.eventType),
				csvCell(view.outcome),
				csvCell(view.actorLabel),
				csvCell(view.actorUserId),
				csvCell(view.apiKeyId),
				csvCell(view.ip),
				csvCell(view.userAgent),
				csvCell(view.subjectType),
				csvCell(view.subjectId),
				csvCell(JSON.stringify(view.details))
			].join(';')
		);
	}

	return {
		fileName: `audit-${stamp}.csv`,
		contentType: 'text/csv; charset=utf-8',
		// BOM: без него Excel читает кириллицу в CSV как мусор.
		body: `\uFEFF${lines.join('\r\n')}\r\n`
	};
}
