/**
 * Чтение снимков и показателей.
 *
 * Показатель здесь только читается: складывает его представление
 * `stat_program_indicators` (см. миграцию), потому что правило «что считается
 * актуальным» обязано быть одно. Второй раз изложенное на TypeScript, оно
 * однажды разойдётся с первым — и разойдётся молча, в отчёте.
 */
import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { id as idSchema, type PageResult } from '$lib/contracts/common';
import {
	explainScore,
	STAT_PREVIEW_PARSE_LIMIT,
	type MappingAdvice,
	type ProgramRankingItem,
	type RankingComponentKey,
	type StatIndicatorQuery,
	type StatIndicatorRow,
	type StatMapping,
	type StatPeriod,
	type StatRowView,
	type StatSnapshotListItem,
	type StatSnapshotListQuery,
	type StatSnapshotView
} from '$lib/contracts/stats';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import {
	documents,
	organizations,
	programs,
	sites,
	statProgramIndicators,
	statRows,
	statSnapshots,
	users
} from '../db/schema';
import { readStoredFile } from '../documents/storage';
import { NotFoundError } from '../errors';
import { requirePermission, scopeFilter } from '../rbac';
import { getMappingAdvisor } from './advisor';
import { fileFormatOf } from './format';
import { readTable, type SheetTable } from './parse';

const snapshotIdSchema = idSchema('Некорректный идентификатор снимка');

export function toStatSnapshotView(row: typeof statSnapshots.$inferSelect): StatSnapshotView {
	return {
		id: row.id,
		source: row.source,
		mode: row.mode,
		periodKind: row.periodKind,
		periodStart: row.periodStart,
		periodEnd: row.periodEnd,
		coverage: row.coverage,
		status: row.status,
		fileDocumentId: row.fileDocumentId,
		rowCount: row.rowCount,
		errorCount: row.errorCount,
		mapping: row.mapping,
		isCurrent: row.isCurrent,
		supersedesSnapshotId: row.supersedesSnapshotId,
		note: row.note,
		createdBy: row.createdBy,
		createdAt: row.createdAt,
		confirmedAt: row.confirmedAt,
		confirmedBy: row.confirmedBy
	};
}

function toListItem(
	row: typeof statSnapshots.$inferSelect,
	authorName: string | null,
	fileName: string | null
): StatSnapshotListItem {
	const view = toStatSnapshotView(row);

	return {
		...view,
		authorName,
		fileName,
		coverageSize:
			view.coverage.organizationIds.length +
			view.coverage.siteIds.length +
			view.coverage.programIds.length
	};
}

/**
 * Строка снимка из базы. Идентификатор приходит из адреса, то есть от кого
 * угодно: непохожая на UUID строка — это запрос несуществующей записи, а не
 * ошибка ввода.
 */
export async function selectSnapshotRow(
	snapshotId: string
): Promise<typeof statSnapshots.$inferSelect> {
	if (!snapshotIdSchema.safeParse(snapshotId).success) {
		throw new NotFoundError('Снимок данных не найден');
	}

	const [row] = await getDb()
		.select()
		.from(statSnapshots)
		.where(eq(statSnapshots.id, snapshotId))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Снимок данных не найден');
	}

	return row;
}

const SNAPSHOT_SORT_COLUMNS = {
	createdAt: statSnapshots.createdAt,
	periodStart: statSnapshots.periodStart,
	rowCount: statSnapshots.rowCount,
	errorCount: statSnapshots.errorCount
} as const satisfies Record<StatSnapshotListQuery['sortBy'], PgColumn>;

function ordered(column: PgColumn, direction: 'asc' | 'desc'): SQL {
	return direction === 'desc' ? desc(column) : asc(column);
}

/**
 * Страница списка снимков.
 *
 * Область доступа к снимку не применяется намеренно: снимок — это операция
 * оператора над своими данными, а не имущество организации. Одна загрузка
 * описывает сразу десятки вузов, и «показать её частично» значило бы показать
 * неверные счётчики. Область доступа работает там, где у строки есть ровно
 * одна организация, — на показателях и рейтинге ниже.
 */
