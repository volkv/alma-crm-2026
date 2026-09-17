/**
 * Сборка отчёта: один набор строк, из которого считаются и таблица, и итоги, и
 * серии диаграмм, и все четыре файла.
 *
 * Набор считается один раз намеренно. Вторая выборка ради итогов или ради
 * диаграммы — это второе определение тех же чисел, и однажды они разойдутся;
 * ценой за единственное определение служит потолок выборки
 * (`REPORT_MAX_ROWS`): выше него отчёт отказывается словами, а не режет молча.
 */
import { PAUSE_REASON_LABELS } from '$lib/contracts/interactions';
import {
	REPORT_EVENT_KIND_LABELS,
	REPORT_MAX_ROWS,
	REPORT_SCHEMA_VERSION,
	REPORT_STATE_LABELS,
	moscowDay,
	resolveColumns,
	reportSemantics,
	snapshotMoment,
	type ReportCell,
	type ReportColumnDefinition,
	type ReportColumnView,
	type ReportEventKind,
	type ReportQuery,
	type ReportRow,
	type ReportView
} from '$lib/contracts/reports';
import { formatDate } from '$lib/format';
import type { ActorContext } from '../actor';
import { getConfig } from '../config';
import { ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { buildBreakdown, buildFunnel, buildMovementChart, type BreakdownValues } from './charts';
import type { ReportAttributes } from './conditions';
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
	row: ReportAttributes & { interactionId: string; title: string; status: string },
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

function isOverdue(row: SnapshotRow): boolean {
	return (
		row.activeSeconds !== null &&
		row.slaDays !== null &&
		row.activeSeconds > row.slaDays * SECONDS_IN_DAY
	);
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

/** Разрезы выборки. Считаются по тем же строкам, что и таблица. */
function breakdowns(rows: readonly (ReportAttributes & { ownerUserId: string })[]) {
	const organizations: BreakdownValues[] = rows.map((row) => ({
		ids: row.organizationId === null ? [] : [row.organizationId],
		names: row.organizationName === null ? [] : [row.organizationName]
	}));

	return [
		buildBreakdown('organizations', 'По вузам и контрагентам', 'org', organizations),
		buildBreakdown(
			'directions',
			'По направлениям',
			'dir',
			rows.map((row) => ({ ids: row.directionIds, names: row.directions }))
		),
		buildBreakdown(
			'products',
			'По продуктам',
			'prod',
			rows.map((row) => ({ ids: row.productIds, names: row.products }))
		),
		buildBreakdown(
			'owners',
			'По ответственным',
			'owner',
			rows.map((row) => ({ ids: [row.ownerUserId], names: [row.ownerName ?? row.ownerUserId] }))
		)
	];
}

/**
 * Отчёт целиком. Право — `interactions.read`: отчёт показывает ровно то, что
 * человек и так видит в списке, и своего права у раздела нет.
 */
export async function buildReport(ctx: ActorContext, query: ReportQuery): Promise<ReportView> {
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
		const raw = await readMovementRows(ctx, query);

		assertFits(raw.length);

		// Перенос при изменении процесса переходом не считается: он не строка
		// движения, а отметка под диаграммой.
		const events: { row: MovementRow; kind: ReportEventKind }[] = [];
		let migrated = 0;

		for (const row of raw) {
			const kind = movementEventKind(row);

			if (kind === 'migrated') {
				migrated += 1;
			} else {
				events.push({ row, kind });
			}
		}

		const rows: ReportRow[] = events.map(({ row }) => ({
			interactionId: row.interactionId,
			stageEntryId: row.entryId,
			cells: columns.map((column) => movementCell(column, row, index, origin))
		}));

		return {
			meta,
			rows,
			totals: {
				rowCount: rows.length,
				interactionCount: new Set(events.map(({ row }) => row.interactionId)).size,
				paused: 0,
				overdue: 0
			},
			charts: {
				funnel: null,
				movement: buildMovementChart(
					query.from,
					query.to,
					events.map(({ row, kind }) => ({ kind, at: row.movedAt })),
					migrated
				),
				breakdowns: breakdowns(events.map(({ row }) => row))
			}
		};
	}

	const raw = await readSnapshotRows(ctx, query);

	assertFits(raw.length);

	const stageCounts = new Map<string, number>();
	const closedCounts: Record<string, number> = { completed: 0, cancelled: 0 };
	let paused = 0;
	let overdue = 0;

	for (const row of raw) {
		if (row.entryId !== null && row.stageKey !== null) {
			const bucketId = `${row.processGroupId}:${row.stageKey}`;

			stageCounts.set(bucketId, (stageCounts.get(bucketId) ?? 0) + 1);
			index.label(row.processGroupId, row.stageKey, row.stageName);

			if (row.pauseReason !== null) {
				paused += 1;
			}

			if (isOverdue(row)) {
				overdue += 1;
			}
		} else {
			closedCounts[row.status] = (closedCounts[row.status] ?? 0) + 1;
		}
	}

	// Заготовка воронки — все стадии действующих редакций: ноль в стадии значит
	// «никого», а отсутствие строки читается как «такой стадии нет».
	const funnelBuckets = index.skeleton().map((stage) => ({
		key: stage.bucketId,
		label: stage.label.label,
		value: stageCounts.get(stage.bucketId) ?? 0,
		filter: { param: 'stage', value: stage.stageKey },
		order: stage.label.order,
		retired: false
	}));

	for (const [bucketId, value] of stageCounts) {
		if (funnelBuckets.some((bucket) => bucket.key === bucketId)) {
			continue;
		}

		const separator = bucketId.indexOf(':');
		const stageKey = bucketId.slice(separator + 1);
		const label = index.label(bucketId.slice(0, separator), stageKey, null);

		funnelBuckets.push({
			key: bucketId,
			label: label.label,
			value,
			filter: { param: 'stage', value: stageKey },
			order: label.order,
			retired: true
		});
	}

	funnelBuckets.sort((left, right) => left.order - right.order);

	const rows: ReportRow[] = raw.map((row) => ({
		interactionId: row.interactionId,
		stageEntryId: row.entryId,
		cells: columns.map((column) => snapshotCell(column, row, index, origin))
	}));

	return {
		meta,
		rows,
		totals: {
			rowCount: rows.length,
			interactionCount: new Set(raw.map((row) => row.interactionId)).size,
			paused,
			overdue
		},
		charts: {
			funnel: buildFunnel(
				funnelBuckets.map(({ key, label, value, filter, retired }) => ({
					key,
					label,
					value,
					filter,
					retired
				})),
				closedCounts
			),
			movement: null,
			breakdowns: breakdowns(raw)
		}
	};
}
