/**
 * Движение за период: что произошло внутри полуоткрытого промежутка от начала
 * дня «с» до `T`. Той же границей `T` пользуется срез, поэтому ни одно событие
 * не попадает в два периода и ни одно не теряется между ними.
 *
 * Строка — событие, а не взаимодействие: повторный проход через стадию даёт
 * столько строк, сколько раз через неё проходили. Это не двойной счёт — событий
 * действительно было столько.
 *
 * Событий два сорта, и берутся они из двух мест. Уход со стадии — это закрытая
 * запись, чей `left_at` попал в период; вид события восстанавливается из её
 * исхода и из того, открылась ли следующая. Начало работы — первая запись
 * взаимодействия: у неё нет входа «откуда», и по закрытию её не найти.
 */
import type { InteractionStatus, StageOutcome } from '$lib/contracts/interactions';
import type { ReportEventKind, ReportQuery } from '$lib/contracts/reports';
import { moscowDayStart, snapshotMoment } from '$lib/contracts/calendar';
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

export type MovementRow = ReportAttributes & {
	interactionId: string;
	title: string;
	status: InteractionStatus;
	processGroupId: string;
	processGroupKey: string;
	/** Покидаемая запись; у начала работы — первая запись взаимодействия. */
	entryId: string;
	movedAt: Date;
	outcome: StageOutcome | null;
	moveReason: string | null;
	fromKey: string | null;
	fromName: string | null;
	toKey: string | null;
	toName: string | null;
	/** После ухода открылась следующая запись — значит, работа продолжилась. */
	hasNext: boolean;
	isStart: boolean;
};

/** Строка в том виде, в каком её отдаёт драйвер: момент приезжает строкой. */
type MovementRowRaw = Omit<MovementRow, 'movedAt'> & { movedAt: Date | string };

export async function readMovementRows(
	ctx: ActorContext,
	query: ReportQuery
): Promise<MovementRow[]> {
	// Моменты уходят в запрос строками ISO: у параметра в готовом SQL нет
	// выведенного типа, и драйвер не берётся кодировать объект даты вслепую.
	const asOf = snapshotMoment(query.to).toISOString();
	const periodStart = moscowDayStart(query.from).toISOString();
	const conditions = interactionConditions(ctx, query);

	// Фильтр по стадии в движении бьёт и по «откуда», и по «куда»: вопрос «что
	// происходило на этой стадии» включает и приходы на неё, и уходы с неё.
	const stageFilter =
		query.stage.length > 0
			? sql`where events."fromKey" in ${inList(query.stage)} or events."toKey" in ${inList(query.stage)}`
			: sql``;

	const rows = await getDb().execute<MovementRowRaw>(sql`
		with events as (
			select
				interactions.id as "interactionId",
				interactions.title as "title",
				interactions.status as "status",
				interactions.process_group_id as "processGroupId",
				entry.id as "entryId",
				entry.left_at as "movedAt",
				entry.outcome as "outcome",
				entry.outcome_reason as "moveReason",
				entry.stage_snapshot ->> 'key' as "fromKey",
				entry.stage_snapshot ->> 'name' as "fromName",
				following."stageKey" as "toKey",
				following."stageName" as "toName",
				following."entryId" is not null as "hasNext",
				false as "isStart"
			from interactions
			join stage_entries entry on entry.interaction_id = interactions.id
			left join lateral (
				select
					next_entry.id as "entryId",
					next_entry.stage_snapshot ->> 'key' as "stageKey",
					next_entry.stage_snapshot ->> 'name' as "stageName"
				from stage_entries next_entry
				where next_entry.interaction_id = interactions.id
					and next_entry.id <> entry.id
					and next_entry.entered_at >= entry.left_at
				-- Переход закрывает предыдущую запись и открывает следующую одним и
				-- тем же моментом, поэтому «следующая» — ближайшая по входу; при
				-- равенстве первой идёт та, что сама закрылась раньше.
				order by next_entry.entered_at asc, next_entry.left_at asc nulls last
				limit 1
			) following on true
			where ${conditions}
				and entry.left_at >= ${periodStart}::timestamptz
				and entry.left_at < ${asOf}::timestamptz
			union all
			select
				interactions.id,
				interactions.title,
				interactions.status,
				interactions.process_group_id,
				entry.id,
				entry.entered_at,
				null,
				null,
				null,
				null,
				entry.stage_snapshot ->> 'key',
				entry.stage_snapshot ->> 'name',
				false,
				true
			from interactions
			join stage_entries entry on entry.interaction_id = interactions.id
			where ${conditions}
				and entry.entered_at >= ${periodStart}::timestamptz
				and entry.entered_at < ${asOf}::timestamptz
				and not exists (
					select 1 from stage_entries earlier
					where earlier.interaction_id = interactions.id
						and earlier.entered_at < entry.entered_at
				)
		)
		select events.*, process_group.key as "processGroupKey", ${ATTRIBUTE_COLUMNS}
		from events
		join interactions on interactions.id = events."interactionId"
		left join process_groups process_group on process_group.id = interactions.process_group_id
		${attributeJoins(asOf)}
		${stageFilter}
		order by events."movedAt", events."interactionId", events."entryId"
	`);

	return [...rows].map((row) => ({
		...row,
		movedAt: row.movedAt instanceof Date ? row.movedAt : new Date(row.movedAt)
	}));
}

/** Перенос при изменении процесса — не переход, но и не невидимка. */
export type MovementEventKind = ReportEventKind | 'migrated';

/**
 * Вид события по покинутой записи. Функция тотальна намеренно: дыра в разборе
 * означала бы строку, которая есть в выборке, но не попала ни в один счётчик, —
 * и сумма по видам перестала бы сходиться с числом строк (инвариант И3).
 *
 * Ушли со стадии и встали на следующую — это шаг вперёд, чем бы ни кончилась
 * покинутая запись. Ушли и не встали — работа закрыта: пройденная стадия
 * означает завершение, непройденная — отмену (`cancelInteraction` закрывает
 * запись без исхода намеренно: стадию не прошли и не пропустили).
 */
export function movementEventKind(
	row: Pick<MovementRow, 'isStart' | 'outcome' | 'hasNext'>
): MovementEventKind {
	if (row.isStart) {
		return 'started';
	}

	if (row.outcome === 'migrated') {
		return 'migrated';
	}

	if (row.outcome === 'returned') {
		return 'return';
	}

	if (row.outcome === 'skipped') {
		return 'skip';
	}

	if (row.hasNext) {
		return 'forward';
	}

	return row.outcome === 'completed' ? 'completed' : 'cancelled';
}
