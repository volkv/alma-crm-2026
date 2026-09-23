/**
 * Факты обучения, которые система знает сама: заявки с сайта и учебные группы
 * с их результатами.
 *
 * Отсюда читают двое — рейтинг (`stats/ranking.ts`, в области доступа
 * вызывающего) и сборка снимка из результатов групп (`stats/groups.ts`, по
 * всей базе). Правила одни на обоих, иначе рейтинг и снимок одного периода
 * разошлись бы в числах, которые обязаны совпасть:
 *
 * - **группа относится к периоду по дате старта** (`starts_on`, а если её нет —
 *   по дню заявки группы), то есть ровно к одному периоду одного вида;
 * - **у группы учитывается один результат — последний** по моменту
 *   отправителя. Промежуточный и итоговый результат — два рассказа об одних и
 *   тех же людях;
 * - **завершившие берутся только из итогового результата** (завершили больше
 *   нуля и есть дата окончания — `isFinalLearningResult`, то же правило, что
 *   закрывает стадию). Промежуточный «завершили 3» — это не выпуск;
 * - **заявка с сайта** — взаимодействие, заведённое приёмом заявки из CMS
 *   (`external_source = 'cms:<экземпляр>'`), по дню создания в Москве. У
 *   заявки бывает несколько программ: программе она засчитывается каждой, а
 *   направлению — один раз, сколько бы его программ в ней ни было.
 */
import { and, eq, gte, inArray, isNotNull, isNull, like, lt, lte, or, type SQL } from 'drizzle-orm';
import { moscowDayStart, snapshotMoment } from '$lib/contracts/calendar';
import { externalSourceOf, isFinalLearningResult } from '$lib/contracts/exchange';
import type { RankingFacts } from '$lib/contracts/ranking';
import { getDb } from '../db';
import {
	interactionParties,
	interactionPrograms,
	interactions,
	learningGroupResults,
	learningGroups
} from '../db/schema';

export type FactPeriod = { start: string; end: string };

/** Учебная группа периода с её последним результатом. */
export type GroupFact = {
	groupId: string;
	/** Как группу называет система обучения; `null` — имени ещё не прислали. */
	label: string;
	programId: string | null;
	/** Основная сторона взаимодействия, по которому заведена группа. */
	organizationId: string | null;
	/** `false` — результатов по группе ещё не было. */
	hasResult: boolean;
	enrolled: number | null;
	/** Только из итогового результата; у промежуточного — `null`. */
	completed: number | null;
};

/** Заявка с сайта и одна из её программ. */
export type ApplicationFact = {
	interactionId: string;
	programId: string;
	organizationId: string | null;
};

/** Результат группы в том виде, в каком из него выбирается последний. */
export type GroupResultFact = {
	learningGroupId: string;
	occurredAt: Date;
	enrolled: number | null;
	completed: number | null;
	finishedOn: string | null;
};

/**
 * Последний результат каждой группы. Порядок входа не важен: выбор идёт по
 * моменту отправителя, а не по тому, как строки вернула база.
 */
export function latestResults(results: readonly GroupResultFact[]): Map<string, GroupResultFact> {
	const latest = new Map<string, GroupResultFact>();

	for (const result of results) {
		const current = latest.get(result.learningGroupId);

		if (current === undefined || result.occurredAt.getTime() > current.occurredAt.getTime()) {
			latest.set(result.learningGroupId, result);
		}
	}

	return latest;
}

/** Сложение, в котором «нет данных» плюс «нет данных» остаётся «нет данных». */
export function addNullable(left: number | null, right: number | null): number | null {
	return left === null ? right : right === null ? left : left + right;
}

/** Группа стартовала в периоде: по дате старта, а без неё — по дню заявки. */
function groupInPeriod(period: FactPeriod): SQL | undefined {
	return or(
		and(
			isNotNull(learningGroups.startsOn),
			gte(learningGroups.startsOn, period.start),
			lte(learningGroups.startsOn, period.end)
		),
		and(
			isNull(learningGroups.startsOn),
			gte(learningGroups.requestedAt, moscowDayStart(period.start)),
			lt(learningGroups.requestedAt, snapshotMoment(period.end))
		)
	);
}

/**
 * Группы периода с последним результатом.
 *
 * `scope` — условие на `interactions`: у рейтинга это область доступа
 * вызывающего, у сборки снимка — вся база.
 */