export async function listSnapshots(
	ctx: ActorContext,
	query: StatSnapshotListQuery
): Promise<PageResult<StatSnapshotListItem>> {
	requirePermission(ctx, 'stats.read');

	const conditions: SQL[] = [];

	if (query.status !== null) {
		conditions.push(eq(statSnapshots.status, query.status));
	}

	if (query.source !== null) {
		conditions.push(eq(statSnapshots.source, query.source));
	}

	if (query.q !== null) {
		const pattern = `%${query.q}%`;
		const search = or(ilike(statSnapshots.note, pattern), ilike(documents.title, pattern));

		if (search !== undefined) {
			conditions.push(search);
		}
	}

	const where = conditions.length > 0 ? and(...conditions) : undefined;
	const db = getDb();

	const [rows, totals] = await Promise.all([
		db
			.select({ snapshot: statSnapshots, authorName: users.fullName, fileName: documents.title })
			.from(statSnapshots)
			.leftJoin(users, eq(users.id, statSnapshots.createdBy))
			.leftJoin(documents, eq(documents.id, statSnapshots.fileDocumentId))
			.where(where)
			// Второй ключ — первичный: два снимка одной загрузки отличаются
			// миллисекундами, и без него строка с границы страниц покажется дважды.
			.orderBy(
				ordered(SNAPSHOT_SORT_COLUMNS[query.sortBy], query.sortDirection),
				asc(statSnapshots.id)
			)
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db
			.select({ value: count() })
			.from(statSnapshots)
			.leftJoin(documents, eq(documents.id, statSnapshots.fileDocumentId))
			.where(where)
	]);

	return {
		items: rows.map((row) => toListItem(row.snapshot, row.authorName, row.fileName)),
		total: totals[0]?.value ?? 0,
		page: query.page,
		pageSize: query.pageSize
	};
}

export async function getSnapshot(ctx: ActorContext, id: string): Promise<StatSnapshotListItem> {
	requirePermission(ctx, 'stats.read');

	const row = await selectSnapshotRow(id);
	const db = getDb();

	const [author] =
		row.createdBy === null
			? []
			: await db.select({ name: users.fullName }).from(users).where(eq(users.id, row.createdBy));

	const [file] =
		row.fileDocumentId === null
			? []
			: await db
					.select({ title: documents.title })
					.from(documents)
					.where(eq(documents.id, row.fileDocumentId));

	return toListItem(row, author?.name ?? null, file?.title ?? null);
}

function toRowView(
	row: typeof statRows.$inferSelect,
	organizationName: string | null,
	siteName: string | null,
	programName: string | null
): StatRowView {
	return {
		id: row.id,
		rowNo: row.rowNo,
		organizationId: row.organizationId,
		organizationName,
		siteId: row.siteId,
		siteName,
		programId: row.programId,
		programName,
		periodStart: row.periodStart,
		periodEnd: row.periodEnd,
		applications: row.applications,
		enrolled: row.enrolled,
		parallelStreams: row.parallelStreams,
		completed: row.completed,
		coveragePlan: row.coveragePlan,
		coverageFact: row.coverageFact,
		issues: row.issues,
		isValid: row.isValid,
		version: row.version,
		replacedByRowId: row.replacedByRowId,
		raw: row.raw
	};
}

/**
 * Сколько строк снимка показывается за раз. Проверку открывают ради ошибок, а
 * не ради всех двадцати тысяч строк: счётчики отвечают за общую картину, а
 * список — за то, что именно поправить.
 */
export const SNAPSHOT_ROWS_PAGE = 100;

export type SnapshotRowsQuery = {
	/** Только строки с претензиями: с этим вопросом и открывают проверку. */
	onlyIssues: boolean;
	page: number;
	pageSize: number;
};

export async function listSnapshotRows(
	ctx: ActorContext,
	snapshotId: string,
	query: SnapshotRowsQuery
): Promise<PageResult<StatRowView>> {
	requirePermission(ctx, 'stats.read');

	const snapshot = await selectSnapshotRow(snapshotId);
	const conditions: SQL[] = [eq(statRows.snapshotId, snapshot.id)];

	if (query.onlyIssues) {
		conditions.push(eq(statRows.isValid, false));
	}

	const where = and(...conditions);
	const db = getDb();

	const [rows, totals] = await Promise.all([
		db
			.select({
				row: statRows,
				organizationName: organizations.shortName,
				siteName: sites.name,
				programName: programs.name
			})
			.from(statRows)
			.leftJoin(organizations, eq(organizations.id, statRows.organizationId))
			.leftJoin(sites, eq(sites.id, statRows.siteId))
			.leftJoin(programs, eq(programs.id, statRows.programId))
			.where(where)
			.orderBy(asc(statRows.rowNo))
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db.select({ value: count() }).from(statRows).where(where)
	]);

	return {
		items: rows.map((row) =>
			toRowView(row.row, row.organizationName, row.siteName, row.programName)
		),
		total: totals[0]?.value ?? 0,
		page: query.page,
		pageSize: query.pageSize
	};
}

