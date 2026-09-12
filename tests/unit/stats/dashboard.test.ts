/**
 * Плитки дашборда и доля охвата.
 *
 * Проверяется одно обещание раздела: ноль и отсутствие данных — разные ответы.
 * «Ноль заявок» это результат, «нет данных» — незаполненная колонка, и плитка
 * обязана различать их до того, как число попадёт на экран и в выгрузку: обе
 * собираются одной и той же функцией.
 */
import { describe, expect, it } from 'vitest';
import {
	coverageShare,
	statDashboardTiles,
	statProgramGroupOf,
	STAT_DASHBOARD_TILE_KEYS,
	type StatDashboardTileKey,
	type StatDashboardTotals
} from '$lib/contracts/stats';

const EMPTY: StatDashboardTotals = {
	programCount: 0,
	organizationCount: 0,
	siteCount: 0,
	applications: null,
	enrolled: null,
	parallelStreams: null,
	completed: null,
	coveragePlan: null,
	coverageFact: null
};

function tile(totals: StatDashboardTotals, key: StatDashboardTileKey) {
	const found = statDashboardTiles(totals).find((candidate) => candidate.key === key);

	if (found === undefined) {
		throw new Error(`Плитки «${key}» нет среди плиток дашборда`);
	}

	return found;
}

describe('плитки дашборда', () => {
	it('показывают все объявленные плитки в объявленном порядке', () => {
		expect(statDashboardTiles(EMPTY).map((item) => item.key)).toStrictEqual([
			...STAT_DASHBOARD_TILE_KEYS
		]);
	});

	it('различает записанный ноль и отсутствие данных', () => {
		const zero = tile({ ...EMPTY, applications: 0 }, 'applications');
		const missing = tile(EMPTY, 'applications');

		// Ноль остаётся нулём, отсутствие данных — `null`: подставить вместо
		// него ноль значит придумать результат, которого в выгрузке не было.
		expect(zero.value).toBe(0);
		expect(missing.value).toBeNull();
	});

	it('не превращает отсутствие данных в ноль ни в одной плитке', () => {
		for (const item of statDashboardTiles(EMPTY)) {
			// Счётчики записей — это всегда число: ноль программ означает, что
			// программ нет. Показатели без данных остаются прочерком.
			const counter = item.key === 'programs' || item.key === 'organizations';

			expect(item.value === null).toBe(!counter);
		}
	});

	it('считает завершивших обучение отдельно от зачисленных', () => {
		const item = tile({ ...EMPTY, enrolled: 40, completed: null }, 'enrolled');

		expect(item.value).toBe(40);
		expect(item.extra).toStrictEqual([{ label: 'завершили обучение', value: null }]);
	});
});

describe('доля охвата', () => {
	it('считает факт от плана в процентах', () => {
		expect(coverageShare(200, 150)).toBe(75);
		expect(tile({ ...EMPTY, coveragePlan: 200, coverageFact: 150 }, 'coverage').value).toBe(75);
	});

	it('не считает долю без одного из чисел', () => {
		expect(coverageShare(null, 150)).toBeNull();
		expect(coverageShare(200, null)).toBeNull();
	});

	it('не считает долю от нулевого плана: она не определена, а не равна нулю', () => {
		expect(coverageShare(0, 0)).toBeNull();
		expect(coverageShare(0, 5)).toBeNull();
	});

	it('отличает нулевой факт от отсутствия факта', () => {
		expect(coverageShare(200, 0)).toBe(0);
		expect(coverageShare(200, null)).toBeNull();
	});
});

describe('группы программ', () => {
	it('сводит вузовские уровни в одну группу', () => {
		expect(statProgramGroupOf('bachelor')).toBe('university');
		expect(statProgramGroupOf('master')).toBe('university');
		expect(statProgramGroupOf('specialist')).toBe('university');
	});

	it('держит школьные программы отдельно от вузовских', () => {
		expect(statProgramGroupOf('school')).toBe('school');
		expect(statProgramGroupOf('spo')).toBe('vocational');
		expect(statProgramGroupOf('dpo')).toBe('professional');
	});
});
