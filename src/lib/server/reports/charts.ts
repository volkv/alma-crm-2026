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
	type ReportFunnelWorkspace,
	type ReportMovementChart
} from '$lib/contracts/reports';
import type { ReportBreakdownCounts, StageCount } from './aggregate';
import type { StageIndex } from './stages';

/**
 * Разрезы выборки: ключ, подпись и параметр адреса, которым разрез сужает
 * отчёт. Каталог один на оба способа посчитать их числа — агрегатом в базе и
 * перебором строк в проверке инвариантов, — иначе подписи двух способов
 * разошлись бы, а сравнивать их пришлось бы по одной.
 */
export const BREAKDOWN_VIEWS = [
	{ key: 'organizations', label: 'По вузам и контрагентам', param: 'org' },
	{ key: 'directions', label: 'По направлениям', param: 'dir' },
	{ key: 'products', label: 'По продуктам', param: 'prod' },
	{ key: 'owners', label: 'По ответственным', param: 'owner' }
] as const satisfies readonly { key: ReportBreakdown['key']; label: string; param: string }[];

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

	return breakdownFromCounts(
		key,
		label,
		param,
		[...counts.entries()].map(([id, point]) => ({ id, label: point.label, value: point.value })),
		doubleCounted
	);
}

/**
 * Тот же разрез из чисел, посчитанных базой. Порядок строк задаётся здесь, а не
 * в запросе: «по убыванию, при равенстве — по алфавиту» для русских названий
 * считает сравнение строк приложения, и второе правило сортировки в SQL
 * разошлось бы с первым на первой же паре одинаковых чисел.
 */
export function breakdownFromCounts(
	key: ReportBreakdown['key'],
	label: string,
	param: string,
	points: readonly { id: string; label: string; value: number }[],
	doubleCounted: number
): ReportBreakdown {
	const buckets: ReportBucket[] = points
		.map((point) => ({
			key: point.id,
			label: point.label,
			value: point.value,
			filter: { param, value: point.id }
		}))
		.sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, 'ru'));

	return { key, label, points: buckets, doubleCounted };
}

/**
 * Воронка: распределение по стадиям на дату среза. Долю дошедших отчёт намеренно
 * не считает — при возвратах и пропусках «дошедших» не определено однозначно, а
 * красивое неверное число хуже отсутствующего.
 *
 * Пространства идут отдельными воронками: у B2B и B2C свои стадии, и полосы
 * двух процессов в одной картинке читаются как один путь, которым они не
 * являются. «Завершено» и «Отменено» общие — они не стадия ничьего процесса.
 */
export function buildFunnel(
	workspaces: readonly ReportFunnelWorkspace[],
	closedCounts: Readonly<Record<string, number>>
): ReportFunnelChart {
	return {
		workspaces,
		closed: REPORT_CLOSED_BUCKETS.map((bucket) => ({
			key: bucket,
			label: REPORT_CLOSED_BUCKET_LABELS[bucket],
			value: closedCounts[bucket] ?? 0,
			filter: { param: 'state', value: bucket }
		})),
		note: 'Распределение на дату, не конверсия: «Завершено» и «Отменено» в воронку не входят и стоят отдельно.'
	};
}

/** Четыре разреза из чисел, посчитанных базой. */
export function buildBreakdowns(counts: ReportBreakdownCounts): ReportBreakdown[] {
	return BREAKDOWN_VIEWS.map((view) =>
		breakdownFromCounts(
			view.key,
			view.label,
			view.param,
			counts[view.key].points,
			counts[view.key].doubleCounted
		)
	);
}

/** Полоса воронки вместе с местом в порядке процесса: порядок в выдачу не едет. */
type FunnelBucketDraft = ReportBucket & { order: number };

type FunnelWorkspaceDraft = {
	workspaceId: string;
	workspaceKey: string;
	workspaceName: string;
	buckets: FunnelBucketDraft[];
};

/**
 * Воронки из чисел, посчитанных базой, — по одной на пространство.
 *
 * Заготовка — все стадии действующих редакций: ноль в стадии значит «никого», а
 * отсутствие строки читается как «такой стадии нет». Стадия, которой в
 * действующем процессе уже нет, приписывается в конец своего пространства с
 * пометкой из снимка: перенести её строку в соседнюю стадию значило бы изменить
 * прошлое.
 *
 * Пространство попадает в выдачу, если в выборке есть хоть одна его строка:
 * вторая пустая воронка рядом с непустой — это не ответ, а шум. Когда на стадиях
 * нет никого вовсе, показываются все процессы: тогда нули и есть ответ.
 */
export function buildFunnelFromCounts(
	index: StageIndex,
	stages: readonly StageCount[],
	closedCounts: Readonly<Record<string, number>>
): ReportFunnelChart {
	const counted = new Map(stages.map((stage) => [stage.bucketId, stage]));
	const drafts = new Map<string, FunnelWorkspaceDraft>();
	const placed = new Set<string>();

	for (const workspace of index.skeleton()) {
		drafts.set(workspace.workspaceId, {
			workspaceId: workspace.workspaceId,
			workspaceKey: workspace.workspaceKey,
			workspaceName: workspace.workspaceName,
			buckets: workspace.stages.map((stage) => {
				placed.add(stage.bucketId);

				return {
					key: stage.bucketId,
					// Название без пространства: воронка уже подписана его именем.
					label: stage.label.name,
					value: counted.get(stage.bucketId)?.value ?? 0,
					filter: { param: 'stage', value: stage.stageKey },
					order: stage.label.order,
					retired: false
				};
			})
		});
	}

	for (const stage of stages) {
		if (placed.has(stage.bucketId)) {
			continue;
		}

		const separator = stage.bucketId.indexOf(':');
		const workspaceId = stage.bucketId.slice(0, separator);
		const stageKey = stage.bucketId.slice(separator + 1);
		const label = index.label(workspaceId, stageKey, stage.stageName);
		let draft = drafts.get(workspaceId);

		if (draft === undefined) {
			const workspace = index.workspace(workspaceId);

			draft = {
				workspaceId,
				workspaceKey: workspace?.key ?? workspaceId,
				workspaceName: workspace?.name ?? workspaceId,
				buckets: []
			};
			drafts.set(workspaceId, draft);
		}

		draft.buckets.push({
			key: stage.bucketId,
			label: label.name,
			value: stage.value,
			filter: { param: 'stage', value: stageKey },
			order: label.order,
			retired: true
		});
	}

	const drawn = [...drafts.values()].filter((draft) => draft.buckets.length > 0);
	const counting = drawn.filter((draft) => draft.buckets.some((bucket) => bucket.value > 0));

	return buildFunnel(
		(counting.length > 0 ? counting : drawn).map((draft) => ({
			workspaceId: draft.workspaceId,
			workspaceKey: draft.workspaceKey,
			workspaceName: draft.workspaceName,
			stages: [...draft.buckets]
				.sort((left, right) => left.order - right.order)
				.map(({ key, label, value, filter, retired }) => ({
					key,
					label,
					value,
					filter,
					retired
				}))
		})),
		closedCounts
	);
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
	events: readonly { kind: ReportEventKind; day: string; count: number }[],
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
		const bucketKey = step === 'week' ? weekStart(event.day) : monthStart(event.day);
		const position = index.get(bucketKey);
		const row = series.find((item) => item.key === event.kind);

		// Событие вне построенных столбцов означало бы, что выборка и ось
		// времени разошлись: молча терять его нельзя, но и падать отчёту не с
		// чего — ось строится из того же периода, что и выборка.
		if (position !== undefined && row !== undefined) {
			row.values[position] += event.count;
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