/** Превью файла на шаге сопоставления: шапка, первые строки и подсказка. */
export type SnapshotPreview = {
	headers: string[];
	/** Первые строки файла: колонка → значение. */
	sample: Record<string, string>[];
	totalRows: number;
	advice: MappingAdvice[];
	/** Сопоставление, которое уже применено к снимку; пусто до первого шага. */
	mapping: StatMapping;
};

/**
 * Превью читается из файла заново, а не хранится в базе: файл неизменяем, и
 * второй его копии в строке снимка быть незачем.
 */
export async function getSnapshotPreview(
	ctx: ActorContext,
	snapshotId: string
): Promise<SnapshotPreview> {
	requirePermission(ctx, 'stats.read');

	const snapshot = await selectSnapshotRow(snapshotId);
	const table = await readSnapshotTable(snapshot, STAT_PREVIEW_PARSE_LIMIT);

	const sample = table.rows.map((cells) =>
		Object.fromEntries(table.headers.map((header, column) => [header, cells[column] ?? '']))
	);

	return {
		headers: table.headers,
		sample,
		totalRows: table.totalRows,
		advice: await getMappingAdvisor().suggest({ headers: table.headers, sample }),
		mapping: snapshot.mapping
	};
}

/** Таблица файла снимка. Общая для превью и для применения сопоставления. */
export async function readSnapshotTable(
	snapshot: typeof statSnapshots.$inferSelect,
	limit?: number
): Promise<SheetTable> {
	if (snapshot.fileDocumentId === null) {
		throw new NotFoundError('У снимка нет файла');
	}

	const [file] = await getDb()
		.select({ filePath: documents.filePath, mime: documents.mime })
		.from(documents)
		.where(eq(documents.id, snapshot.fileDocumentId))
		.limit(1);

	if (file === undefined) {
		throw new NotFoundError('Файл снимка не найден');
	}

	const bytes = await readStoredFile(file.filePath);

	return readTable(fileFormatOf(file.mime), bytes, limit);
}

/** Отчётные периоды, по которым есть подтверждённые данные. */
export async function listPeriods(ctx: ActorContext): Promise<StatPeriod[]> {
	requirePermission(ctx, 'stats.read');

	return getDb()
		.selectDistinct({
			kind: statProgramIndicators.periodKind,
			start: statProgramIndicators.periodStart,
			end: statProgramIndicators.periodEnd
		})
		.from(statProgramIndicators)
		.orderBy(desc(statProgramIndicators.periodStart));
}

/** Что предложить в фильтрах показателей: только то, по чему есть данные. */
export type IndicatorFilters = {
	programs: { id: string; label: string }[];
	organizations: { id: string; label: string }[];
};

/**
 * Списки фильтров собираются по самому представлению, а не по справочнику:
 * предлагать фильтр, под который нет ни одной строки, значит обещать пустой
 * экран.
 */
export async function listIndicatorFilters(ctx: ActorContext): Promise<IndicatorFilters> {
	requirePermission(ctx, 'stats.read');

	const db = getDb();
	const scope = scopeFilter(ctx, statProgramIndicators.organizationId);

	const [programRows, organizationRows] = await Promise.all([
		db
			.selectDistinct({ id: programs.id, code: programs.code, name: programs.name })
			.from(statProgramIndicators)
			.innerJoin(programs, eq(programs.id, statProgramIndicators.programId))
			.where(scope)
			.orderBy(asc(programs.code)),
		db
			.selectDistinct({ id: organizations.id, name: organizations.shortName })
			.from(statProgramIndicators)
			.innerJoin(organizations, eq(organizations.id, statProgramIndicators.organizationId))
			.where(scope)
			.orderBy(asc(organizations.shortName))
	]);

	return {
		programs: programRows.map((row) => ({ id: row.id, label: `${row.code} · ${row.name}` })),
		organizations: organizationRows.map((row) => ({ id: row.id, label: row.name }))
	};
}

function periodCondition(period: { start: string; end: string } | null): SQL[] {
	if (period === null) {
		return [];
	}

	return [
		eq(statProgramIndicators.periodStart, period.start),
		eq(statProgramIndicators.periodEnd, period.end)
	];
}

