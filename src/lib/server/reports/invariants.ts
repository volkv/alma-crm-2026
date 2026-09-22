/**
 * Инварианты отчёта — утверждения, которые проверяются, а не подразумеваются.
 *
 * Формулировка у каждого одна на любую выборку и лежит здесь, а не в тесте:
 * второе описание того же утверждения разошлось бы с первым на первой же
 * правке. Зовут эти функции **только тесты** (`tests/integration/reports/`), и
 * ни один экран продукта на них не опирается: сверка режимов (И4) отвечает на
 * вопрос «почему на начало квартала было шесть, а на конец семь» числами, но
 * места, где этот вопрос задаёт человек, в продукте пока нет — появится оно,
 * и звать будут отсюда же.
 */
import { moscowDay, moscowDayStart } from '$lib/contracts/calendar';
import {
	REPORT_PDF_ROWS,
	type ReportCharts,
	type ReportEventKind,
	type ReportFormat,
	type ReportQuery,
	type ReportTotals,
	type ReportView
} from '$lib/contracts/reports';
import type { ActorContext } from '../actor';
import {
	BREAKDOWN_VIEWS,
	buildBreakdown,
	buildFunnelFromCounts,
	buildMovementChart
} from './charts';
import type { ReportAttributes, ReportSelection } from './conditions';
import { movementEventKind, readMovementRows, type MovementRow } from './movement';
import { readSnapshotRows } from './snapshot';
import { createStageIndex, readActiveWorkspaces, type StageIndex } from './stages';

const DAY_MS = 24 * 60 * 60 * 1000;
const SECONDS_IN_DAY = 86_400;

export type InvariantViolation = { invariant: string; message: string };

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

/**
 * И1–И3: зерно строки сходится с итогами.
 *
 * И1 — в срезе сумма по всем стадиям плюс «Завершено» плюс «Отменено» равна
 * числу строк. И2 — каждое взаимодействие встречается в срезе ровно один раз.
 * И3 — в движении сумма по видам событий равна числу строк.
 */
export function checkReportInvariants(view: ReportView): InvariantViolation[] {
	const violations: InvariantViolation[] = [];
	// Числа сверяются с итогами, а не с длиной массива строк: на экране строк
	// пятьдесят, а воронка описывает всю выборку.
	const rowCount = view.totals.rowCount;

	if (view.charts.funnel !== null) {
		// Воронок столько, сколько пространств в выборке, и сходится с числом
		// строк их общая сумма: разделение по процессам — это способ показать, а
		// не два разных отчёта.
		const stages = sum(
			view.charts.funnel.workspaces.flatMap((workspace) =>
				workspace.stages.map((bucket) => bucket.value)
			)
		);
		const closed = sum(view.charts.funnel.closed.map((bucket) => bucket.value));

		if (stages + closed !== rowCount) {
			violations.push({
				invariant: 'И1',
				message: `по стадиям ${stages}, закрытых ${closed}, строк ${rowCount}`
			});
		}

		// И2 проверяется по показанным строкам: взаимодействие встречается в
		// срезе один раз, значит, и внутри любой страницы тоже.
		const unique = new Set(view.rows.map((row) => row.interactionId)).size;

		if (unique !== view.rows.length) {
			violations.push({
				invariant: 'И2',
				message: `строк ${view.rows.length}, различных взаимодействий ${unique}`
			});
		}
	}

	if (view.charts.movement !== null) {
		const events = sum(view.charts.movement.series.map((series) => sum(series.values)));

		if (events !== rowCount) {
			violations.push({
				invariant: 'И3',
				message: `по видам событий ${events}, строк ${rowCount}`
			});
		}
	}

	return violations;
}

/**
 * Сколько строк обязано быть в файле этого формата.
 *
 * У книг и JSON — вся выборка. PDF — сводка: в нём первые `REPORT_PDF_ROWS`
 * строк и напечатано, сколько их всего, потому что полсотни страниц таблицы
 * никто не читает, а Chromium собирает их минутами.
 */
export function expectedFileRows(view: ReportView, format: ReportFormat): number {
	return format === 'pdf' ? Math.min(view.rows.length, REPORT_PDF_ROWS) : view.rows.length;
}

/**
 * И5: число строк таблицы и число строк в каждом из файлов совпадают, а у
 * сводки PDF — столько, сколько она обещает показать.
 * Проверяется на готовых файлах — считает их тот, кто их прочитал.
 */
