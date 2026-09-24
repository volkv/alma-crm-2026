/**
 * Подбор программ школы под вуз по кодам направлений ФГОС.
 *
 * Правило обещает сотруднику объяснимость: программа подходит, если у вуза
 * есть программы той же укрупнённой группы, точный код — довод сильнее, а
 * приоритет школы решает при прочих равных. Разъедется правило — карточка
 * начнёт рекомендовать то, что нельзя объяснить словами.
 */
import { describe, expect, it } from 'vitest';
import type { ProgramCandidate } from '$lib/contracts/enrichment';
import { matchPrograms, type SchoolProgram } from '$lib/server/directory/program-match';

function university(code: string, name = `Программа ${code}`): ProgramCandidate {
	return { code, name, level: null, profile: null, forms: [] };
}

function school(
	id: string,
	directionCode: string | null,
	priority: number | null,
	name = `Школа ${id}`
): SchoolProgram {
	return { id, code: `P-${id}`, name, directionCode, priority };
}

describe('matchPrograms', () => {
	it('сводит коды в укрупнённую группу и объясняет подбор словами', () => {
		const result = matchPrograms(
			[
				university('09.03.01'),
				university('09.03.01', 'Другой профиль'),
				university('09.04.02'),
				university('09.03.04'),
				university('38.03.01'),
				university('2.3.5')
			],
			[school('python', '09.03.01', 1, 'Аналитика на Python'), school('law', '40.03.01', 1)]
		);

		expect(result.universityGroups).toEqual([
			{ group: { code: '09.00.00', name: 'Информатика и вычислительная техника' }, count: 4 },
			{ group: { code: '38.00.00', name: 'Экономика и управление' }, count: 1 }
		]);
		expect(result.universityOutside).toBe(1);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({
			programId: 'python',
			groupCount: 4,
			sameCodeCount: 2
		});
		expect(result.matches[0].reason).toBe(
			'У вуза 4 программы группы 09.00.00 «Информатика и вычислительная техника», из них 2 — ровно по направлению 09.03.01; наша «Аналитика на Python» (09.03.01) — той же группы; приоритет 1'
		);
	});

	it('ставит точное совпадение кода выше, а приоритет решает при прочих равных', () => {
		const result = matchPrograms(
			[university('09.03.01'), university('09.03.03')],
			[
				school('none', '09.03.04', null),
				school('second', '09.02.07', 2),
				school('first', '09.04.01', 1),
				school('exact', '09.03.01', 5),
				school('nocode', null, 1)
			]
		);

		expect(result.matches.map((match) => match.programId)).toEqual([
			'exact',
			'first',
			'second',
			'none'
		]);
		expect(result.schoolWithoutCode).toBe(1);
	});

	it('без программ вуза ничего не подбирает', () => {
		const result = matchPrograms([], [school('python', '09.03.01', 1)]);

		expect(result).toEqual({
			universityGroups: [],
			matches: [],
			universityOutside: 0,
			schoolWithoutCode: 0
		});
	});
});