export async function readGroupFacts(period: FactPeriod, scope: SQL): Promise<GroupFact[]> {
	const db = getDb();

	const groups = await db
		.select({
			groupId: learningGroups.id,
			groupExternalId: learningGroups.groupExternalId,
			streamNumber: learningGroups.streamNumber,
			programId: learningGroups.programId,
			organizationId: interactionParties.organizationId
		})
		.from(learningGroups)
		.innerJoin(interactions, eq(interactions.id, learningGroups.interactionId))
		.leftJoin(
			interactionParties,
			and(
				eq(interactionParties.interactionId, interactions.id),
				eq(interactionParties.isPrimary, true)
			)
		)
		.where(and(groupInPeriod(period), scope));

	if (groups.length === 0) {
		return [];
	}

	const results = await db
		.select({
			learningGroupId: learningGroupResults.learningGroupId,
			occurredAt: learningGroupResults.occurredAt,
			enrolled: learningGroupResults.enrolled,
			completed: learningGroupResults.completed,
			finishedOn: learningGroupResults.finishedOn
		})
		.from(learningGroupResults)
		.where(
			inArray(
				learningGroupResults.learningGroupId,
				groups.map((group) => group.groupId)
			)
		);

	const latest = latestResults(results);

	return groups.map((group) => {
		const result = latest.get(group.groupId);

		return {
			groupId: group.groupId,
			label: group.groupExternalId ?? `поток ${group.streamNumber}`,
			programId: group.programId,
			organizationId: group.organizationId,
			hasResult: result !== undefined,
			enrolled: result?.enrolled ?? null,
			completed: result !== undefined && isFinalLearningResult(result) ? result.completed : null
		};
	});
}

/** Заявки с сайта за период — по строке на пару «заявка × программа». */
export async function readApplicationFacts(
	period: FactPeriod,
	scope: SQL
): Promise<{ attributed: ApplicationFact[]; withoutProgram: number }> {
	const rows = await getDb()
		.select({
			interactionId: interactions.id,
			programId: interactionPrograms.programId,
			organizationId: interactionParties.organizationId
		})
		.from(interactions)
		.leftJoin(interactionPrograms, eq(interactionPrograms.interactionId, interactions.id))
		.leftJoin(
			interactionParties,
			and(
				eq(interactionParties.interactionId, interactions.id),
				eq(interactionParties.isPrimary, true)
			)
		)
		.where(
			and(
				like(interactions.externalSource, `${externalSourceOf('cms', '')}%`),
				gte(interactions.createdAt, moscowDayStart(period.start)),
				lt(interactions.createdAt, snapshotMoment(period.end)),
				scope
			)
		);

	const attributed: ApplicationFact[] = [];
	const withoutProgram = new Set<string>();

	for (const row of rows) {
		if (row.programId === null) {
			withoutProgram.add(row.interactionId);
		} else {
			attributed.push({
				interactionId: row.interactionId,
				programId: row.programId,
				organizationId: row.organizationId
			});
		}
	}

	return { attributed, withoutProgram: withoutProgram.size };
}

/** Факты одной строки, пока их собирают: множества, чтобы не посчитать дважды. */
type Accumulator = {
	applications: Set<string>;
	streams: number;
	enrolled: number | null;
	completed: number | null;
	organizations: Set<string>;
};

function emptyAccumulator(): Accumulator {
	return {
		applications: new Set(),
		streams: 0,
		enrolled: null,
		completed: null,
		organizations: new Set()
	};
}

export type FactTotals = RankingFacts & { organizationCount: number };

/**
 * Факты по ключу строки: программе или направлению.
 *
 * `keyOf` отвечает, к какой строке относится программа; `null` — ни к какой
 * (у программы нет направления). Заявка считается по своему взаимодействию,
 * поэтому две программы одного направления в одной заявке дают направлению
 * одну заявку.
 */
export function aggregateFacts(
	applications: readonly ApplicationFact[],
	groups: readonly GroupFact[],
	keyOf: (programId: string) => string | null
): Map<string, FactTotals> {
	const rows = new Map<string, Accumulator>();

	const rowOf = (programId: string): Accumulator | null => {
		const key = keyOf(programId);

		if (key === null) {
			return null;
		}

		const existing = rows.get(key);

		if (existing !== undefined) {
			return existing;
		}

		const created = emptyAccumulator();
		rows.set(key, created);

		return created;
	};

	for (const application of applications) {
		const row = rowOf(application.programId);

		if (row === null) {
			continue;
		}

		row.applications.add(application.interactionId);

		if (application.organizationId !== null) {
			row.organizations.add(application.organizationId);
		}
	}

	for (const group of groups) {
		if (group.programId === null) {
			continue;
		}

		const row = rowOf(group.programId);

		if (row === null) {
			continue;
		}

		row.streams += 1;
		row.enrolled = addNullable(row.enrolled, group.enrolled);
		row.completed = addNullable(row.completed, group.completed);

		if (group.organizationId !== null) {
			row.organizations.add(group.organizationId);
		}
	}

	return new Map(
		[...rows].map(([key, row]) => [
			key,
			{
				applications: row.applications.size,
				streams: row.streams,
				enrolled: row.enrolled,
				completed: row.completed,
				organizationCount: row.organizations.size
			}
		])
	);
}