export function checkExportInvariant(
	view: ReportView,
	rowsInFiles: Readonly<Partial<Record<ReportFormat, number>>>
): InvariantViolation[] {
	return Object.entries(rowsInFiles)
		.filter(([format, count]) => count !== expectedFileRows(view, format as ReportFormat))
		.map(([format, count]) => ({
			invariant: 'И5',
			message: `в файле ${format} строк ${count}, ожидалось ${expectedFileRows(view, format as ReportFormat)}`
		}));
}

/**
 * Эталонный пересчёт: те же итоги, воронка, динамика и разрезы, посчитанные
 * перебором **полного** набора строк выгрузки.
 *
 * Это второе определение тех же чисел, и держат его здесь намеренно: продукт
 * считает их агрегатами в базе (`reports/aggregate.ts`), а тест сверяет два
 * ответа на эталонном наборе. Разойтись они могут только ошибкой, и поймать её
 * больше нечем: агрегат, сверенный сам с собой, доказывает лишь то, что он
 * повторяем.
 */
export async function recountFromRows(
	ctx: ActorContext,
	query: ReportQuery
): Promise<{ totals: ReportTotals; charts: ReportCharts }> {
	const index = createStageIndex(await readActiveWorkspaces());

	return query.mode === 'movement'
		? recountMovement(ctx, query)
		: recountSnapshot(ctx, query, index);
}

/** Разрезы по полному набору строк: те же подписи, что у агрегата. */
function breakdownsFromRows(rows: readonly (ReportSelection & ReportAttributes)[]) {
	const values = {
		organizations: rows.map((row) => ({
			ids: row.organizationId === null ? [] : [row.organizationId],
			names: row.organizationName === null ? [] : [row.organizationName]
		})),
		directions: rows.map((row) => ({ ids: row.directionIds, names: row.directions })),
		products: rows.map((row) => ({ ids: row.productIds, names: row.products })),
		owners: rows.map((row) => ({
			ids: [row.ownerUserId],
			names: [row.ownerName ?? row.ownerUserId]
		}))
	};

	return BREAKDOWN_VIEWS.map((view) =>
		buildBreakdown(view.key, view.label, view.param, values[view.key])
	);
}

async function recountSnapshot(
	ctx: ActorContext,
	query: ReportQuery,
	index: StageIndex
): Promise<{ totals: ReportTotals; charts: ReportCharts }> {
	const rows = await readSnapshotRows(ctx, query);
	const stageCounts = new Map<string, number>();
	const closed: Record<string, number> = {};
	const stageNames = new Map<string, string | null>();
	let paused = 0;
	let overdue = 0;

	for (const row of rows) {
		if (row.entryId !== null && row.stageKey !== null) {
			const bucketId = `${row.workspaceId}:${row.stageKey}`;

			stageCounts.set(bucketId, (stageCounts.get(bucketId) ?? 0) + 1);

			if (!stageNames.has(bucketId)) {
				stageNames.set(bucketId, row.stageName);
			}

			if (row.pauseReason !== null) {
				paused += 1;
			}

			if (
				row.activeSeconds !== null &&
				row.slaDays !== null &&
				row.activeSeconds > row.slaDays * SECONDS_IN_DAY
			) {
				overdue += 1;
			}
		} else {
			closed[row.status] = (closed[row.status] ?? 0) + 1;
		}
	}

	return {
		totals: {
			rowCount: rows.length,
			interactionCount: new Set(rows.map((row) => row.interactionId)).size,
			paused,
			overdue
		},
		charts: {
			funnel: buildFunnelFromCounts(
				index,
				// Тот же порядок корзин, что у агрегата: стадии, которых нет в
				// действующем процессе, приписываются в конец по мере встречи, и
				// сравнивать два ответа можно только при одинаковом порядке.
				[...stageCounts]
					.map(([bucketId, value]) => ({
						bucketId,
						stageName: stageNames.get(bucketId) ?? null,
						value
					}))
					.sort((left, right) => left.bucketId.localeCompare(right.bucketId)),
				closed
			),
			movement: null,
			breakdowns: breakdownsFromRows(rows)
		}
	};
}

async function recountMovement(
	ctx: ActorContext,
	query: ReportQuery
): Promise<{ totals: ReportTotals; charts: ReportCharts }> {
	// Переносы читаются вместе со всеми: их надо отделить тем же разбором, что
	// и в продукте, а не условием выборки.
	const raw = await readMovementRows(ctx, query, { migrations: 'include' });
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

	return {
		totals: {
			rowCount: events.length,
			interactionCount: new Set(events.map(({ row }) => row.interactionId)).size,
			paused: 0,
			overdue: 0
		},
		charts: {
			funnel: null,
			movement: buildMovementChart(
				query.from,
				query.to,
				events.map(({ row, kind }) => ({ kind, day: moscowDay(row.movedAt), count: 1 })),
				migrated
			),
			breakdowns: breakdownsFromRows(events.map(({ row }) => row))
		}
	};
}

