/**
 * «Потоки и слушатели»: потоки всех дел пространства на одной странице.
 *
 * Потоки и списки читаются теми же сервисами ядра, что и карточка
 * (`listLearningGroups`, `listInteractionLearners`), по одному делу за раз.
 * Это лишние запросы, зато правило «засчитывается ли поток стадии»,
 * маскирование контактов без права на персональные данные и след их просмотра
 * остаются теми же, что в карточке, а не повторяются здесь вторым списком.
 */
import { and, asc, desc, eq, exists } from 'drizzle-orm';
import type {
	LearnerStatus,
	LearningGroupLearnerView,
	LearningGroupView,
	LearningTrainingState
} from '$lib/contracts/exchange';
import type { InteractionStatus } from '$lib/contracts/interactions';
import {
	can,
	getDb,
	interactionScopeFilter,
	interactions,
	learningGroups,
	listInteractionLearners,
	listLearningGroups,
	withPiiTrace,
	type ActorContext
} from '$lib/platform/core.server';

/** Сколько дел страница показывает: дальше список перестаёт быть обзором. */
export const STREAMS_DEAL_LIMIT = 200;

/** Сколько дел читается одновременно: каждое — несколько запросов к базе. */
const CONCURRENCY = 8;

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
};

/** Сумма; `null` — ни одно значение не известно. */
function sum(values: readonly (number | null)[]): number | null {
	const known = values.filter((value): value is number => value !== null);

	return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

function toStreamRow(
	group: LearningGroupView,
	learners: readonly LearningGroupLearnerView[] | null
): StreamRow {
	return {
		id: group.id,
		streamNumber: group.streamNumber,
		program: group.program === null ? null : `${group.program.code} — ${group.program.name}`,
		startsOn: group.startsOn,
		endsOn: group.endsOn,
		plannedSeats: group.plannedSeats,
		learnerCount: group.learnerCount,
		enrolled: group.enrolled,
		completed: group.completed,
		expelled: group.expelled,
		trainingState: group.trainingState,
		learners:
			learners === null
				? null
				: learners
						.filter((learner) => learner.learningGroupId === group.id)
						.map((learner) => ({
							personId: learner.personId,
							fullName: learner.fullName,
							email: learner.email,
							phone: learner.phone,
							status: learner.status
						}))
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
 * Дела пространства с потоками в области видимости вызывающего — свежие по
 * активности первыми, не больше `STREAMS_DEAL_LIMIT`, — и их потоки со
 * списками.
 *
 * Все чтения идут одной областью следа: страница раскрывает контакты многих
 * людей разом, и в журнал уходит одно событие просмотра, а не по одному на
 * дело.
 */
export async function readStreamsPage(
	ctx: ActorContext,
	workspaceId: string
): Promise<StreamsPage> {
	const db = getDb();

	const rows = await db
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
		.limit(STREAMS_DEAL_LIMIT + 1);

	const shown = rows.slice(0, STREAMS_DEAL_LIMIT);

	const deals = await withPiiTrace(ctx, async () => {
		const result: StreamDeal[] = [];

		for (let start = 0; start < shown.length; start += CONCURRENCY) {
			const batch = await Promise.all(
				shown.slice(start, start + CONCURRENCY).map(async (row): Promise<StreamDeal> => {
					const [groups, learners] = await Promise.all([
						listLearningGroups(ctx, row.id),
						listInteractionLearners(ctx, row.id)
					]);

					return toStreamDeal(
						row,
						groups.map((group) => toStreamRow(group, learners))
					);
				})
			);

			result.push(...batch);
		}

		return result;
	});

	return {
		deals,
		totals: streamTotals(deals.flatMap((deal) => deal.streams)),
		truncated: rows.length > STREAMS_DEAL_LIMIT,
		limit: STREAMS_DEAL_LIMIT,
		canSeePeople: can(ctx, 'people.read')
	};
}
