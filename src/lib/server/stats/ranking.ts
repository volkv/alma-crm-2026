/**
 * Рейтинг программ и направлений по фактам системы.
 *
 * Что складывается и почему именно так — `contracts/ranking.ts` и
 * `stats/facts.ts`. Здесь — граница доступа и кэш:
 *
 * - **рейтинг считается в области вызывающего.** Заявки и группы берутся только
 *   по тем взаимодействиям, которые он видит (`interactionScopeFilter` — общее
 *   условие видимости, с пространствами и ответственностью), иначе место
 *   программы выдавало бы работу по чужим вузам;
 * - **кэш — фактов, а не баллов.** Собранные факты лежат в Redis минуту с
 *   ключом «область доступа × её назначения × период», а веса применяются
 *   после чтения: поменянную настройку видно сразу, а не через минуту. Факты
 *   же меняются от любой заявки и любого результата группы, и поколения,
 *   которое двигали бы все эти команды, нет — поэтому свежесть здесь
 *   ограничена сроком жизни записи, а не инвалидацией.
 */
import { inArray } from 'drizzle-orm';
import {
	academicYear,
	academicYearOf,
	rankSubjects,
	type RankingSubject,
	type RankingView
} from '$lib/contracts/ranking';
import { statPeriodKey, type StatPeriod } from '$lib/contracts/stats';
import { formatIsoDay } from '$lib/format';
import type { ActorContext } from '../actor';
import { assignmentsKey, cached, scopeKey, type CacheRegion } from '../cache/region';
import { getDb } from '../db';
import { directions, programs } from '../db/schema';
import { interactionScopeFilter } from '../interactions/access';
import { requirePermission } from '../rbac';
import { getSetting } from '../settings';
import { listPeriods } from './read';
import {
	aggregateFacts,
	readApplicationFacts,
	readGroupFacts,
	type FactPeriod,
	type FactTotals
} from './facts';

const RANKING_FACTS_REGION: CacheRegion = { name: 'stats-ranking-facts', ttlSeconds: 60 };

/** Что лежит в кэше: строки без баллов и факты, не попавшие ни в одну строку. */
type RankingFactsSnapshot = {
	programs: RankingSubject[];
	directions: RankingSubject[];
	outside: RankingView['outside'];
};

function subjectOf(
	id: string,
	meta: { code: string; name: string; priority: number | null },
	totals: FactTotals
): RankingSubject {
	const { organizationCount, ...facts } = totals;

	return {
		id,
		code: meta.code,
		name: meta.name,
		facts,
		priority: meta.priority,
		organizationCount
	};
}

async function collectFacts(ctx: ActorContext, period: FactPeriod): Promise<RankingFactsSnapshot> {
	const scope = interactionScopeFilter(ctx);
	const [applications, groups] = await Promise.all([
		readApplicationFacts(period, scope),
		readGroupFacts(period, scope)
	]);

	const programIds = [
		...new Set([
			...applications.attributed.map((fact) => fact.programId),
			...groups.flatMap((group) => (group.programId === null ? [] : [group.programId]))
		])
	];

	const programRows =
		programIds.length === 0
			? []
			: await getDb()
					.select({
						id: programs.id,
						code: programs.code,
						name: programs.name,
						priority: programs.priority,
						directionId: programs.directionId
					})
					.from(programs)
					.where(inArray(programs.id, programIds));

	const programById = new Map(programRows.map((row) => [row.id, row]));
	const directionIds = [
		...new Set(programRows.flatMap((row) => (row.directionId === null ? [] : [row.directionId])))
	];

	const directionRows =
		directionIds.length === 0
			? []
			: await getDb()
					.select({ id: directions.id, code: directions.code, name: directions.name })
					.from(directions)
					.where(inArray(directions.id, directionIds));

	const directionById = new Map(directionRows.map((row) => [row.id, row]));

	const byProgram = aggregateFacts(applications.attributed, groups, (programId) => programId);
	const byDirection = aggregateFacts(
		applications.attributed,
		groups,
		(programId) => programById.get(programId)?.directionId ?? null
	);

	return {
		programs: [...byProgram].map(([id, totals]) => {
			const meta = programById.get(id);

			if (meta === undefined) {
				throw new Error(`Программа ${id} есть в фактах, но не в справочнике`);
			}

			return subjectOf(id, meta, totals);
		}),
		directions: [...byDirection].map(([id, totals]) => {
			const meta = directionById.get(id);

			if (meta === undefined) {
				throw new Error(`Направление ${id} есть в фактах, но не в справочнике`);
			}

			// Приоритет — свойство программы; у направления поправки нет.
			return subjectOf(id, { ...meta, priority: null }, totals);
		}),
		outside: {
			groupsWithoutProgram: groups.filter((group) => group.programId === null).length,
			applicationsWithoutProgram: applications.withoutProgram,
			programsWithoutDirection: programRows.filter((row) => row.directionId === null).length
		}
	};
}

/**
 * Рейтинг за период. Право — до кэша: запись в Redis не должна становиться
 * обходом проверки.
 */
export async function getRanking(ctx: ActorContext, period: FactPeriod): Promise<RankingView> {
	requirePermission(ctx, 'stats.read');

	const [weights, assignments] = await Promise.all([
		getSetting('ranking_weights'),
		assignmentsKey(ctx)
	]);

	const facts = await cached(
		RANKING_FACTS_REGION,
		`${scopeKey(ctx)}:${assignments}:${statPeriodKey(period)}`,
		() => collectFacts(ctx, period),
		// Дат в фактах нет: JSON возвращает их ровно в том виде, в каком положили.
		(stored) => stored as RankingFactsSnapshot
	);

	return {
		period: { start: period.start, end: period.end },
		weights,
		programs: rankSubjects(facts.programs, weights),
		directions: rankSubjects(facts.directions, weights),
		outside: facts.outside
	};
}

/** Сколько учебных лет назад предлагает выбор периода, кроме текущего. */
const PAST_ACADEMIC_YEARS = 2;

/**
 * Периоды, за которые предлагается рейтинг: текущий учебный год и два
 * прошлых, а рядом — периоды подтверждённых снимков, чтобы с дашборда можно
 * было перейти к рейтингу того же периода. Рейтинг считается по любому
 * периоду из адреса; список — это подсказка, а не граница.
 */
export async function listRankingPeriods(ctx: ActorContext): Promise<StatPeriod[]> {
	const current = Number(academicYearOf(formatIsoDay()).start.slice(0, 4));
	const academic: StatPeriod[] = Array.from({ length: PAST_ACADEMIC_YEARS + 1 }, (_, index) => ({
		kind: 'academic',
		...academicYear(current - index)
	}));

	const periods = new Map<string, StatPeriod>();

	for (const period of [...academic, ...(await listPeriods(ctx))]) {
		periods.set(`${period.kind} ${statPeriodKey(period)}`, period);
	}

	return [...periods.values()].sort(
		(left, right) => right.start.localeCompare(left.start) || left.end.localeCompare(right.end)
	);
}