/** Строка сверки режимов по одной стадии или корзине закрытых. */
export type ModeReconciliationRow = {
	bucketId: string;
	label: string;
	start: number;
	end: number;
	entered: number;
	left: number;
	migratedIn: number;
	migratedOut: number;
	/** `end − start` и `вошло − вышло + перенесено_в − перенесено_из` совпали. */
	balanced: boolean;
};

const CLOSED_LABELS: Record<string, string> = {
	completed: 'Завершено',
	cancelled: 'Отменено'
};

function bump(counts: Map<string, number>, key: string): void {
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * И4, сверка режимов: для любой стадии `X`
 * `срез(конец)[X] − срез(начало)[X] = вошло(X) − вышло(X) + перенесено_в(X) − перенесено_из(X)`.
 *
 * Оба среза считаются с одним и тем же правилом исключения — закрытые до начала
 * периода не входят ни в тот, ни в другой, — иначе разность двух срезов
 * означала бы не движение, а смену правила. Срез начала периода — это состояние
 * в момент `T` начала: тот же момент, до которого досчитан предыдущий период.
 *
 * Это главный тест раздела: он связывает режимы и ловит любую ошибку в
 * определении границ.
 */
export async function reconcileModes(
	ctx: ActorContext,
	query: ReportQuery
): Promise<ModeReconciliationRow[]> {
	const index = createStageIndex(await readActiveWorkspaces());
	const beforePeriod = moscowDay(new Date(moscowDayStart(query.from).getTime() - DAY_MS));

	const [startRows, endRows, events] = await Promise.all([
		readSnapshotRows(ctx, { ...query, mode: 'snapshot', to: beforePeriod }),
		readSnapshotRows(ctx, { ...query, mode: 'snapshot' }),
		readMovementRows(ctx, { ...query, mode: 'movement' }, { migrations: 'include' })
	]);

	const start = new Map<string, number>();
	const end = new Map<string, number>();
	const entered = new Map<string, number>();
	const left = new Map<string, number>();
	const migratedIn = new Map<string, number>();
	const migratedOut = new Map<string, number>();
	const labels = new Map<string, string>();

	const stageBucket = (workspaceId: string, key: string, name: string | null): string => {
		const bucketId = `${workspaceId}:${key}`;

		if (!labels.has(bucketId)) {
			labels.set(bucketId, index.label(workspaceId, key, name).label);
		}

		return bucketId;
	};

	for (const [rows, counts] of [
		[startRows, start],
		[endRows, end]
	] as const) {
		for (const row of rows) {
			if (row.entryId !== null && row.stageKey !== null) {
				bump(counts, stageBucket(row.workspaceId, row.stageKey, row.stageName));
			} else {
				labels.set(row.status, CLOSED_LABELS[row.status] ?? row.status);
				bump(counts, row.status);
			}
		}
	}

	for (const event of events) {
		const kind = movementEventKind(event);
		const migration = kind === 'migrated';
		const outOf = migration ? migratedOut : left;
		const into = migration ? migratedIn : entered;

		if (event.fromKey !== null && !event.isStart) {
			bump(outOf, stageBucket(event.workspaceId, event.fromKey, event.fromName));
		}

		if (event.toKey !== null) {
			bump(into, stageBucket(event.workspaceId, event.toKey, event.toName));
		} else if (kind === 'completed' || kind === 'cancelled') {
			// Закрытие — это вход в свою корзину: иначе выборка среза выросла бы
			// на строку, которой в движении не соответствует ни одно событие.
			labels.set(kind, CLOSED_LABELS[kind]);
			bump(into, kind);
		}
	}

	const buckets = new Set([
		...start.keys(),
		...end.keys(),
		...entered.keys(),
		...left.keys(),
		...migratedIn.keys(),
		...migratedOut.keys()
	]);

	return [...buckets].map((bucketId) => {
		const row = {
			bucketId,
			label: labels.get(bucketId) ?? bucketId,
			start: start.get(bucketId) ?? 0,
			end: end.get(bucketId) ?? 0,
			entered: entered.get(bucketId) ?? 0,
			left: left.get(bucketId) ?? 0,
			migratedIn: migratedIn.get(bucketId) ?? 0,
			migratedOut: migratedOut.get(bucketId) ?? 0
		};

		return {
			...row,
			balanced: row.end - row.start === row.entered - row.left + row.migratedIn - row.migratedOut
		};
	});
}
