/**
 * Серии диаграмм и разрезов.
 *
 * Здесь проверяется то, что от базы не зависит: ось времени и правило двойного
 * счёта. Ошибка в них не падает и не видна на глаз — она просто показывает
 * другую картинку.
 */
import { describe, expect, it } from 'vitest';
import { buildBreakdown, buildFunnel, buildMovementChart } from '$lib/server/reports/charts';

describe('ось времени динамики переходов', () => {
	it('до трёх месяцев считает по неделям с понедельника', () => {
		const chart = buildMovementChart('2026-10-01', '2026-12-31', [], 0);

		expect(chart.step).toBe('week');
		// 01.10.2026 — четверг: столбец начинается с понедельника 28.09.
		expect(chart.buckets[0]).toStrictEqual({
			key: '2026-09-28',
			label: '28.09',
			from: '2026-09-28',
			to: '2026-10-04'
		});
		expect(chart.buckets.at(-1)?.from).toBe('2026-12-28');
	});

	it('за большим периодом переходит на месяцы', () => {
		const chart = buildMovementChart('2026-01-01', '2026-12-31', [], 0);

		expect(chart.step).toBe('month');
		expect(chart.buckets.length).toBe(12);
		expect(chart.buckets[0]).toStrictEqual({
			key: '2026-01-01',
			label: '01.2026',
			from: '2026-01-01',
			to: '2026-01-31'
		});
	});

	it('раскладывает события по столбцам и видам', () => {
		// События приезжают уже сосчитанными по дням: их группирует база, а ось
		// времени раскладывает группы по неделям.
		const chart = buildMovementChart(
			'2026-10-01',
			'2026-10-14',
			[
				{ kind: 'forward', day: '2026-10-02', count: 1 },
				{ kind: 'forward', day: '2026-10-06', count: 1 },
				{ kind: 'return', day: '2026-10-06', count: 1 }
			],
			2
		);

		const forward = chart.series.find((series) => series.key === 'forward');
		const back = chart.series.find((series) => series.key === 'return');

		expect(forward?.values).toStrictEqual([1, 1, 0]);
		expect(back?.values).toStrictEqual([0, 1, 0]);
		// Перенос при изменении процесса в серии не входит и не прячется.
		expect(chart.migrated).toBe(2);
	});

	it('оставляет столбцы с нулями: пустая неделя — это ответ', () => {
		const chart = buildMovementChart('2026-10-01', '2026-10-21', [], 0);

		expect(chart.buckets.length).toBe(4);
		expect(chart.series.every((series) => series.values.every((value) => value === 0))).toBe(true);
	});
});

describe('разрез по многозначному признаку', () => {
	it('считает запись в каждой её строке и называет число таких записей', () => {
		const breakdown = buildBreakdown('products', 'По продуктам', 'prod', [
			{ ids: ['a', 'b'], names: ['П-1', 'П-1б'] },
			{ ids: ['a'], names: ['П-1'] },
			{ ids: ['c'], names: ['П-2'] }
		]);

		const sum = breakdown.points.reduce((total, point) => total + point.value, 0);

		expect(sum).toBe(4);
		expect(breakdown.doubleCounted).toBe(1);
		expect(breakdown.points[0]).toStrictEqual({
			key: 'a',
			label: 'П-1',
			value: 2,
			filter: { param: 'prod', value: 'a' }
		});
	});

	it('не считает одно и то же значение строки дважды', () => {
		const breakdown = buildBreakdown('owners', 'По ответственным', 'owner', [
			{ ids: ['u', 'u'], names: ['Иванов', 'Иванов'] }
		]);

		expect(breakdown.points).toStrictEqual([
			{ key: 'u', label: 'Иванов', value: 1, filter: { param: 'owner', value: 'u' } }
		]);
		expect(breakdown.doubleCounted).toBe(0);
	});

	it('строку без значений признака не приписывает никому', () => {
		const breakdown = buildBreakdown('directions', 'По направлениям', 'dir', [
			{ ids: [], names: [] },
			{ ids: ['d'], names: ['DevOps'] }
		]);

		expect(breakdown.points).toStrictEqual([
			{ key: 'd', label: 'DevOps', value: 1, filter: { param: 'dir', value: 'd' } }
		]);
	});
});

describe('воронка', () => {
	it('держит закрытые отдельным блоком и говорит, что это не конверсия', () => {
		const funnel = buildFunnel([{ key: 'g:contact', label: 'Контакты', value: 3, filter: null }], {
			completed: 2,
			cancelled: 1
		});

		expect(funnel.closed.map((bucket) => bucket.value)).toStrictEqual([2, 1]);
		expect(funnel.note).toContain('не конверсия');
	});
});
