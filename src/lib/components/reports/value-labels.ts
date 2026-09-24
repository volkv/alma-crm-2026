/**
 * Подписи значений на диаграмме отчёта.
 *
 * Диаграмма без чисел заставляет мерить полосы глазом по сетке, а в PNG и PDF,
 * которые уносят в презентацию, сетки рядом с числом уже нет. Готовый пакет
 * подписей (`chartjs-plugin-datalabels`) ради этого не ставится: рисование
 * одного числа над столбцом — это два вызова холста, и своя реализация дешевле
 * зависимости, которую пришлось бы обновлять вместе с Chart.js.
 *
 * Подписи рисует сам холст (`afterDatasetsDraw`), поэтому они попадают и в
 * `toDataURL`: PNG и PDF диаграммы собираются из того же растра, что видит
 * человек, и ничего дорисовывать отдельно не приходится.
 *
 * Геометрия вынесена в чистую функцию: у Chart.js нет способа спросить «где
 * оказалась подпись», и проверить расстановку иначе, чем сравнением картинок,
 * было бы нечем.
 */
import type { Plugin } from 'chart.js';
import { formatNumber } from '$lib/format';

/** Положение столбца так, как его считает Chart.js: конец полосы и её середина. */
export type ValueLabelBar = { x: number; y: number };

/** Серия глазами подписи: значения, положения столбцов и видимость серии. */
export type ValueLabelSeries = {
	values: readonly (number | null)[];
	bars: readonly (ValueLabelBar | undefined)[];
	/** Серию можно выключить в легенде — выключенная в сумму не входит. */
	visible: boolean;
};

export type ValueLabelPoint = {
	text: string;
	x: number;
	y: number;
	align: CanvasTextAlign;
	baseline: CanvasTextBaseline;
};

export type ValueLabelLayout = {
	series: readonly ValueLabelSeries[];
	/** Столбцы с накоплением: подписывается сумма стопки, а не каждый кусок. */
	stacked: boolean;
	/** Полосы лежат вдоль оси X: подпись встаёт справа от конца полосы. */
	horizontal: boolean;
	/** Отступ подписи от конца столбца в точках экрана. */
	gap: number;
};

/**
 * Куда и что писать.
 *
 * У обычных столбцов подписывается каждый, у столбцов с накоплением — только
 * сумма стопки: шесть чисел внутри одного столбца нечитаемы, а сумма отвечает
 * на тот же вопрос «сколько». Ноль не подписывается: у него нет столбца, и
 * подпись висела бы в пустоте на оси.
 */
export function valueLabelPoints(layout: ValueLabelLayout): ValueLabelPoint[] {
	const visible = layout.series.filter((series) => series.visible);
	const categories = Math.max(0, ...visible.map((series) => series.bars.length));
	const points: ValueLabelPoint[] = [];

	for (let index = 0; index < categories; index += 1) {
		const drawn = visible
			.map((series) => ({ value: series.values[index] ?? 0, bar: series.bars[index] }))
			.filter((item): item is { value: number; bar: ValueLabelBar } => item.bar !== undefined);

		if (drawn.length === 0) {
			continue;
		}

		if (!layout.stacked) {
			for (const { value, bar } of drawn) {
				if (value !== 0) {
					points.push(pointFor(value, bar, layout));
				}
			}

			continue;
		}

		const total = drawn.reduce((sum, item) => sum + item.value, 0);

		if (total === 0) {
			continue;
		}

		// Вершина стопки: у вертикальных столбцов это наименьший `y` (ось
		// экрана растёт вниз), у горизонтальных — наибольший `x`.
		const top = layout.horizontal
			? drawn.reduce((best, item) => (item.bar.x > best.bar.x ? item : best))
			: drawn.reduce((best, item) => (item.bar.y < best.bar.y ? item : best));

		points.push(pointFor(total, top.bar, layout));
	}

	return points;
}

function pointFor(value: number, bar: ValueLabelBar, layout: ValueLabelLayout): ValueLabelPoint {
	return layout.horizontal
		? {
				text: formatNumber(value),
				x: bar.x + layout.gap,
				y: bar.y,
				align: 'left',
				baseline: 'middle'
			}
		: {
				text: formatNumber(value),
				x: bar.x,
				y: bar.y - layout.gap,
				align: 'center',
				baseline: 'bottom'
			};
}

/** Отступ подписи от столбца: меньше — подпись липнет, больше — отрывается. */
const LABEL_GAP = 6;

export type ValueLabelsOptions = {
	stacked: boolean;
	horizontal: boolean;
	/** Цвет подписи — из токена темы: `#hex` в компоненте недопустим. */
	color: string;
	/** Семейство шрифта страницы: у холста своего шрифта нет. */
	fontFamily: string;
};

/**
 * Плагин Chart.js, рисующий подписи. Подключается экземпляру диаграммы, а не
 * регистрируется глобально: подписи нужны диаграммам отчёта, а не всем, кто
 * когда-нибудь позовёт Chart.js.
 */
export function valueLabelsPlugin(options: ValueLabelsOptions): Plugin<'bar'> {
	return {
		id: 'reportValueLabels',
		afterDatasetsDraw(chart) {
			const series: ValueLabelSeries[] = chart.data.datasets.map((dataset, index) => ({
				// Точка набора у столбчатой диаграммы бывает и парой чисел (диапазон):
				// подписи такой формы нет, и она честно становится пропуском, а не
				// молча берётся за первое число пары.
				values: (dataset.data as readonly unknown[]).map((value) =>
					typeof value === 'number' ? value : null
				),
				bars: chart.getDatasetMeta(index).data as unknown as readonly ValueLabelBar[],
				visible: chart.isDatasetVisible(index)
			}));

			const points = valueLabelPoints({
				series,
				stacked: options.stacked,
				horizontal: options.horizontal,
				gap: LABEL_GAP
			});

			const { ctx } = chart;

			ctx.save();
			ctx.fillStyle = options.color;
			ctx.font = `600 12px ${options.fontFamily}`;

			for (const point of points) {
				ctx.textAlign = point.align;
				ctx.textBaseline = point.baseline;
				ctx.fillText(point.text, point.x, point.y);
			}

			ctx.restore();
		}
	};
}
