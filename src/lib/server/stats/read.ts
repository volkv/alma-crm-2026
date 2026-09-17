/**
 * Чтение снимков и показателей.
 *
 * Показатель здесь только читается: складывает его представление
 * `stat_program_indicators` (см. миграцию), потому что правило «что считается
 * актуальным» обязано быть одно. Второй раз изложенное на TypeScript, оно
 * однажды разойдётся с первым — и разойдётся молча, в отчёте.
 */
import { and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { id as idSchema, type PageResult } from '$lib/contracts/common';
import {
	explainScore,
	statProgramGroupOf,
	STAT_PREVIEW_PARSE_LIMIT,
	STAT_PROGRAM_GROUPS,
	type MappingAdvice,
	type ProgramRankingItem,
	type RankingComponentKey,
	type StatDashboardGroupRow,
	type StatDashboardOrganizationRow,
	type StatDashboardSource,
	type StatIndicatorQuery,
	type StatIndicatorRow,
	type StatMapping,
	type StatMeasures,
	type StatProgramGroup,
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
	// Один снимок смешивает строки нескольких вузов: сам по себе он не
	// принадлежит никому, а каждая его строка — принадлежит. Поэтому область
	// применяется к строкам, а не к снимку, и человек видит в чужой загрузке
	// только свои вузы.
	//
	// Строка, у которой вуз не опознан, остаётся видна всем: она не принадлежит
	// никому, а ради неё проверку и открывают — спрятать её значило бы показать
	// экран, на котором не видно, что именно не разобралось.
	const conditions: SQL[] = [
		eq(statRows.snapshotId, snapshot.id),
		sql`(${isNull(statRows.organizationId)} or ${scopeFilter(ctx, statRows.organizationId)})`
	];

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
	// Право загрузки, а не чтения: превью показывает строки файла как есть — до
	// того, как они разложились по вузам, — и области на них ещё нет. Экран
	// сопоставления открывает тот, кто снимок и загружает.
	requirePermission(ctx, 'stats.import');

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

/**
 * Суммы показателей за период. Складываются уже сложенные представлением
 * числа, и `sum` по-прежнему пропускает `NULL`: сумма по пустой колонке — это
 * `NULL`, а не ноль.
 */
const INDICATOR_SUMS = {
	applications: sql<number | null>`sum(${statProgramIndicators.applications})::integer`,
	enrolled: sql<number | null>`sum(${statProgramIndicators.enrolled})::integer`,
	parallelStreams: sql<number | null>`sum(${statProgramIndicators.parallelStreams})::integer`,
	completed: sql<number | null>`sum(${statProgramIndicators.completed})::integer`,
	coveragePlan: sql<number | null>`sum(${statProgramIndicators.coveragePlan})::integer`,
	coverageFact: sql<number | null>`sum(${statProgramIndicators.coverageFact})::integer`
} as const;

const PROGRAM_COUNT = sql<number>`count(distinct ${statProgramIndicators.programId})::integer`;
const ORGANIZATION_COUNT = sql<number>`count(distinct ${statProgramIndicators.organizationId})::integer`;

/** Пустые показатели: период есть, а строк под него в области доступа нет. */
const NO_MEASURES: StatMeasures = {
	applications: null,
	enrolled: null,
	parallelStreams: null,
	completed: null,
	coveragePlan: null,
	coverageFact: null
};

function dashboardWhere(
	ctx: ActorContext,
	period: { start: string; end: string }
): SQL | undefined {
	return and(scopeFilter(ctx, statProgramIndicators.organizationId), ...periodCondition(period));
}

/** Портфель периода целиком — без площадок: их представление не хранит. */
export async function readDashboardTotals(
	ctx: ActorContext,
	period: { start: string; end: string }
): Promise<StatMeasures & { programCount: number; organizationCount: number }> {
	requirePermission(ctx, 'stats.read');

	const [row] = await getDb()
		.select({
			programCount: PROGRAM_COUNT,
			organizationCount: ORGANIZATION_COUNT,
			...INDICATOR_SUMS
		})
		.from(statProgramIndicators)
		.where(dashboardWhere(ctx, period));

	return row ?? { programCount: 0, organizationCount: 0, ...NO_MEASURES };
}

/**
 * Разбивка по группам программ: школьные отдельно от вузовских.
 *
 * Группу считает не база, а `statProgramGroupOf`: уровень программы лежит в
 * справочнике, а то, как уровни сводятся в группы, — правило показателей, и
 * изложенное вторым языком в SQL оно разойдётся с первым.
 */
export async function readDashboardGroups(
	ctx: ActorContext,
	period: { start: string; end: string }
): Promise<StatDashboardGroupRow[]> {
	requirePermission(ctx, 'stats.read');

	const rows = await getDb()
		.select({ level: programs.level, programCount: PROGRAM_COUNT, ...INDICATOR_SUMS })
		.from(statProgramIndicators)
		.innerJoin(programs, eq(programs.id, statProgramIndicators.programId))
		.where(dashboardWhere(ctx, period))
		.groupBy(programs.level);

	const byGroup = new Map<StatProgramGroup, StatDashboardGroupRow>();

	for (const row of rows) {
		const group = statProgramGroupOf(row.level);
		const current = byGroup.get(group) ?? { group, programCount: 0, ...NO_MEASURES };

		byGroup.set(group, {
			group,
			programCount: current.programCount + row.programCount,
			...addMeasures(current, row)
		});
	}

	// Порядок групп — объявленный, а не тот, в каком PostgreSQL вернул уровни.
	return STAT_PROGRAM_GROUPS.map((group) => byGroup.get(group)).filter(
		(row): row is StatDashboardGroupRow => row !== undefined
	);
}

/**
 * Сложение показателей, в котором `null` остаётся `null`, пока не встретилось
 * ни одного числа: «нет данных» плюс «нет данных» — это по-прежнему нет данных,
 * а не ноль.
 */
function addMeasures(left: StatMeasures, right: StatMeasures): StatMeasures {
	const add = (a: number | null, b: number | null): number | null =>
		a === null ? b : b === null ? a : a + b;

	return {
		applications: add(left.applications, right.applications),
		enrolled: add(left.enrolled, right.enrolled),
		parallelStreams: add(left.parallelStreams, right.parallelStreams),
		completed: add(left.completed, right.completed),
		coveragePlan: add(left.coveragePlan, right.coveragePlan),
		coverageFact: add(left.coverageFact, right.coverageFact)
	};
}

/** Распределение по вузам: по строке на организацию, порядок — по названию. */
export async function readDashboardOrganizations(
	ctx: ActorContext,
	period: { start: string; end: string }
): Promise<StatDashboardOrganizationRow[]> {
	requirePermission(ctx, 'stats.read');

	return getDb()
		.select({
			organizationId: statProgramIndicators.organizationId,
			organizationName: organizations.shortName,
			programCount: PROGRAM_COUNT,
			...INDICATOR_SUMS
		})
		.from(statProgramIndicators)
		.innerJoin(organizations, eq(organizations.id, statProgramIndicators.organizationId))
		.where(dashboardWhere(ctx, period))
		.groupBy(statProgramIndicators.organizationId, organizations.shortName)
		.orderBy(asc(organizations.shortName), asc(statProgramIndicators.organizationId));
}

/**
 * Строки, из которых представление сложило период.
 *
 * Условия те же, что у `stat_program_indicators`, и повторены они ровно
 * потому, что представление складывает строки, а здесь нужно обратное — какие
 * загрузки за ними стоят и какие площадки в них названы. Числа по-прежнему
 * считает представление: отсюда приходят только происхождение и счётчики строк.
 */
function dashboardRowsWhere(
	ctx: ActorContext,
	period: { start: string; end: string }
): SQL | undefined {
	return and(
		eq(statSnapshots.status, 'confirmed'),
		eq(statSnapshots.isCurrent, true),
		eq(statRows.isValid, true),
		isNull(statRows.replacedByRowId),
		eq(statRows.periodStart, period.start),
		eq(statRows.periodEnd, period.end),
		scopeFilter(ctx, statRows.organizationId)
	);
}

export type DashboardOrigin = {
	sources: StatDashboardSource[];
	/** Площадок, названных в строках периода; площадка в строке необязательна. */
	siteCount: number;
};

export async function readDashboardOrigin(
	ctx: ActorContext,
	period: { start: string; end: string }
): Promise<DashboardOrigin> {
	requirePermission(ctx, 'stats.read');

	const db = getDb();
	const where = dashboardRowsWhere(ctx, period);

	const [rows, siteTotals] = await Promise.all([
		db
			.select({
				snapshotId: statSnapshots.id,
				source: statSnapshots.source,
				mode: statSnapshots.mode,
				confirmedAt: statSnapshots.confirmedAt,
				fileName: documents.title,
				authorName: users.fullName,
				rowCount: sql<number>`count(*)::integer`
			})
			.from(statRows)
			.innerJoin(statSnapshots, eq(statSnapshots.id, statRows.snapshotId))
			.leftJoin(documents, eq(documents.id, statSnapshots.fileDocumentId))
			.leftJoin(users, eq(users.id, statSnapshots.createdBy))
			.where(where)
			.groupBy(statSnapshots.id, documents.title, users.fullName)
			.orderBy(desc(statSnapshots.confirmedAt), asc(statSnapshots.id)),
		db
			.select({ value: sql<number>`count(distinct ${statRows.siteId})::integer` })
			.from(statRows)
			.innerJoin(statSnapshots, eq(statSnapshots.id, statRows.snapshotId))
			.where(where)
	]);

	return {
		sources: rows.map((row) => ({
			snapshotId: row.snapshotId,
			source: row.source,
			mode: row.mode,
			fileName: row.fileName,
			authorName: row.authorName,
			// Строкой, а не `Date`: представление дашборда лежит в кэше как JSON.
			confirmedAt: row.confirmedAt?.toISOString() ?? null,
			rowCount: row.rowCount
		})),
		siteCount: siteTotals[0]?.value ?? 0
	};
}
