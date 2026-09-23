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
 * декабре, дал бы декабрьские числа. Норматив — тот, что действовал для записи
 * на `T` (`slaAt`), а не тот, что записан в её снимок сейчас.
 *
 * Выборка отделена от строк: `snapshotSelection` отдаёт условия и колонки, по
 * которым считаются итоги и воронка, а `readSnapshotRows` добавляет к ним
 * признаки — и только для тех строк, которые уйдут в ответ.
 */
import type { PauseReason } from '$lib/contracts/interactions';
import type { ReportQuery } from '$lib/contracts/reports';
import { moscowDayStart } from '$lib/contracts/calendar';
import { sql, type SQL } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import {
	ATTRIBUTE_COLUMNS,
	attributeJoins,
	inList,
	interactionConditions,
	PRIMARY_PARTY_JOIN,
	reportMoment,
	selectionColumns,
	windowClause,
	type ReportAttributes,
	type ReportSelection,
	type RowWindow
} from './conditions';
import type { ReportExecutor } from './transaction';

/** Колонки среза сверх общих: где строка стоит на `T` и сколько уже стоит. */
export type SnapshotSelectionRow = ReportSelection & {
	/** Запись о стадии, накрывающая `T`; у закрытого взаимодействия её нет. */
	entryId: string | null;
	enteredAt: Date | null;
	stageKey: string | null;
	stageName: string | null;
	/** Норматив стадии, действовавший для этой записи на `T` (`slaAt`). */
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
 * Норматив записи о стадии на момент `T`, в днях.
 *
 * Снимок записи (`stage_snapshot`) хранит норматив, но не навсегда: публикация
 * изменённого процесса пересобирает снимки **открытых** записей — изменение
 * обязано применяться ко всем, кто сейчас на стадии (`migrateEntries`). Снимок
 * записи, открытой во время публикации, после неё говорит о новом нормативе, и
 * срез на дату до публикации посчитал бы по нему просрочку задним числом.
 *
 * Прошлое при этом не потеряно: опубликованные редакции заморожены и хранят
 * стадии со своими нормативами. Поэтому правило такое.
 *
 * 1. Ищется первая публикация процесса **не раньше** `T`, которая застала
 *    запись открытой (`entered_at` раньше публикации, `left_at` позже или
 *    пусто) и была именно сменой редакции — у неё есть опубликованная
 *    предшественница. Первая редакция процесса ничего не перепривязывает.
 * 2. Такой нет — снимок с `T` не переписывался, и норматив берётся из него.
 * 3. Такая есть — на `T` действовала её предшественница: между `T` и этой
 *    публикацией других смен редакции не было (иначе первой была бы она), а
 *    открытая запись привязана к стадии действующей редакции. Норматив — у
 *    стадии предшественницы с ключом записи; ключ перепривязкой не меняется.
 *
 * Публикация ровно в момент `T` считается случившейся после среза — так же,
 * как переход ровно в `T` относится уже к следующим суткам.
 *
 * Процесс записи — процесс её стадии: пространству, в котором есть
 * взаимодействия, процесс сменить нельзя, так что он один на всю жизнь записи.
 */
function slaAt(asOf: string): SQL {
	return sql`(
		select case
			when rebinding."publishedAt" is null then (entry.stage_snapshot ->> 'slaDays')::integer
			else previous_stage.sla_days
		end
		from stages bound_stage
		join process_revisions bound_revision on bound_revision.id = bound_stage.revision_id
		left join lateral (
			select later.published_at as "publishedAt"
			from process_revisions later
			where later.workflow_id = bound_revision.workflow_id
				and later.published_at >= ${asOf}::timestamptz
				and later.published_at > entry.entered_at
				and (entry.left_at is null or entry.left_at > later.published_at)
				and exists (
					select 1 from process_revisions earlier
					where earlier.workflow_id = later.workflow_id
						and earlier.published_at < later.published_at
				)
			order by later.published_at
			limit 1
		) rebinding on true
		left join lateral (
			select stage.sla_days
			from process_revisions previous
			join stages stage
				on stage.revision_id = previous.id
				and stage.key = entry.stage_snapshot ->> 'key'
			where previous.id = (
				select candidate.id from process_revisions candidate
				where candidate.workflow_id = bound_revision.workflow_id
					and candidate.published_at < rebinding."publishedAt"
				order by candidate.published_at desc
				limit 1
			)
		) previous_stage on true
		where bound_stage.id = entry.stage_id
	)`;
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
	const asOf = reportMoment(query);
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
			${selectionColumns(asOf)},
			covering."entryId" as "entryId",
			covering."enteredAt" as "enteredAt",
			covering."stageKey" as "stageKey",
			covering."stageName" as "stageName",
			covering."slaDays" as "slaDays",
			covering."activeSeconds" as "activeSeconds",
			covering."pauseReason" as "pauseReason",
			closing."closedAt" as "closedAt"
		from interactions
		left join workspaces workspace on workspace.id = interactions.workspace_id
		${PRIMARY_PARTY_JOIN}
		left join lateral (
			select
				entry.id as "entryId",
				entry.entered_at as "enteredAt",
				entry.stage_snapshot ->> 'key' as "stageKey",
				entry.stage_snapshot ->> 'name' as "stageName",
				${slaAt(asOf)} as "slaDays",
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
	db: ReportExecutor,
	ctx: ActorContext,
	query: ReportQuery,
	window: RowWindow | null = null
): Promise<SnapshotRow[]> {
	const asOf = reportMoment(query);

	const rows = await db.execute<SnapshotRowRaw>(sql`
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
