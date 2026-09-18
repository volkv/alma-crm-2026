/**
 * Сборка отчёта: числа считает база, строки собираются только для тех, кого
 * показывают.
 *
 * Итоги, воронка, динамика и разрезы описывают всю выборку, а таблица на экране
 * — одну страницу из пятидесяти строк. Поэтому числа считаются агрегирующими
 * запросами по тем же условиям `where`, что у таблицы (`reports/aggregate.ts`),
 * а признаки строки — программы, продукты, направления, ответственный за вуз —
 * только для строк ответа. Выгрузка берёт набор целиком: файл, в котором строк
 * меньше, чем на экране, выглядит как правда и врёт.
 *
 * Единственность определения от этого не страдает: условия выборки написаны
 * один раз и подставляются и в строки, и в агрегаты. Что агрегат считает то же,
 * что подсчёт по полному набору строк, проверяет тест
 * (`tests/integration/reports/aggregates.test.ts`), сверяя выдачу с эталонным
 * пересчётом `recountFromRows`.
 *
 * Ценой за один набор остаётся потолок выборки (`REPORT_MAX_ROWS`): выше него
 * отчёт отказывается словами, а не режет молча.
 */
import { moscowDay, snapshotMoment } from '$lib/contracts/calendar';
import { PAUSE_REASON_LABELS } from '$lib/contracts/interactions';
import {
	REPORT_EVENT_KIND_LABELS,
	REPORT_MAX_ROWS,
	REPORT_PAGE_SIZE,
	REPORT_SCHEMA_VERSION,
	REPORT_STATE_LABELS,
	resolveColumns,
	reportSemantics,
	type ReportCell,
	type ReportEventKind,
	type ReportColumnDefinition,
	type ReportColumnView,
	type ReportQuery,
	type ReportView
} from '$lib/contracts/reports';
import { formatDate } from '$lib/format';
import type { ActorContext } from '../actor';
import { getConfig } from '../config';
import { ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import {
	readMovementAggregates,
	readSnapshotAggregates,
	type MovementEventCount
} from './aggregate';
import { buildBreakdowns, buildFunnelFromCounts, buildMovementChart } from './charts';
import type { ReportAttributes, ReportSelection, RowWindow } from './conditions';
import { describeFilters } from './describe';
import { movementEventKind, readMovementRows, type MovementRow } from './movement';
import { describeScope } from './query';
import { readSnapshotRows, type SnapshotRow } from './snapshot';
import { createStageIndex, readActiveProcessGroups, type StageIndex } from './stages';

const SECONDS_IN_DAY = 86_400;

function assertFits(count: number): void {
	if (count > REPORT_MAX_ROWS) {
		throw new ValidationError('Выборка слишком велика для одного отчёта', [
			`В неё попало больше ${REPORT_MAX_ROWS} строк`,
			'Сузьте период или добавьте фильтр — например, по вузу, направлению или ответственному'
		]);
	}
}

const EMPTY_TEXT: ReportCell = { kind: 'text', value: null };

function text(value: string | null): ReportCell {
	return { kind: 'text', value };
}

function list(values: readonly string[]): ReportCell {
	return { kind: 'list', values };
}

/** Абсолютная ссылка на карточку: в файле относительная не открывается. */
function interactionUrl(origin: string, interactionId: string): string {
	return `${origin}/interactions/${interactionId}`;
}

function attributeCell(
	key: ReportColumnDefinition['key'],
	row: ReportSelection & ReportAttributes,
	origin: string
): ReportCell | null {
	switch (key) {
		case 'interaction':
			return {
				kind: 'link',
				value: row.title,
				url: interactionUrl(origin, row.interactionId)
			};
		case 'organization':
			return text(row.organizationName);
		case 'directions':
			return list(row.directions);
		case 'products':
			return list(row.products);
		case 'contract':
			return text(row.contractNumber);
		case 'transferStatus':
			return list(row.transferStatuses);
		case 'state':
			return text(
				REPORT_STATE_LABELS[row.status as keyof typeof REPORT_STATE_LABELS] ?? row.status
			);
		case 'owner':
			return text(row.ownerName);
		case 'assignee':
			return list(row.assignees);
		default:
			return null;
	}
}

/** Просрочка на момент среза в днях; ноль просрочки — пустая ячейка, не ноль. */
function overdueDays(row: SnapshotRow): number | null {
	if (row.activeSeconds === null || row.slaDays === null) {
		return null;
	}

	const overdue = row.activeSeconds - row.slaDays * SECONDS_IN_DAY;

	return overdue > 0 ? Math.ceil(overdue / SECONDS_IN_DAY) : null;
}

function snapshotCell(
	column: ReportColumnDefinition,
	row: SnapshotRow,
	index: StageIndex,
	origin: string
): ReportCell {
	const common = attributeCell(column.key, row, origin);

	if (common !== null) {
		return common;
	}

	switch (column.key) {
		case 'stage':
			return row.stageKey === null
				? EMPTY_TEXT
				: text(index.label(row.processGroupId, row.stageKey, row.stageName).label);
		case 'stageEnteredAt':
			return { kind: 'date', value: row.enteredAt === null ? null : moscowDay(row.enteredAt) };
		case 'daysOnStage':
			return {
				kind: 'number',
				value: row.activeSeconds === null ? null : Math.floor(row.activeSeconds / SECONDS_IN_DAY)
			};
		case 'overdueDays':
			return { kind: 'number', value: overdueDays(row) };
		case 'paused':
			return text(row.pauseReason === null ? null : PAUSE_REASON_LABELS[row.pauseReason]);
		default:
			return EMPTY_TEXT;
	}
}

function movementCell(
	column: ReportColumnDefinition,
	row: MovementRow,
	index: StageIndex,
	origin: string
): ReportCell {
	const common = attributeCell(column.key, row, origin);

	if (common !== null) {
		return common;
	}

	switch (column.key) {
		case 'stageFrom':
			return row.fromKey === null
				? EMPTY_TEXT
				: text(index.label(row.processGroupId, row.fromKey, row.fromName).label);
		case 'stageTo':
			return row.toKey === null
				? EMPTY_TEXT
				: text(index.label(row.processGroupId, row.toKey, row.toName).label);
		case 'moveKind': {
			const kind = movementEventKind(row);

			return text(
				kind === 'migrated' ? 'Перенос при изменении процесса' : REPORT_EVENT_KIND_LABELS[kind]
			);
		}
		case 'movedAt':
			return { kind: 'datetime', value: row.movedAt.toISOString() };
		case 'moveReason':
			return text(row.moveReason);
		default:
			return EMPTY_TEXT;
	}
}

function columnViews(
	columns: readonly ReportColumnDefinition[],
	asOfDay: string
): ReportColumnView[] {
	return columns.map((column) => ({
		key: column.key,
		label: column.label,
		kind: column.kind,
		sort: column.sort,
		note: column.sort === 'historical' ? `на ${formatDate(asOfDay)}` : 'сейчас'
	}));
}

/** Страница отчёта: её номер, сколько их всего и строки именно этой. */
export type ReportPage = {
	view: ReportView;
	page: number;
	pages: number;
	pageSize: number;
};

/**
 * Окно строк по числу строк во всей выборке.
 *
 * Номер страницы приводится к действительному **после** того, как посчитаны
 * итоги: без числа строк во всей выборке страницу не с чем сравнить, а отдать
 * пустую таблицу на номер, набранный руками, значит показать «ничего не
 * нашлось» там, где нашлось. `requested` равен `null` у выгрузки: её набор
 * полный.
 */
function resolvePaging(
	total: number,
	requested: number | null
): { window: RowWindow | null; page: number; pages: number } {
	const pages = Math.max(1, Math.ceil(total / REPORT_PAGE_SIZE));

	if (requested === null) {
		return { window: null, page: 1, pages };
	}

	const page = Number.isInteger(requested) && requested >= 1 ? Math.min(requested, pages) : 1;

	return {
		window: { limit: REPORT_PAGE_SIZE, offset: (page - 1) * REPORT_PAGE_SIZE },
		page,
		pages
	};
}

/**
 * Виды событий по группам, посчитанным базой.
 *
 * Перенос при изменении процесса переходом не считается: он не строка движения,
 * а отметка под диаграммой. Выборка его уже отбросила тем же условием, поэтому
 * группа с таким видом означала бы расхождение двух формулировок одного
 * признака — и его ловит инвариант И3: сумма по видам перестала бы сходиться с
 * числом строк.
 */
function movementSeries(
	events: readonly MovementEventCount[]
): { kind: ReportEventKind; day: string; count: number }[] {
	const series: { kind: ReportEventKind; day: string; count: number }[] = [];

	for (const event of events) {
		const kind = movementEventKind(event);

		if (kind !== 'migrated') {
			series.push({ kind, day: event.day, count: event.count });
		}
	}

	return series;
}

/**
 * Отчёт целиком. Право — `interactions.read`: отчёт показывает ровно то, что
 * человек и так видит в списке, и своего права у раздела нет.
 *
 * `requested` — номер страницы экрана; `null` означает всю выборку: так отчёт
 * собирает выгрузка, и так же его строит проверка инвариантов.
 */
async function assembleReport(
	ctx: ActorContext,
	query: ReportQuery,
	requested: number | null
): Promise<ReportPage> {
	requirePermission(ctx, 'interactions.read');

	const origin = getConfig().ORIGIN.replace(/\/$/, '');
	const asOf = snapshotMoment(query.to);
	const index = createStageIndex(await readActiveProcessGroups());
	const columns = resolveColumns(query.mode, query.cols);

	const meta = {
		schemaVersion: REPORT_SCHEMA_VERSION,
		generatedAt: new Date().toISOString(),
		asOf: asOf.toISOString(),
		mode: query.mode,
		period: { start: query.from, end: query.to },
		filters: await describeFilters(query, index.stageName),
		scope: describeScope(ctx),
		semantics: reportSemantics(query.mode, query.from, query.to),
		columns: columnViews(columns, query.to)
	};

	if (query.mode === 'movement') {
		// Числа считаются до строк: потолок выборки проверяется по ним, страница
		// считается от них же, и отказ не стоит вычитанных впустую трёх тысяч
		// строк.
		const aggregates = await readMovementAggregates(ctx, query);

		assertFits(aggregates.totals.rowCount);

		const paging = resolvePaging(aggregates.totals.rowCount, requested);
		const rows = await readMovementRows(ctx, query, {
			migrations: 'exclude',
			window: paging.window
		});

		return {
			page: paging.page,
			pages: paging.pages,
			pageSize: REPORT_PAGE_SIZE,
			view: {
				meta,
				rows: rows.map((row) => ({
					// Вид события плюс запись о стадии: одна запись даёт начало работы и
					// уход с неё двумя строками, и различает их только вид.
					rowKey: `${movementEventKind(row)}:${row.entryId}`,
					interactionId: row.interactionId,
					stageEntryId: row.entryId,
					cells: columns.map((column) => movementCell(column, row, index, origin))
				})),
				totals: aggregates.totals,
				charts: {
					funnel: null,
					movement: buildMovementChart(
						query.from,
						query.to,
						movementSeries(aggregates.events),
						aggregates.migrated
					),
					breakdowns: buildBreakdowns(aggregates.breakdowns)
				}
			}
		};
	}

	const aggregates = await readSnapshotAggregates(ctx, query);

	assertFits(aggregates.totals.rowCount);

	const paging = resolvePaging(aggregates.totals.rowCount, requested);
	const rows = await readSnapshotRows(ctx, query, paging.window);

	return {
		page: paging.page,
		pages: paging.pages,
		pageSize: REPORT_PAGE_SIZE,
		view: {
			meta,
			rows: rows.map((row) => ({
				// В срезе каждое взаимодействие встречается ровно один раз (инвариант И2),
				// поэтому его идентификатор и есть имя строки.
				rowKey: row.interactionId,
				interactionId: row.interactionId,
				stageEntryId: row.entryId,
				cells: columns.map((column) => snapshotCell(column, row, index, origin))
			})),
			totals: aggregates.totals,
			charts: {
				funnel: buildFunnelFromCounts(index, aggregates.stages, aggregates.closed),
				movement: null,
				breakdowns: buildBreakdowns(aggregates.breakdowns)
			}
		}
	};
}

/**
 * Отчёт целиком: вся выборка одним набором. Так его собирает выгрузка и так же
 * его строят проверки инвариантов.
 */
export async function buildReport(ctx: ActorContext, query: ReportQuery): Promise<ReportView> {
	return (await assembleReport(ctx, query, null)).view;
}

/** Отчёт для экрана: страница строк, итоги и диаграммы по всей выборке. */
export async function buildReportPage(
	ctx: ActorContext,
	query: ReportQuery,
	requested: number
): Promise<ReportPage> {
	return assembleReport(ctx, query, requested);
}
