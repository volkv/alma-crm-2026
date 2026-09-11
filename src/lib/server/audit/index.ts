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
import { requirePermission } from '../rbac';

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
		actorLabel: actorLabel(ctx),
		ip: ctx.ip,
		userAgent: ctx.userAgent,
		subjectType: event.subject?.type ?? null,
		subjectId: event.subject?.id ?? null,
		details
	});
}

function auditWhere(filter: AuditFilter): SQL | undefined {
	const conditions: SQL[] = [];

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

	const where = auditWhere(filter);
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
	return `"${text.replaceAll('"', '""')}"`;
}

export async function exportAuditEvents(
	ctx: ActorContext,
	filter: AuditFilter,
	format: AuditExportFormat
): Promise<AuditExport> {
	requirePermission(ctx, 'audit.export');

	const where = auditWhere(filter);
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

	const views = rows.map(toAuditEventView);
	const stamp = new Date().toISOString().slice(0, 10);

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
