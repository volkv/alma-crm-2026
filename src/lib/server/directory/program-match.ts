/**
 * Подбор программ школы под вуз по его разделу «Сведения».
 *
 * Правило одно и объясняется одной фразой: программа школы подходит вузу, если
 * у вуза есть программы той же укрупнённой группы направлений ФГОС (первые две
 * цифры кода: `09.03.01` → `09.00.00`). Ровно тот же код направления — довод
 * сильнее, чем просто общая группа; ручной приоритет программы школы решает
 * при прочих равных. Никаких весов, моделей и догадок: каждая строка подбора
 * несёт то, из чего она получилась, и сотрудник может пересчитать её глазами.
 */
import type { ProgramCandidate } from '$lib/contracts/enrichment';
import {
	fgosGroupOf,
	type FgosGroup,
	type ProgramMatch,
	type ProgramMatchResult
} from '$lib/contracts/organization-card';
import { catalogListQuerySchema, type ProgramView } from '$lib/contracts/directory';
import { pluralize } from '$lib/format';
import type { ActorContext } from '../actor';
import { can } from '../rbac';
import { listPrograms } from './read';

/** Программа школы в том объёме, который нужен подбору. */
export type SchoolProgram = Pick<
	ProgramView,
	'id' | 'code' | 'name' | 'directionCode' | 'priority'
>;

const PROGRAM_FORMS = ['программа', 'программы', 'программ'] as const;

function groupLabel(group: FgosGroup): string {
	return group.name === null ? group.code : `${group.code} «${group.name}»`;
}

function explain(
	program: SchoolProgram,
	directionCode: string,
	match: Omit<ProgramMatch, 'reason'>
) {
	const exact =
		match.sameCodeCount > 0
			? `, из них ${match.sameCodeCount} — ровно по направлению ${directionCode}`
			: '';
	const priority =
		program.priority === null ? 'приоритет не назначен' : `приоритет ${program.priority}`;

	return (
		`У вуза ${pluralize(match.groupCount, PROGRAM_FORMS)} группы ${groupLabel(match.group)}${exact}; ` +
		`наша «${program.name}» (${directionCode}) — той же группы; ${priority}`
	);
}

/** Приоритет `null` — «не назначен»: такие идут после всех, кому его проставили. */
function priorityRank(priority: number | null): number {
	return priority ?? Number.POSITIVE_INFINITY;
}

/**
 * Подбор без обращения к базе: на вход — программы вуза с сайта и программы
 * школы, на выход — подходящие с объяснением.
 *
 * Порядок: сначала те, у кого код направления совпал точно, затем — у кого
 * у вуза больше программ той же группы, затем приоритет школы, затем название.
 */
export function matchPrograms(
	university: readonly ProgramCandidate[],
	school: readonly SchoolProgram[]
): ProgramMatchResult {
	const groups = new Map<string, { group: FgosGroup; count: number }>();
	const codes = new Map<string, number>();
	let universityOutside = 0;

	for (const program of university) {
		const group = fgosGroupOf(program.code);

		if (group === null) {
			universityOutside += 1;
			continue;
		}

		const known = groups.get(group.code);

		if (known === undefined) {
			groups.set(group.code, { group, count: 1 });
		} else {
			known.count += 1;
		}

		codes.set(program.code, (codes.get(program.code) ?? 0) + 1);
	}

	const matches: ProgramMatch[] = [];
	let schoolWithoutCode = 0;

	for (const program of school) {
		const directionCode = program.directionCode?.trim() ?? '';
		const group = fgosGroupOf(directionCode);

		if (group === null) {
			schoolWithoutCode += 1;
			continue;
		}

		const groupCount = groups.get(group.code)?.count ?? 0;

		if (groupCount === 0) {
			continue;
		}

		const match = {
			programId: program.id,
			programCode: program.code,
			programName: program.name,
			directionCode,
			priority: program.priority,
			group,
			groupCount,
			sameCodeCount: codes.get(directionCode) ?? 0
		};

		matches.push({ ...match, reason: explain(program, directionCode, match) });
	}

	matches.sort(
		(left, right) =>
			Number(right.sameCodeCount > 0) - Number(left.sameCodeCount > 0) ||
			right.groupCount - left.groupCount ||
			priorityRank(left.priority) - priorityRank(right.priority) ||
			left.programName.localeCompare(right.programName, 'ru')
	);

	return {
		universityGroups: [...groups.values()].sort(
			(left, right) => right.count - left.count || left.group.code.localeCompare(right.group.code)
		),
		matches,
		universityOutside,
		schoolWithoutCode
	};
}

/** Страница каталога: за один раз справочник отдаёт не больше сотни записей. */
const PAGE_SIZE = 100;

/**
 * Подбор по действующим программам школы. `null` — у сотрудника нет права
 * видеть каталог программ: подбирать ему не из чего, и экран говорит об этом
 * словами, а не пустым списком.
 */
export async function matchSchoolPrograms(
	ctx: ActorContext,
	university: readonly ProgramCandidate[]
): Promise<ProgramMatchResult | null> {
	if (!can(ctx, 'programs.read')) {
		return null;
	}

	const school: SchoolProgram[] = [];

	for (let page = 1; ; page += 1) {
		const result = await listPrograms(
			ctx,
			catalogListQuerySchema.parse({ status: 'active', page, pageSize: PAGE_SIZE })
		);

		school.push(...result.items);

		if (school.length >= result.total || result.items.length === 0) {
			break;
		}
	}

	return matchPrograms(university, school);
}
