/**
 * Итоги, воронка, динамика и разрезы — агрегирующими запросами по той же
 * выборке, что и таблица.
 *
 * Почему не по строкам. Экрану нужна одна страница из пятидесяти строк, а
 * числа над таблицей и под ней описывают всю выборку. Считать их перебором
 * массива значит вычитать из базы все три тысячи строк вместе с их признаками —
 * и платить за это секундой на каждой смене фильтра. Поэтому числа считает
 * база: `count` по тем же условиям `where`, что у таблицы.
 *
 * Условия пишутся один раз (`snapshotSelection`, `movementSelection`) и
 * подставляются сюда целиком: второй список условий — это второе определение
 * выборки, и разойдётся оно молча. Что агрегаты считают то же, что подсчёт по
 * полному набору строк, проверяет отдельный тест (`reports/aggregates.test.ts`)
 * через эталонный пересчёт `recountFromRows` (`reports/invariants.ts`).
 *
 * Выборка приходит сюда одним выражением и упоминается в запросе многократно,
 * поэтому PostgreSQL материализует её один раз: цена — один проход, а не восемь.
 */
import { MOSCOW_OFFSET_MS } from '$lib/contracts/calendar';
import type { StageOutcome } from '$lib/contracts/interactions';
import type { ReportBreakdown, ReportQuery, ReportTotals } from '$lib/contracts/reports';
import { sql, type SQL } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { migrationEvent, movementSelection } from './movement';
import { snapshotSelection } from './snapshot';

/** Строка агрегата: одна форма на все разделы, чтобы обойтись одним запросом. */
type AggregateRow = {
	facet: string;
	id: string | null;
	label: string | null;
	value: number;
	isStart: boolean | null;
	outcome: StageOutcome | null;
	hasNext: boolean | null;
};

/** Столбцы события: заполнены только у строк динамики переходов. */
const NO_EVENT = sql`null::boolean as "isStart", null::text as "outcome", null::boolean as "hasNext"`;

/** Разрез по признаку в том виде, в каком его посчитала база. */
export type BreakdownCounts = {
	points: { id: string; label: string; value: number }[];
	/** Строк выборки, у которых значений признака больше одного. */
	doubleCounted: number;
};

export type ReportBreakdownCounts = Record<ReportBreakdown['key'], BreakdownCounts>;

/** Стадия среза: пара «пространство + ключ» и число строк на ней. */
export type StageCount = { bucketId: string; stageName: string | null; value: number };

export type SnapshotAggregates = {
	totals: ReportTotals;
	stages: StageCount[];
	/** Закрытые за период: `completed` и `cancelled` по состоянию записи. */
	closed: Record<string, number>;
	breakdowns: ReportBreakdownCounts;
};

/** Группа событий движения: входы разбора вида плюс московский день. */
export type MovementEventCount = {
	isStart: boolean;
	outcome: StageOutcome | null;
	hasNext: boolean;
	day: string;
	count: number;
};

export type MovementAggregates = {
	totals: ReportTotals;
	events: MovementEventCount[];
	/** Переносы при изменении процесса: в строки не входят, но и не прячутся. */
	migrated: number;
	breakdowns: ReportBreakdownCounts;
};

/**
 * Направления взаимодействия: объединение направлений его продуктов и его
 * программ. То же правило, что у фильтра и у колонки, — у продуктонезависимой
 * программы направление своё. `union` сам убирает повтор, поэтому строка с
 * одним направлением от продукта и от программы считается один раз.
 */
const DIRECTION_LINKS = sql`
	interaction_direction as (
		select chosen.interaction_id as interaction_id, product_direction.direction_id as direction_id
		from interaction_products chosen
		join product_directions product_direction on product_direction.product_id = chosen.product_id
		where exists (select 1 from selection where selection."interactionId" = chosen.interaction_id)
		union
		select chosen.interaction_id, program.direction_id
		from interaction_programs chosen
		join programs program on program.id = chosen.program_id
		where program.direction_id is not null
			and exists (select 1 from selection where selection."interactionId" = chosen.interaction_id)
	)
`;

/**
 * Разрезы выборки: по вузам, ответственным, продуктам и направлениям.
 *
 * `rowId` — то, чем строки выборки различаются между собой: в срезе это
 * взаимодействие, в движении — запись о стадии вместе с видом события (одна
 * запись даёт и начало работы, и уход с него). Он нужен только для счётчика
 * двойного счёта: «сколько строк попало в две и более строки разреза».
 *
 * Многозначный признак считает строку в каждом своём значении, поэтому сумма по
 * строкам разреза законно больше числа строк отчёта — и разрез сам сообщает,
 * скольких записей это касается. Повторов у пары «взаимодействие + значение»
 * нет: у связей многие ко многим составной первичный ключ, а направления
 * склеены через `union`.
 */
