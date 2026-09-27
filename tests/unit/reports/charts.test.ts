/**
 * Серии диаграмм и разрезов.
 *
 * Здесь проверяется то, что от базы не зависит: ось времени и правило двойного
 * счёта. Ошибка в них не падает и не видна на глаз — она просто показывает
 * другую картинку.
 */
import { describe, expect, it } from 'vitest';
import {
	buildBreakdown,
	buildFunnel,
	buildFunnelFromCounts,
	buildMovementChart
} from '$lib/server/reports/charts';
import { createStageIndex } from '$lib/server/reports/stages';
import { valueLabelPoints } from '$lib/components/reports/value-labels';

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

describe('воронка пространства', () => {
	/** Пространство отчёта: воронка строится по его процессу и только по нему. */
	function index() {
		return createStageIndex({
			id: 'g-b2b',
			key: 'b2b',
			name: 'Работа с вузами',
			stages: [
				{ key: 'contact', name: 'Контакты', position: 1 },
				{ key: 'meeting', name: 'Встреча', position: 2 }
			]
		});
	}

	it('показывает все стадии процесса по порядку, пустые — нулём', () => {
		const funnel = buildFunnelFromCounts(
			index(),
			[{ bucketId: 'g-b2b:meeting', stageName: 'Встреча', value: 3 }],
			{}
		);

		expect(funnel.stages.map((bucket) => [bucket.label, bucket.value])).toStrictEqual([
			['Контакты', 0],
			['Встреча', 3]
		]);
	});

	it('называет стадию без пространства: отчёт и так собран внутри одного', () => {
		const funnel = buildFunnelFromCounts(index(), [], {});

		expect(funnel.stages.map((bucket) => bucket.label)).toStrictEqual(['Контакты', 'Встреча']);
		expect(funnel.stages.every((bucket) => bucket.value === 0)).toBe(true);
	});

	it('удалённую из процесса стадию ставит в конец с пометкой', () => {
		const funnel = buildFunnelFromCounts(
			index(),
			[
				{ bucketId: 'g-b2b:contact', stageName: 'Контакты', value: 1 },
				{ bucketId: 'g-b2b:old', stageName: 'Прежняя стадия', value: 4 }
			],
			{}
		);

		expect(funnel.stages.at(-1)).toStrictEqual({
			key: 'g-b2b:old',
			label: 'Прежняя стадия (стадия удалена из процесса)',
			value: 4,
			filter: { param: 'stage', value: 'old' },
			retired: true
		});
	});
});

describe('подписи значений на диаграмме', () => {
	it('подписывает каждый столбец обычной диаграммы и пропускает нулевой', () => {
		const points = valueLabelPoints({
			stacked: false,
			horizontal: true,
			gap: 6,
			series: [
				{
					visible: true,
					values: [3, 0],
					bars: [
						{ x: 100, y: 10 },
						{ x: 0, y: 30 }
					]
				}
			]
		});

		// Ноль столбца не имеет: подпись висела бы в пустоте на оси.
		expect(points).toStrictEqual([{ text: '3', x: 106, y: 10, align: 'left', baseline: 'middle' }]);
	});

	it('у столбцов с накоплением подписывает сумму стопки над её вершиной', () => {
		const points = valueLabelPoints({
			stacked: true,
			horizontal: false,
			gap: 6,
			series: [
				{ visible: true, values: [2], bars: [{ x: 50, y: 80 }] },
				{ visible: true, values: [3], bars: [{ x: 50, y: 40 }] }
			]
		});

		expect(points).toStrictEqual([
			{ text: '5', x: 50, y: 34, align: 'center', baseline: 'bottom' }
		]);
	});

	it('выключенную в легенде серию в сумму не берёт', () => {
		const points = valueLabelPoints({
			stacked: true,
			horizontal: false,
			gap: 6,
			series: [
				{ visible: true, values: [2], bars: [{ x: 50, y: 80 }] },
				{ visible: false, values: [3], bars: [{ x: 50, y: 40 }] }
			]
		});

		expect(points.map((point) => point.text)).toStrictEqual(['2']);
	});
});
