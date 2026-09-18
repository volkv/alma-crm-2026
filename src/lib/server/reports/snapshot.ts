/**
 * Срез на конец периода: где всё стояло в последний момент дня «по».
 *
 * Запись о стадии выбирается по правилу `entered_at < T <= left_at`, где `T` —
 * начало следующих суток. Строгая граница слева и нестрогая справа намеренны:
 * переход ровно в `T` относится уже к следующим суткам, поэтому ни одно событие
 * не попадает в два периода и ни одно не теряется между ними. Интервалы записей
 * замощают жизнь взаимодействия без разрывов и без наложений, поэтому такая
 * запись ровно одна — или её нет вовсе, если взаимодействие уже закрыто.
 *
 * Срок, паузы и просрочка считаются здесь же, выражением с параметром `T`, а не
 * представлением `stage_entry_status`: оно считает окно открытой записи до
 * `now()` и параметра не принимает, поэтому срез на сентябрь, построенный в
 * декабре, дал бы декабрьские числа.
 *
 * Выборка отделена от строк: `snapshotSelection` отдаёт условия и колонки, по
 * которым считаются итоги и воронка, а `readSnapshotRows` добавляет к ним
 * признаки — и только для тех строк, которые уйдут в ответ.
 */
import type { PauseReason } from '$lib/contracts/interactions';
import type { ReportQuery } from '$lib/contracts/reports';
import { moscowDayStart, snapshotMoment } from '$lib/contracts/calendar';
import { sql, type SQL } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import {
	ATTRIBUTE_COLUMNS,
	attributeJoins,
	inList,
	interactionConditions,
	PRIMARY_PARTY_JOIN,
	SELECTION_COLUMNS,
	windowClause,
	type ReportAttributes,
	type ReportSelection,
	type RowWindow
} from './conditions';

/** Колонки среза сверх общих: где строка стоит на `T` и сколько уже стоит. */
export type SnapshotSelectionRow = ReportSelection & {
	/** Запись о стадии, накрывающая `T`; у закрытого взаимодействия её нет. */
	entryId: string | null;
	enteredAt: Date | null;
	stageKey: string | null;
	stageName: string | null;
	slaDays: number | null;
	/** Окно записи до `T` минус пересечение с паузами, в секундах. */
	activeSeconds: number | null;
	/** Причина паузы, открытой на момент `T`. */
	pauseReason: PauseReason | null;
	/** Момент закрытия взаимодействия: по нему оно попадает в свою колонку. */
	closedAt: Date | null;
};

/** Строка среза в том виде, в каком её показывают: выборка плюс признаки. */
export type SnapshotRow = SnapshotSelectionRow & ReportAttributes;

/**
 * Момент из выдачи. Готовый SQL идёт мимо описания схемы, поэтому драйвер
 * отдаёт `timestamptz` строкой: разбирать её обязан тот, кто знает, что это
 * момент, — иначе `Date` появился бы только у половины полей.
 */
function toDate(value: Date | string | null): Date | null {
	return value === null || value instanceof Date ? value : new Date(value);
}

/** Строка в том виде, в каком её отдаёт драйвер. */
type SnapshotRowRaw = Omit<SnapshotRow, 'enteredAt' | 'closedAt'> & {
	enteredAt: Date | string | null;
	closedAt: Date | string | null;
};

/**
 * Порядок строк среза. Один на страницу и на выгрузку: страница — это окно
 * того же порядка, и вторая сортировка означала бы, что вторая страница
 * начинается не там, где кончилась первая. Поэтому он и написан один раз, а
 * псевдоним строк передаётся параметром.
 */
function snapshotOrder(source: SQL): SQL {
	return sql`${source}."organizationName" nulls last, ${source}."title", ${source}."interactionId"`;
}

/**
 * Выборка среза без признаков строки: условия, стадия на `T`, срок и пауза.
 *
 * Отсюда считаются и итоги, и воронка, и разрезы — по тем же условиям `where`,
 * что у таблицы. Статус `status` и признак «стоит на стадии» едут колонками:
 * агрегат раскладывает по ним строки, не заглядывая в сами записи.
 */
