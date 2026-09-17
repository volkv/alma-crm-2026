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
import type { ReportQuery, ReportView } from '$lib/contracts/reports';
import type { ActorContext } from '../actor';
import { movementEventKind, readMovementRows } from './movement';
import { readSnapshotRows } from './snapshot';
import { createStageIndex, readActiveProcessGroups } from './stages';

const DAY_MS = 24 * 60 * 60 * 1000;

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
	const rowCount = view.rows.length;

	if (view.charts.funnel !== null) {
		const stages = sum(view.charts.funnel.stages.map((bucket) => bucket.value));
		const closed = sum(view.charts.funnel.closed.map((bucket) => bucket.value));

		if (stages + closed !== rowCount) {
			violations.push({
				invariant: 'И1',
				message: `по стадиям ${stages}, закрытых ${closed}, строк ${rowCount}`
			});
		}

		const unique = new Set(view.rows.map((row) => row.interactionId)).size;

		if (unique !== rowCount) {
			violations.push({
				invariant: 'И2',
				message: `строк ${rowCount}, различных взаимодействий ${unique}`
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
 * И5: число строк таблицы и число строк в каждом из файлов совпадают.
 * Проверяется на готовых файлах — считает их тот, кто их прочитал.
 */
export function checkExportInvariant(
	view: ReportView,
	rowsInFiles: Readonly<Record<string, number>>
): InvariantViolation[] {
	return Object.entries(rowsInFiles)
		.filter(([, count]) => count !== view.rows.length)
		.map(([format, count]) => ({
			invariant: 'И5',
			message: `в файле ${format} строк ${count}, в таблице ${view.rows.length}`
		}));
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
	const index = createStageIndex(await readActiveProcessGroups());
	const beforePeriod = moscowDay(new Date(moscowDayStart(query.from).getTime() - DAY_MS));

	const [startRows, endRows, events] = await Promise.all([
		readSnapshotRows(ctx, { ...query, mode: 'snapshot', to: beforePeriod }),
		readSnapshotRows(ctx, { ...query, mode: 'snapshot' }),
		readMovementRows(ctx, { ...query, mode: 'movement' })
	]);

	const start = new Map<string, number>();
	const end = new Map<string, number>();
	const entered = new Map<string, number>();
	const left = new Map<string, number>();
	const migratedIn = new Map<string, number>();
	const migratedOut = new Map<string, number>();
	const labels = new Map<string, string>();

	const stageBucket = (groupId: string, key: string, name: string | null): string => {
		const bucketId = `${groupId}:${key}`;

		if (!labels.has(bucketId)) {
			labels.set(bucketId, index.label(groupId, key, name).label);
		}

		return bucketId;
	};

	for (const [rows, counts] of [
		[startRows, start],
		[endRows, end]
	] as const) {
		for (const row of rows) {
			if (row.entryId !== null && row.stageKey !== null) {
				bump(counts, stageBucket(row.processGroupId, row.stageKey, row.stageName));
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
			bump(outOf, stageBucket(event.processGroupId, event.fromKey, event.fromName));
		}

		if (event.toKey !== null) {
			bump(into, stageBucket(event.processGroupId, event.toKey, event.toName));
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