function breakdownFacets(rowId: SQL, keep: SQL): SQL {
	return sql`
		select
			'organizations' as facet,
			selection."organizationId"::text as id,
			min(selection."organizationName") as label,
			count(*)::integer as value,
			${NO_EVENT}
		from selection
		where selection."organizationId" is not null and ${keep}
		group by selection."organizationId"
		union all
		select
			'owners',
			selection."ownerUserId"::text,
			min(coalesce(owner_user.full_name, selection."ownerUserId"::text)),
			count(*)::integer,
			${NO_EVENT}
		from selection
		left join users owner_user on owner_user.id = selection."ownerUserId"
		where ${keep}
		group by selection."ownerUserId"
		union all
		select 'products', product.id::text, min(product.name), count(*)::integer, ${NO_EVENT}
		from selection
		join interaction_products chosen on chosen.interaction_id = selection."interactionId"
		join products product on product.id = chosen.product_id
		where ${keep}
		group by product.id
		union all
		select 'directions', direction.id::text, min(direction.name), count(*)::integer, ${NO_EVENT}
		from selection
		join interaction_direction on interaction_direction.interaction_id = selection."interactionId"
		join directions direction on direction.id = interaction_direction.direction_id
		where ${keep}
		group by direction.id
		union all
		select 'multi', 'products', null, count(*)::integer, ${NO_EVENT}
		from (
			select ${rowId} as row_id
			from selection
			join interaction_products chosen on chosen.interaction_id = selection."interactionId"
			where ${keep}
			group by ${rowId}
			having count(*) > 1
		) many
		union all
		select 'multi', 'directions', null, count(*)::integer, ${NO_EVENT}
		from (
			select ${rowId} as row_id
			from selection
			join interaction_direction on interaction_direction.interaction_id = selection."interactionId"
			where ${keep}
			group by ${rowId}
			having count(*) > 1
		) many
	`;
}

const EMPTY_BREAKDOWN: BreakdownCounts = { points: [], doubleCounted: 0 };

const BREAKDOWN_KEYS = ['organizations', 'directions', 'products', 'owners'] as const;

function collectBreakdowns(rows: readonly AggregateRow[]): ReportBreakdownCounts {
	const counts: ReportBreakdownCounts = {
		organizations: { ...EMPTY_BREAKDOWN, points: [] },
		directions: { ...EMPTY_BREAKDOWN, points: [] },
		products: { ...EMPTY_BREAKDOWN, points: [] },
		owners: { ...EMPTY_BREAKDOWN, points: [] }
	};

	for (const row of rows) {
		if (row.facet === 'multi') {
			const key = BREAKDOWN_KEYS.find((candidate) => candidate === row.id);

			if (key !== undefined) {
				counts[key].doubleCounted = row.value;
			}

			continue;
		}

		const key = BREAKDOWN_KEYS.find((candidate) => candidate === row.facet);

		if (key !== undefined && row.id !== null) {
			counts[key].points.push({ id: row.id, label: row.label ?? row.id, value: row.value });
		}
	}

	return counts;
}

/** Число из строки итогов. Нет строки — нет и записей: ноль, а не пропуск. */
function total(rows: readonly AggregateRow[], id: string): number {
	return rows.find((row) => row.facet === 'totals' && row.id === id)?.value ?? 0;
}

/**
 * Итоги среза: сколько строк, сколько из них на паузе и сколько просрочено на
 * момент `T`. Просрочка сравнивается с нормативом из снимка записи — тем же
 * выражением, что и колонка просрочки, и фильтр «только просроченные».
 */
const SNAPSHOT_TOTALS = sql`
	select 'totals' as facet, counted.id as id, null::text as label, counted.value::integer as value, ${NO_EVENT}
	from (
		select
			count(*) as rows,
			count(distinct selection."interactionId") as interactions,
			count(*) filter (where selection."pauseReason" is not null) as paused,
			count(*) filter (where selection."activeSeconds" > selection."slaDays" * 86400) as overdue
		from selection
	) agg
	cross join lateral (values
		('rows', agg.rows),
		('interactions', agg.interactions),
		('paused', agg.paused),
		('overdue', agg.overdue)
	) as counted(id, value)
`;

/**
 * Воронка: число взаимодействий на каждой паре «пространство + ключ стадии».
 * Группировка идёт по ключу из снимка, а не по стадии действующей редакции:
 * ключ записан в момент входа и не переписывается.
 *
 * Строка без записи о стадии — закрытое взаимодействие: оно не стоит нигде и
 * уходит в отдельную корзину по своему состоянию.
 */
