/**
 * «Потоки и слушатели»: потоки всех дел пространства на одной странице.
 *
 * Страница читает потоки, их результаты и списки всех показанных дел разом —
 * по запросу на таблицу, а не по делу за раз: на наполненном пространстве
 * чтение «по одному» давало сотни запросов на одно открытие. Правило «как идёт
 * обучение» — общее с карточкой (`learningTrainingState`), контакты идут через
 * сериализатор людей ядра (`toPersonView`): без права на персональные данные
 * они замаскированы, с правом — остаются следом просмотра в журнале.
 * «Засчитывает ли поток стадию» страница не показывает и не считает: это
 * вопрос карточки одного дела.
 */
import { and, asc, count, desc, eq, exists, inArray, sql } from 'drizzle-orm';
import {
	isFinalLearningResult,
	learningTrainingState,
	type LearnerStatus,
	type LearningTrainingState
} from '$lib/contracts/exchange';
import type { InteractionStatus } from '$lib/contracts/interactions';
import {
	can,
	contactFullName,
	getDb,
	interactionScopeFilter,
	interactions,
	learningGroupLearners,
	learningGroupResults,
	learningGroups,
	people,
	programs,
	toPersonView,
	withPiiTrace,
	workflows,
	workspaces,
	type ActorContext
} from '$lib/platform/core.server';
import { PERMISSIONS } from '$lib/platform/permissions.server';

/** Сколько дел страница показывает: дальше список перестаёт быть обзором. */
export const STREAMS_DEAL_LIMIT = 200;

export type StreamLearner = {
	personId: string;
	fullName: string;
	email: string | null;
	phone: string | null;
	status: LearnerStatus;
};

export type StreamRow = {
	id: string;
	streamNumber: number;
	program: string | null;
	startsOn: string | null;
	endsOn: string | null;
	plannedSeats: number | null;
	learnerCount: number;
	enrolled: number | null;
	completed: number | null;
	expelled: number | null;
	trainingState: LearningTrainingState;
	/** Поимённый список; `null` — людей вызывающему не видно, только числа. */
	learners: StreamLearner[] | null;
};

/**
 * Итоги по потокам — дела или всей страницы. `null` — ни один поток этого
 * числа не прислал: «нет данных» и ноль — разные ответы, как в панели
 * «Слушатели».
 */
export type StreamTotals = {
	streams: number;
	plannedSeats: number | null;
	listed: number | null;
	enrolled: number | null;
	completed: number | null;
	expelled: number | null;
};

export type StreamDeal = {
	id: string;
	title: string;
	status: InteractionStatus;
	/** Программы потоков без повторов; пусто — ни у одного программа не закреплена. */
	programs: string[];
	/** Самое раннее начало и самое позднее окончание среди потоков. */
	startsOn: string | null;
	endsOn: string | null;
	totals: StreamTotals;
	streams: StreamRow[];
};

export type StreamsPage = {
	deals: StreamDeal[];
	totals: StreamTotals;
	/** Дел с потоками больше, чем показано. */
	truncated: boolean;
	limit: number;
	/** Видны ли вызывающему поимённые списки. */
	canSeePeople: boolean;
	/** Откуда взять первый поток — для пустой страницы. */
	firstStream: FirstStreamPath;
};

/**
 * Путь к первому потоку. Поток заявляют кнопкой «Заявить поток» в панели
 * «Группа в системе обучения» карточки; если процесс пространства эту панель в
 * карточку не выбрал, кнопки нет, и пустая страница говорит, где её включить.
 */
export type FirstStreamPath = {
	/** Выбрал ли процесс пространства панель потоков в состав карточки. */
	panelChosen: boolean;
	/** Процесс пространства — для ссылки на состав карточки; `null` — не назначен. */
	workflow: { key: string; name: string } | null;
	/** Может ли вызывающий править состав карточки процесса. */
	canConfigure: boolean;
	/**
	 * Подпись права, которым правят состав карточки. Разметка не видит
	 * `$lib/server/**`, поэтому подпись для пустого состояния несёт сюда сервер —
	 * та же строка, что стоит в матрице ролей.
	 */
	configurePermissionLabel: string;
};

/** Ключ панели, в которой заявляют поток (`index.ts`). */
const LEARNING_PANEL = 'learning';