export function snapshotSelection(ctx: ActorContext, query: ReportQuery): SQL {
	// Моменты уходят в запрос строками ISO: у параметра в готовом SQL нет
	// выведенного типа, и драйвер не берётся кодировать объект даты вслепую.
	const asOf = snapshotMoment(query.to).toISOString();
	const periodStart = moscowDayStart(query.from).toISOString();
	const conditions = interactionConditions(ctx, query);

	const extra = [];

	if (query.stage.length > 0) {
		extra.push(sql`covering."stageKey" in ${inList(query.stage)}`);
	}

	if (query.overdue) {
		extra.push(sql`covering."activeSeconds" > covering."slaDays" * 86400`);
	}

	if (query.paused) {
		extra.push(sql`covering."pauseReason" is not null`);
	}

	return sql`
		select
			${SELECTION_COLUMNS},
			covering."entryId" as "entryId",
			covering."enteredAt" as "enteredAt",
			covering."stageKey" as "stageKey",
			covering."stageName" as "stageName",
			covering."slaDays" as "slaDays",
			covering."activeSeconds" as "activeSeconds",
			covering."pauseReason" as "pauseReason",
			closing."closedAt" as "closedAt"
		from interactions
		left join process_groups process_group on process_group.id = interactions.process_group_id
		${PRIMARY_PARTY_JOIN}
		left join lateral (
			select
				entry.id as "entryId",
				entry.entered_at as "enteredAt",
				entry.stage_snapshot ->> 'key' as "stageKey",
				entry.stage_snapshot ->> 'name' as "stageName",
				(entry.stage_snapshot ->> 'slaDays')::integer as "slaDays",
				(
					extract(epoch from (${asOf}::timestamptz - entry.entered_at))
					- coalesce((
						select sum(greatest(0, extract(epoch from (
							least(coalesce(pause.ended_at, ${asOf}::timestamptz), ${asOf}::timestamptz)
							- greatest(pause.started_at, entry.entered_at)
						))))
						from stage_pauses pause
						where pause.stage_entry_id = entry.id and pause.started_at < ${asOf}::timestamptz
					), 0)
				)::double precision as "activeSeconds",
				(
					select pause.reason from stage_pauses pause
					where pause.stage_entry_id = entry.id
						and pause.started_at < ${asOf}::timestamptz
						and (pause.ended_at is null or pause.ended_at > ${asOf}::timestamptz)
					limit 1
				) as "pauseReason"
			from stage_entries entry
			where entry.interaction_id = interactions.id
				and entry.entered_at < ${asOf}::timestamptz
				and (entry.left_at is null or entry.left_at >= ${asOf}::timestamptz)
			limit 1
		) covering on true
		left join lateral (
			select max(entry.left_at) as "closedAt"
			from stage_entries entry
			where entry.interaction_id = interactions.id
		) closing on true
		where ${conditions}
			-- Созданные после даты среза не входят: на неё их не существовало.
			and exists (
				select 1 from stage_entries entry
				where entry.interaction_id = interactions.id
					and entry.entered_at < ${asOf}::timestamptz
			)
			-- Либо стоит на стадии, либо закрыто внутри периода. Закрытые до его
			-- начала не входят: их ответ на вопрос «где стоит» — «нигде», и за
			-- годы таких накопится больше, чем живых.
			and (
				covering."entryId" is not null
				or (
					interactions.status <> 'active'
					and closing."closedAt" >= ${periodStart}::timestamptz
					and closing."closedAt" < ${asOf}::timestamptz
				)
			)
			${extra.length > 0 ? sql`and ${sql.join(extra, sql` and `)}` : sql``}
	`;
}

/**
 * Строки среза с признаками. `window` — страница экрана; без него набор
 * полный, и это выгрузка.
 *
 * Признаки считаются после отбора страницы, а не до него: боковых выборок на
 * строку шесть, и на трёх тысячах строк они и есть та секунда, которой не
 * хватает отклику.
 */
export async function readSnapshotRows(
	ctx: ActorContext,
	query: ReportQuery,
	window: RowWindow | null = null
): Promise<SnapshotRow[]> {
	const asOf = snapshotMoment(query.to).toISOString();

	const rows = await getDb().execute<SnapshotRowRaw>(sql`
		with selection as (${snapshotSelection(ctx, query)}),
		page as (
			select * from selection
			order by ${snapshotOrder(sql`selection`)}
			${windowClause(window)}
		)
		select page.*, ${ATTRIBUTE_COLUMNS}
		from page
		${attributeJoins(asOf, sql`page`)}
		order by ${snapshotOrder(sql`page`)}
	`);

	return [...rows].map((row) => ({
		...row,
		enteredAt: toDate(row.enteredAt),
		closedAt: toDate(row.closedAt)
	}));
}
