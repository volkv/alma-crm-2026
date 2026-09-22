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
 *
 * Выборка отделена от строк: `movementSelection` отдаёт события с колонками, по
 * которым считаются итоги, динамика и разрезы, а `readMovementRows` добавляет к
 * ним признаки — и только для тех строк, которые уйдут в ответ.
 */
import type { StageOutcome } from '$lib/contracts/interactions';
import type { ReportEventKind, ReportQuery } from '$lib/contracts/reports';
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

/** Колонки движения сверх общих: само событие. */
export type MovementSelectionRow = ReportSelection & {
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

/** Строка движения в том виде, в каком её показывают: выборка плюс признаки. */
export type MovementRow = MovementSelectionRow & ReportAttributes;

/** Строка в том виде, в каком её отдаёт драйвер: момент приезжает строкой. */
type MovementRowRaw = Omit<MovementRow, 'movedAt'> & { movedAt: Date | string };

/**
 * Считать ли переносы при изменении процесса.
 *
 * Отчёту они не строки: перенос — административный переезд, и в таблицу,
 * в итоги и в серии динамики он не входит, а показывается отдельной отметкой.
 * Сверке режимов (И4) они нужны целиком: без них разность двух срезов не
 * сошлась бы с движением на той стадии, откуда запись увезли.
 */
export type MigrationMode = 'include' | 'exclude';

/**
 * Перенос при изменении процесса — то же условие, что ветка `outcome ===
 * 'migrated'` в `movementEventKind`, записанное для базы. Две формулировки
 * одного признака, и расхождение между ними ловит инвариант И3: сумма по видам
 * событий считается разбором `movementEventKind`, а число строк — этим
 * условием.
 *
 * `source` — псевдоним событий: выборка зовёт его по своему имени, агрегат по
 * своему, а признак остаётся один.
 *
 * Сравнение исхода — `is not distinct from`, а не `=`: отмена закрывает запись
 * **без** исхода, и обычное сравнение дало бы на ней `null`. Отрицание такого
 * условия — тоже `null`, то есть «не переезд» превратилось бы в «неизвестно», и
 * отменённое взаимодействие пропало бы из движения молча.
 */
export function migrationEvent(source: SQL): SQL {
	return sql`not ${source}."isStart" and ${source}.outcome is not distinct from 'migrated'`;
}

/**
 * Порядок строк движения. Один на страницу и на выгрузку; `isStart` в конце
 * разводит две строки одной записи — начало работы и уход с неё.
 */
function movementOrder(source: SQL): SQL {
	return sql`${source}."movedAt", ${source}."interactionId", ${source}."entryId", ${source}."isStart"`;
}

/**
 * Выборка движения без признаков строки.
 *
 * Фильтр по стадии в движении бьёт и по «откуда», и по «куда»: вопрос «что
 * происходило на этой стадии» включает и приходы на неё, и уходы с неё.
 */
export function movementSelection(
	ctx: ActorContext,
	query: ReportQuery,
	migrations: MigrationMode
): SQL {
	// Моменты уходят в запрос строками ISO: у параметра в готовом SQL нет
	// выведенного типа, и драйвер не берётся кодировать объект даты вслепую.
	const asOf = snapshotMoment(query.to).toISOString();
	const periodStart = moscowDayStart(query.from).toISOString();
	const conditions = interactionConditions(ctx, query);

	const filters: SQL[] = [];

	if (query.stage.length > 0) {
		filters.push(
			sql`(events."fromKey" in ${inList(query.stage)} or events."toKey" in ${inList(query.stage)})`
		);
	}

	if (migrations === 'exclude') {
		filters.push(sql`not (${migrationEvent(sql`events`)})`);
	}

	return sql`
		select events.*
		from (
			select
				${SELECTION_COLUMNS},
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
			left join workspaces workspace on workspace.id = interactions.workspace_id
			${PRIMARY_PARTY_JOIN}
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
				${SELECTION_COLUMNS},
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
			left join workspaces workspace on workspace.id = interactions.workspace_id
			${PRIMARY_PARTY_JOIN}
			join stage_entries entry on entry.interaction_id = interactions.id
			where ${conditions}
				and entry.entered_at >= ${periodStart}::timestamptz
				and entry.entered_at < ${asOf}::timestamptz
				and not exists (
					select 1 from stage_entries earlier
					where earlier.interaction_id = interactions.id
						and earlier.entered_at < entry.entered_at
				)
		) events
		${filters.length > 0 ? sql`where ${sql.join(filters, sql` and `)}` : sql``}
	`;
}

/**
 * Строки движения с признаками. `window` — страница экрана; без него набор
 * полный, и это выгрузка.
 */
export async function readMovementRows(
	ctx: ActorContext,
	query: ReportQuery,
	options: { migrations: MigrationMode; window?: RowWindow | null }
): Promise<MovementRow[]> {
	const asOf = snapshotMoment(query.to).toISOString();

	const rows = await getDb().execute<MovementRowRaw>(sql`
		with selection as (${movementSelection(ctx, query, options.migrations)}),
		page as (
			select * from selection
			order by ${movementOrder(sql`selection`)}
			${windowClause(options.window ?? null)}
		)
		select page.*, ${ATTRIBUTE_COLUMNS}
		from page
		${attributeJoins(asOf, sql`page`)}
		order by ${movementOrder(sql`page`)}
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
	row: Pick<MovementSelectionRow, 'isStart' | 'outcome' | 'hasNext'>
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