const SNAPSHOT_BUCKETS = sql`
	select
		'stage' as facet,
		selection."workspaceId"::text || ':' || selection."stageKey" as id,
		min(selection."stageName") as label,
		count(*)::integer as value,
		${NO_EVENT}
	from selection
	where selection."entryId" is not null and selection."stageKey" is not null
	group by selection."workspaceId", selection."stageKey"
	union all
	select 'closed', selection.status::text, null, count(*)::integer, ${NO_EVENT}
	from selection
	where selection."entryId" is null or selection."stageKey" is null
	group by selection.status
`;

export async function readSnapshotAggregates(
	ctx: ActorContext,
	query: ReportQuery
): Promise<SnapshotAggregates> {
	const result = await getDb().execute<AggregateRow>(sql`
		with selection as (${snapshotSelection(ctx, query)}),
		${DIRECTION_LINKS}
		${SNAPSHOT_TOTALS}
		union all
		${SNAPSHOT_BUCKETS}
		union all
		${breakdownFacets(sql`selection."interactionId"`, sql`true`)}
	`);

	const rows = [...result];
	const closed: Record<string, number> = {};

	for (const row of rows) {
		if (row.facet === 'closed' && row.id !== null) {
			closed[row.id] = row.value;
		}
	}

	return {
		totals: {
			rowCount: total(rows, 'rows'),
			interactionCount: total(rows, 'interactions'),
			paused: total(rows, 'paused'),
			overdue: total(rows, 'overdue')
		},
		// Порядок стадий в воронке задаёт действующий процесс, а стадии, которых в
		// нём уже нет, приписываются в конец по мере встречи. Поэтому группы
		// агрегата упорядочены по корзине: у `group by` своего порядка нет, и без
		// этой строки удалённые стадии вставали бы в конец воронки как придётся.
		stages: rows
			.filter((row) => row.facet === 'stage' && row.id !== null)
			.map((row) => ({ bucketId: row.id as string, stageName: row.label, value: row.value }))
			.sort((left, right) => left.bucketId.localeCompare(right.bucketId)),
		closed,
		breakdowns: collectBreakdowns(rows)
	};
}

/**
 * Итоги и динамика движения.
 *
 * События группируются по входам разбора вида (`movementEventKind`) и по
 * московскому дню: вид события называет разбор в приложении, чтобы правило
 * оставалось в одном месте, а база отдаёт ровно то, из чего он считается.
 * Смещение московских суток берётся из календаря продукта: вторая константа
 * разошлась бы с первой молча.
 */
function movementFacets(keep: SQL): SQL {
	return sql`
		select 'totals' as facet, counted.id as id, null::text as label, counted.value::integer as value, ${NO_EVENT}
		from (
			select
				count(*) filter (where ${keep}) as rows,
				count(distinct selection."interactionId") filter (where ${keep}) as interactions,
				count(*) filter (where not (${keep})) as migrated
			from selection
		) agg
		cross join lateral (values
			('rows', agg.rows),
			('interactions', agg.interactions),
			('migrated', agg.migrated)
		) as counted(id, value)
		union all
		select 'timeline', event.day, null, count(*)::integer, event."isStart", event.outcome, event."hasNext"
		from (
			select
				to_char(
					selection."movedAt" at time zone 'UTC'
						+ ${MOSCOW_OFFSET_MS}::double precision * interval '1 millisecond',
					'YYYY-MM-DD'
				) as day,
				selection."isStart" as "isStart",
				selection."outcome"::text as outcome,
				selection."hasNext" as "hasNext"
			from selection
			where ${keep}
		) event
		group by event.day, event."isStart", event.outcome, event."hasNext"
	`;
}

export async function readMovementAggregates(
	ctx: ActorContext,
	query: ReportQuery
): Promise<MovementAggregates> {
	// Выборка берётся вместе с переносами: их надо посчитать отдельной строкой
	// сводки, а не потерять. Всё остальное считается по событиям без них.
	const keep = sql`not (${migrationEvent(sql`selection`)})`;

	const result = await getDb().execute<AggregateRow>(sql`
		with selection as (${movementSelection(ctx, query, 'include')}),
		${DIRECTION_LINKS}
		${movementFacets(keep)}
		union all
		${breakdownFacets(sql`selection."entryId"::text || ':' || selection."isStart"::text`, sql`${keep}`)}
	`);

	const rows = [...result];

	return {
		totals: {
			rowCount: total(rows, 'rows'),
			interactionCount: total(rows, 'interactions'),
			// Пауза и просрочка — вопросы среза: у события их нет.
			paused: 0,
			overdue: 0
		},
		events: rows
			.filter((row) => row.facet === 'timeline' && row.id !== null)
			.map((row) => ({
				isStart: row.isStart === true,
				outcome: row.outcome,
				hasNext: row.hasNext === true,
				day: row.id as string,
				count: row.value
			})),
		migrated: total(rows, 'migrated'),
		breakdowns: collectBreakdowns(rows)
	};
}
