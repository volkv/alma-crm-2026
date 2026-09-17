/**
 * Серии диаграмм и разрезов.
 *
 * Сервер диаграмму не рисует: он отдаёт числа тем же набором строк, из которого
 * собрана таблица, а растр делает браузер. Поэтому и таблица, и диаграмма, и
 * файл считаются один раз и разойтись не могут — это и есть инвариант И5.
 */
import { moscowDay, moscowDayStart } from '$lib/contracts/calendar';
import {
	REPORT_CLOSED_BUCKET_LABELS,
	REPORT_CLOSED_BUCKETS,
	REPORT_EVENT_KIND_LABELS,
	REPORT_EVENT_KINDS,
	type ReportBreakdown,
	type ReportBucket,
	type ReportEventKind,
	type ReportFunnelChart,
	type ReportMovementChart
} from '$lib/contracts/reports';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Многозначный признак строки: идентификаторы для ссылки и названия для
 * подписи, в одном порядке.
 */
export type BreakdownValues = {
	ids: readonly string[];
	names: readonly string[];
};

/**
 * Разрез по признаку. Взаимодействие с двумя продуктами попадает в обе строки,
 * поэтому сумма по строкам законно больше числа строк отчёта — и разрез сам
 * сообщает, скольких записей это касается.
 */
export function buildBreakdown(
	key: ReportBreakdown['key'],
	label: string,
	param: string,
	rows: readonly BreakdownValues[]
): ReportBreakdown {
	const counts = new Map<string, { label: string; value: number }>();
	let doubleCounted = 0;

	for (const row of rows) {
		const seen = new Set<string>();

		row.ids.forEach((id, index) => {
			if (seen.has(id)) {
				return;
			}

			seen.add(id);

			const point = counts.get(id) ?? { label: row.names[index] ?? id, value: 0 };

			point.value += 1;
			counts.set(id, point);
		});

		if (seen.size > 1) {
			doubleCounted += 1;
		}
	}

	const points: ReportBucket[] = [...counts.entries()]
		.map(([id, point]) => ({
			key: id,
			label: point.label,
			value: point.value,
			filter: { param, value: id }
		}))
		.sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, 'ru'));

	return { key, label, points, doubleCounted };
}

/**
 * Воронка: распределение по стадиям на дату среза. Долю дошедших отчёт намеренно
 * не считает — при возвратах и пропусках «дошедших» не определено однозначно, а
 * красивое неверное число хуже отсутствующего.
 */
export function buildFunnel(
	stages: readonly ReportBucket[],
	closedCounts: Readonly<Record<string, number>>
): ReportFunnelChart {
	return {
		stages,
		closed: REPORT_CLOSED_BUCKETS.map((bucket) => ({
			key: bucket,
			label: REPORT_CLOSED_BUCKET_LABELS[bucket],
			value: closedCounts[bucket] ?? 0,
			filter: { param: 'state', value: bucket }
		})),
		note: 'Распределение на дату, не конверсия: «Завершено» и «Отменено» в воронку не входят и стоят отдельно.'
	};
}

function addDays(day: string, days: number): string {
	return moscowDay(new Date(moscowDayStart(day).getTime() + days * DAY_MS));
}

/**
 * Понедельник недели, в которую попадает день. День недели берётся у самой
 * календарной даты, а не у момента её начала: это свойство календаря, и часовой
 * пояс на него не влияет.
 */
function weekStart(day: string): string {
	const weekday = (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7;

	return addDays(day, -weekday);
}

function monthStart(day: string): string {
	return `${day.slice(0, 7)}-01`;
}

function addMonth(day: string): string {
	const year = Number(day.slice(0, 4));
	const month = Number(day.slice(5, 7));

	return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

/**
 * Шаг оси времени. Три месяца — граница, за которой недель становится больше
 * тринадцати и подписи перестают читаться; считается в днях, потому что «три
 * месяца» в календаре — это от 89 до 92 дней.
 */
const WEEK_STEP_MAX_DAYS = 92;

/**
 * Динамика переходов: столбцы с накоплением, серии — виды событий. Переносы при
 * изменении процесса в серии не входят и показываются отдельной отметкой: это
 * административный переезд, а не работа по процессу.
 */
export function buildMovementChart(
	from: string,
	to: string,
	events: readonly { kind: ReportEventKind; at: Date }[],
	migrated: number
): ReportMovementChart {
	const spanDays = Math.round(
		(moscowDayStart(to).getTime() - moscowDayStart(from).getTime()) / DAY_MS
	);
	const step: 'week' | 'month' = spanDays <= WEEK_STEP_MAX_DAYS ? 'week' : 'month';

	const buckets: { key: string; label: string; from: string; to: string }[] = [];
	let cursor = step === 'week' ? weekStart(from) : monthStart(from);

	while (cursor <= to) {
		const next = step === 'week' ? addDays(cursor, 7) : addMonth(cursor);

		buckets.push({
			key: cursor,
			label:
				step === 'week'
					? `${cursor.slice(8, 10)}.${cursor.slice(5, 7)}`
					: `${cursor.slice(5, 7)}.${cursor.slice(0, 4)}`,
			from: cursor,
			to: addDays(next, -1)
		});

		cursor = next;
	}

	const index = new Map(buckets.map((bucket, position) => [bucket.key, position]));
	const series = REPORT_EVENT_KINDS.map((kind) => ({
		key: kind,
		label: REPORT_EVENT_KIND_LABELS[kind],
		values: new Array<number>(buckets.length).fill(0)
	}));

	for (const event of events) {
		const day = moscowDay(event.at);
		const bucketKey = step === 'week' ? weekStart(day) : monthStart(day);
		const position = index.get(bucketKey);
		const row = series.find((item) => item.key === event.kind);

		// Событие вне построенных столбцов означало бы, что выборка и ось
		// времени разошлись: молча терять его нельзя, но и падать отчёту не с
		// чего — ось строится из того же периода, что и выборка.
		if (position !== undefined && row !== undefined) {
			row.values[position] += 1;
		}
	}

	return {
		step,
		buckets,
		series,
		migrated,
		note:
			step === 'week'
				? 'Недели по московскому календарю, с понедельника; интервалы полуоткрытые.'
				: 'Месяцы по московскому календарю; интервалы полуоткрытые.'
	};
}