/** Сумма; `null` — ни одно значение не известно. */
function sum(values: readonly (number | null)[]): number | null {
	const known = values.filter((value): value is number => value !== null);

	return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

/** Поток, как его читает страница: строка группы с программой. */
type GroupRow = {
	id: string;
	interactionId: string;
	streamNumber: number;
	programCode: string | null;
	programName: string | null;
	startsOn: string | null;
	endsOn: string | null;
	plannedSeats: number | null;
	completionMarked: boolean;
};

/** Последний результат потока и было ли среди результатов итоговое. */
type GroupResult = {
	enrolled: number | null;
	completed: number | null;
	expelled: number | null;
	finished: boolean;
};

function toStreamRow(
	group: GroupRow,
	result: GroupResult | undefined,
	learnerCount: number,
	learners: StreamLearner[] | null
): StreamRow {
	return {
		id: group.id,
		streamNumber: group.streamNumber,
		program:
			group.programCode === null || group.programName === null
				? null
				: `${group.programCode} — ${group.programName}`,
		startsOn: group.startsOn,
		endsOn: group.endsOn,
		plannedSeats: group.plannedSeats,
		learnerCount,
		enrolled: result?.enrolled ?? null,
		completed: result?.completed ?? null,
		expelled: result?.expelled ?? null,
		trainingState: learningTrainingState({
			completionMarked: group.completionMarked,
			finished: result?.finished ?? false,
			hasResult: result !== undefined
		}),
		learners
	};
}

export function streamTotals(streams: readonly StreamRow[]): StreamTotals {
	return {
		streams: streams.length,
		plannedSeats: sum(streams.map((stream) => stream.plannedSeats)),
		// Пустой список — «списка нет», а не «ноль человек»: так же считает панель
		// «Слушатели» в карточке.
		listed: sum(streams.map((stream) => (stream.learnerCount === 0 ? null : stream.learnerCount))),
		enrolled: sum(streams.map((stream) => stream.enrolled)),
		completed: sum(streams.map((stream) => stream.completed)),
		expelled: sum(streams.map((stream) => stream.expelled))
	};
}

function toStreamDeal(
	row: { id: string; title: string; status: InteractionStatus },
	streams: StreamRow[]
): StreamDeal {
	// Даты приходят днями `ГГГГ-ММ-ДД`: строки упорядочиваются как даты.
	const starts = streams.flatMap((stream) => (stream.startsOn === null ? [] : [stream.startsOn]));
	const ends = streams.flatMap((stream) => (stream.endsOn === null ? [] : [stream.endsOn]));

	return {
		...row,
		programs: [
			...new Set(streams.flatMap((stream) => (stream.program === null ? [] : [stream.program])))
		],
		startsOn: starts.sort().at(0) ?? null,
		endsOn: ends.sort().at(-1) ?? null,
		totals: streamTotals(streams),
		streams
	};
}

/**
 * Потоки показанных дел с последним результатом, числом людей в списке и —
 * при праве на людей — самими списками. Пять запросов на страницу при любом
 * числе дел.
 */
async function readStreams(
	ctx: ActorContext,
	interactionIds: readonly string[]
): Promise<Map<string, StreamRow[]>> {
	const byDeal = new Map<string, StreamRow[]>();

	if (interactionIds.length === 0) {
		return byDeal;
	}

	const db = getDb();
	const groups: GroupRow[] = await db
		.select({
			id: learningGroups.id,
			interactionId: learningGroups.interactionId,
			streamNumber: learningGroups.streamNumber,
			programCode: programs.code,
			programName: programs.name,
			startsOn: learningGroups.startsOn,
			endsOn: learningGroups.endsOn,
			plannedSeats: learningGroups.plannedSeats,
			// Момент и комментарий отметки ставятся вместе; отметка — только оба.
			completionMarked: sql<boolean>`(${learningGroups.completionMarkedAt} is not null and ${learningGroups.completionComment} is not null)`
		})
		.from(learningGroups)
		.leftJoin(programs, eq(programs.id, learningGroups.programId))
		.where(inArray(learningGroups.interactionId, [...interactionIds]))
		.orderBy(asc(learningGroups.streamNumber));

	const groupIds = groups.map((group) => group.id);

	if (groupIds.length === 0) {
		return byDeal;
	}

	const [results, counts, learners] = await Promise.all([
		db
			.select({
				learningGroupId: learningGroupResults.learningGroupId,
				enrolled: learningGroupResults.enrolled,
				completed: learningGroupResults.completed,
				expelled: learningGroupResults.expelled,
				finishedOn: learningGroupResults.finishedOn
			})
			.from(learningGroupResults)
			.where(inArray(learningGroupResults.learningGroupId, groupIds))
			.orderBy(desc(learningGroupResults.occurredAt)),
		db
			.select({ learningGroupId: learningGroupLearners.learningGroupId, total: count() })
			.from(learningGroupLearners)
			.where(inArray(learningGroupLearners.learningGroupId, groupIds))
			.groupBy(learningGroupLearners.learningGroupId),
		readLearners(ctx, groupIds)
	]);

	const latest = new Map<string, GroupResult>();

	for (const result of results) {
		const known = latest.get(result.learningGroupId);
		const finished = isFinalLearningResult(result);

		if (known === undefined) {
			latest.set(result.learningGroupId, { ...result, finished });
		} else if (finished) {
			known.finished = true;
		}
	}

	const totals = new Map(counts.map((row) => [row.learningGroupId, row.total]));

	for (const group of groups) {
		const row = toStreamRow(
			group,
			latest.get(group.id),
			totals.get(group.id) ?? 0,
			learners === null ? null : (learners.get(group.id) ?? [])
		);

		byDeal.set(group.interactionId, [...(byDeal.get(group.interactionId) ?? []), row]);
	}

	return byDeal;
}

/**
 * Поимённые списки потоков: поток → слушатели по алфавиту. `null` — людей
 * вызывающему не видно, на странице только числа.
 */
async function readLearners(
	ctx: ActorContext,
	groupIds: readonly string[]
): Promise<Map<string, StreamLearner[]> | null> {
	if (!can(ctx, 'people.read')) {
		return null;
	}

	const rows = await getDb()
		.select({
			learningGroupId: learningGroupLearners.learningGroupId,
			status: learningGroupLearners.status,
			person: people
		})
		.from(learningGroupLearners)
		.innerJoin(people, eq(people.id, learningGroupLearners.personId))
		.where(inArray(learningGroupLearners.learningGroupId, [...groupIds]))
		.orderBy(asc(people.lastName), asc(people.firstName), asc(people.id));

	const byGroup = new Map<string, StreamLearner[]>();

	for (const row of rows) {
		const person = toPersonView(ctx, row.person);

		byGroup.set(row.learningGroupId, [
			...(byGroup.get(row.learningGroupId) ?? []),
			{
				personId: person.id,
				fullName: contactFullName(person),
				email: person.email,
				phone: person.phone,
				status: row.status
			}
		]);
	}

	return byGroup;
}

/** Выбрал ли процесс пространства панель потоков — и может ли вызывающий это поправить. */
async function readFirstStreamPath(
	ctx: ActorContext,
	workspaceId: string
): Promise<FirstStreamPath> {
	const [row] = await getDb()
		.select({ key: workflows.key, name: workflows.name, panels: workflows.cardPanels })
		.from(workspaces)
		.innerJoin(workflows, eq(workflows.id, workspaces.workflowId))
		.where(eq(workspaces.id, workspaceId));

	return {
		panelChosen: row?.panels.includes(LEARNING_PANEL) ?? false,
		workflow: row === undefined ? null : { key: row.key, name: row.name },
		canConfigure: can(ctx, 'stages.configure'),
		configurePermissionLabel: PERMISSIONS['stages.configure']
	};
}

/**
 * Дела пространства с потоками в области видимости вызывающего — свежие по
 * активности первыми, не больше `STREAMS_DEAL_LIMIT`, — и их потоки со
 * списками.
 *
 * Дела отбирает область доступа вызывающего, потоки и списки читаются уже
 * только по отобранным делам. Все чтения идут одной областью следа: страница
 * раскрывает контакты многих людей разом, и в журнал уходит одно событие
 * просмотра, а не по одному на дело.
 */
export async function readStreamsPage(
	ctx: ActorContext,
	workspaceId: string
): Promise<StreamsPage> {
	const db = getDb();

	const [rows, firstStream] = await Promise.all([
		db
			.select({ id: interactions.id, title: interactions.title, status: interactions.status })
			.from(interactions)
			.where(
				and(
					eq(interactions.workspaceId, workspaceId),
					interactionScopeFilter(ctx),
					exists(
						db
							.select({ id: learningGroups.id })
							.from(learningGroups)
							.where(eq(learningGroups.interactionId, interactions.id))
					)
				)
			)
			.orderBy(desc(interactions.lastActivityAt), asc(interactions.id))
			.limit(STREAMS_DEAL_LIMIT + 1),
		readFirstStreamPath(ctx, workspaceId)
	]);

	const shown = rows.slice(0, STREAMS_DEAL_LIMIT);
	const streams = await withPiiTrace(ctx, () =>
		readStreams(
			ctx,
			shown.map((row) => row.id)
		)
	);
	const deals = shown.map((row) => toStreamDeal(row, streams.get(row.id) ?? []));

	return {
		deals,
		totals: streamTotals(deals.flatMap((deal) => deal.streams)),
		truncated: rows.length > STREAMS_DEAL_LIMIT,
		limit: STREAMS_DEAL_LIMIT,
		canSeePeople: can(ctx, 'people.read'),
		firstStream
	};
}