/**
 * Показатели по программам и организациям.
 *
 * Периоды не складываются между собой: если период не выбран, строки приходят
 * как есть, по одной на период. Сложить пересекающиеся периоды означало бы
 * посчитать одних и тех же обучающихся дважды.
 */
export async function listIndicators(
	ctx: ActorContext,
	query: StatIndicatorQuery
): Promise<PageResult<StatIndicatorRow>> {
	requirePermission(ctx, 'stats.read');

	const conditions: SQL[] = [
		scopeFilter(ctx, statProgramIndicators.organizationId),
		...periodCondition(query.period)
	];

	if (query.programId !== null) {
		conditions.push(eq(statProgramIndicators.programId, query.programId));
	}

	if (query.organizationId !== null) {
		conditions.push(eq(statProgramIndicators.organizationId, query.organizationId));
	}

	const where = and(...conditions);
	const db = getDb();

	const [rows, totals] = await Promise.all([
		db
			.select({
				programId: statProgramIndicators.programId,
				programCode: programs.code,
				programName: programs.name,
				organizationId: statProgramIndicators.organizationId,
				organizationName: organizations.shortName,
				periodKind: statProgramIndicators.periodKind,
				periodStart: statProgramIndicators.periodStart,
				periodEnd: statProgramIndicators.periodEnd,
				applications: statProgramIndicators.applications,
				enrolled: statProgramIndicators.enrolled,
				parallelStreams: statProgramIndicators.parallelStreams,
				completed: statProgramIndicators.completed,
				coveragePlan: statProgramIndicators.coveragePlan,
				coverageFact: statProgramIndicators.coverageFact,
				rowCount: statProgramIndicators.rowCount,
				snapshotCount: statProgramIndicators.snapshotCount
			})
			.from(statProgramIndicators)
			.innerJoin(programs, eq(programs.id, statProgramIndicators.programId))
			.innerJoin(organizations, eq(organizations.id, statProgramIndicators.organizationId))
			.where(where)
			.orderBy(
				asc(programs.code),
				asc(organizations.shortName),
				desc(statProgramIndicators.periodStart)
			)
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db.select({ value: count() }).from(statProgramIndicators).where(where)
	]);

	return {
		items: rows,
		total: totals[0]?.value ?? 0,
		page: query.page,
		pageSize: query.pageSize
	};
}

/**
 * Рейтинг программ за период.
 *
 * Порядок без объяснения — это не ответ: вместе с местом каждая программа
 * приносит разложение своего числа на слагаемые (`explainScore`), и сумма
 * вкладов равна самому числу. Веса — гипотеза до технического задания и живут
 * в контрактах рядом с объяснением.
 */
export async function rankPrograms(
	ctx: ActorContext,
	input: { period: { start: string; end: string } | null }
): Promise<ProgramRankingItem[]> {
	requirePermission(ctx, 'stats.read');

	const rows = await getDb()
		.select({
			programId: statProgramIndicators.programId,
			programCode: programs.code,
			programName: programs.name,
			applications: sql<number | null>`sum(${statProgramIndicators.applications})::integer`,
			enrolled: sql<number | null>`sum(${statProgramIndicators.enrolled})::integer`,
			parallelStreams: sql<number | null>`sum(${statProgramIndicators.parallelStreams})::integer`,
			organizationCount: sql<number>`count(distinct ${statProgramIndicators.organizationId})::integer`
		})
		.from(statProgramIndicators)
		.innerJoin(programs, eq(programs.id, statProgramIndicators.programId))
		.where(
			and(scopeFilter(ctx, statProgramIndicators.organizationId), ...periodCondition(input.period))
		)
		.groupBy(statProgramIndicators.programId, programs.code, programs.name);

	return (
		rows
			.map((row) => {
				const values: Record<RankingComponentKey, number | null> = {
					applications: row.applications,
					enrolled: row.enrolled,
					parallelStreams: row.parallelStreams
				};
				const { score, explanation } = explainScore(values);

				return {
					programId: row.programId,
					programCode: row.programCode,
					programName: row.programName,
					score,
					explanation,
					organizationCount: row.organizationCount
				};
			})
			// Равные баллы разводятся кодом программы: иначе порядок зависел бы от
			// того, в каком порядке PostgreSQL вернул группы.
			.sort(
				(left, right) =>
					right.score - left.score || left.programCode.localeCompare(right.programCode)
			)
	);
}
