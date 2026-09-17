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
 */
import type { InteractionStatus, PauseReason } from '$lib/contracts/interactions';
import type { ReportQuery } from '$lib/contracts/reports';
import { moscowDayStart, snapshotMoment } from '$lib/contracts/reports';
import { sql } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import {
	ATTRIBUTE_COLUMNS,
	attributeJoins,
	inList,
	interactionConditions,
	type ReportAttributes
} from './conditions';

/** Строка среза в том виде, в каком её отдаёт база. */
export type SnapshotRow = ReportAttributes & {
	interactionId: string;
	title: string;
	status: InteractionStatus;
	processGroupId: string;
	processGroupKey: string;
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

export async function readSnapshotRows(
	ctx: ActorContext,
	query: ReportQuery
): Promise<SnapshotRow[]> {
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

	const rows = await getDb().execute<SnapshotRowRaw>(sql`
		with picked as (
			select
				interactions.id as "interactionId",
				interactions.title as "title",
				interactions.status as "status",
				interactions.process_group_id as "processGroupId",
				process_group.key as "processGroupKey",
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
		)
		select picked.*, ${ATTRIBUTE_COLUMNS}
		from picked
		join interactions on interactions.id = picked."interactionId"
		${attributeJoins(asOf)}
		order by counterparty.short_name nulls last, picked."title", picked."interactionId"
	`);

	return [...rows].map((row) => ({
		...row,
		enteredAt: toDate(row.enteredAt),
		closedAt: toDate(row.closedAt)
	}));
}
