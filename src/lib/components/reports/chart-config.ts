/**
 * Настройка диаграммы отчёта: цвета и конфигурация Chart.js.
 *
 * Одна и та же сборка служит и экрану, и выгрузке. Различаются только цвета:
 * экран берёт токены своей темы, файл — светлый лист, в какой бы теме его ни
 * выгрузили. Всё остальное — толщина полос, подписи, шрифт — общее, поэтому
 * картинка в файле совпадает с той, что на экране.
 */
import type { Chart, ChartConfiguration } from 'chart.js';
import type { ReportEventKind } from '$lib/contracts/reports';
import { valueLabelsPlugin } from './value-labels';

/**
 * Ключ серии. Виды событий движения — по одному цвету на вид; `count` —
 * одиночная серия распределения по стадиям.
 */
export type ChartSeriesKey = ReportEventKind | 'count';

/**
 * Серия → имя токена в `app.css`. Цвет принадлежит смыслу серии, а не её
 * месту в списке: «Возврат» остаётся синим, даже если соседних серий нет.
 * Одиночная серия берёт фиолетовый `forward` — цвет ссылок: полоса воронки и
 * есть ссылка на свои строки.
 */
const SERIES_TOKENS: Record<ChartSeriesKey, string> = {
	forward: 'forward',
	return: 'return',
	skip: 'skipped',
	started: 'started',
	completed: 'completed',
	cancelled: 'cancelled',
	count: 'forward'
};

export type ChartSeries = { key: ChartSeriesKey; label: string; values: readonly number[] };

export type ChartPalette = {
	/** Подпись значения у столбца. */
	label: string;
	/** Деления, легенда, подписи шапки файла. */
	axis: string;
	/** Сетка. */
	grid: string;
	/** Линия оси. */
	edge: string;
	/** Панель под диаграммой; ею же разделены куски стопки. */
	sheet: string;
	/** Заголовок в выгруженном файле. */
	ink: string;
	series: string[];
};

/**
 * Значение токена со страницы. Пустое значение — это переименованный или
 * удалённый токен, и Chart.js молча нарисовал бы такую серию прозрачной:
 * лучше громкая ошибка, чем картинка без серии.
 */
function readToken(styles: CSSStyleDeclaration, token: string): string {
	const value = styles.getPropertyValue(token).trim();

	if (value === '') {
		throw new Error(`Токен диаграммы ${token} не задан в теме`);
	}

	return value;
}

/** Цвета экрана — из токенов действующей темы. */
export function screenPalette(series: readonly { key: ChartSeriesKey }[]): ChartPalette {
	const styles = getComputedStyle(document.documentElement);

	return {
		label: readToken(styles, '--color-foreground'),
		axis: readToken(styles, '--color-muted-foreground'),
		grid: readToken(styles, '--color-border'),
		edge: readToken(styles, '--color-border-strong'),
		sheet: readToken(styles, '--color-surface'),
		ink: readToken(styles, '--color-foreground'),
		series: series.map((item) => readToken(styles, `--chart-${SERIES_TOKENS[item.key]}`))
	};
}

/**
 * Цвета файла: светлый лист и светлые ступени серий независимо от темы. Файл
 * вставляют в документ и печатают — тёмного фона там нет, а светлая подпись
 * на белом не читается.
 */
export function printPalette(series: readonly { key: ChartSeriesKey }[]): ChartPalette {
	const styles = getComputedStyle(document.documentElement);

	return {
		label: readToken(styles, '--chart-print-ink'),
		axis: readToken(styles, '--chart-print-muted'),
		grid: readToken(styles, '--chart-print-grid'),
		edge: readToken(styles, '--chart-print-edge'),
		sheet: readToken(styles, '--chart-print-sheet'),
		ink: readToken(styles, '--chart-print-ink'),
		series: series.map((item) => readToken(styles, `--chart-${SERIES_TOKENS[item.key]}-light`))
	};
}

/**
 * Шаг строки горизонтальной диаграммы: полоса 14 px и по 5 px воздуха. При 28
 * воронка из четырнадцати стадий не помещалась на экран 1366×768 вместе с
 * итогами — а ради этого её и перерисовывали.
 */
export const ROW_HEIGHT = 24;

/** Толщина полосы горизонтальной диаграммы. */
const BAR_THICKNESS = 14;

/** Под ось значений под полосами: деления и их отступ. */
const AXIS_HEIGHT = 28;

/** Кегль делений, легенды и подписей — тот же, что у мелкого текста экрана. */
const FONT_SIZE = 12;

/** Высота холста горизонтальной диаграммы: от числа строк, а не одна на все. */
export function horizontalHeight(rows: number): number {
	return Math.max(rows, 1) * ROW_HEIGHT + AXIS_HEIGHT;
}

export type ChartSetup = {
	labels: readonly string[];
	datasets: readonly ChartSeries[];
	horizontal: boolean;
	stacked: boolean;
	palette: ChartPalette;
	fontFamily: string;
	/** Легенда у одиночной серии на экране лишняя, в файле — нет. */
	legend: boolean;
	onselect?: (index: number) => void;
};

export function chartConfiguration(setup: ChartSetup): ChartConfiguration<'bar', number[], string> {
	const { horizontal, stacked, palette } = setup;
	const font = { family: setup.fontFamily, size: FONT_SIZE };

	// Куски стопки разделены линией цвета панели: без неё соседние серии
	// сливаются в один столбец, если их тона близки по светлоте.
	const separator = horizontal ? { right: 1 } : { top: 1 };

	return {
		type: 'bar',
		// Подписи значений рисует свой плагин — прямо на холсте, поэтому число
		// у столбца уезжает и в PNG, и в PDF диаграммы вместе с картинкой.
		plugins: [
			valueLabelsPlugin({
				stacked,
				horizontal,
				color: palette.label,
				fontFamily: setup.fontFamily
			})
		],
		data: {
			labels: [...setup.labels],
			datasets: setup.datasets.map((series, index) => ({
				label: series.label,
				data: [...series.values],
				backgroundColor: palette.series[index],
				borderColor: palette.sheet,
				borderWidth: stacked ? separator : 0,
				borderSkipped: stacked ? 'start' : false,
				borderRadius: stacked ? 0 : 4,
				...(horizontal ? { barThickness: BAR_THICKNESS } : { maxBarThickness: 28 })
			}))
		},
		options: {
			indexAxis: horizontal ? 'y' : 'x',
			responsive: true,
			maintainAspectRatio: false,
			// Умолчание Chart.js — серый `#666` на прозрачном: на тёмной панели
			// его не видно. Цвет текста диаграммы задаётся палитрой.
			color: palette.axis,
			font,
			// Двойная плотность: PNG диаграммы годится и для вставки в документ.
			devicePixelRatio: 2,
			animation: false,
			// Место под подпись значения: без запаса число у самого длинного
			// столбца обрезается краем холста.
			layout: { padding: horizontal ? { right: 40 } : { top: 20 } },
			plugins: {
				legend: {
					display: setup.legend,
					position: 'bottom',
					labels: { color: palette.axis, font, boxWidth: 12, boxHeight: 12, padding: 12 }
				},
				tooltip: { enabled: true, titleFont: font, bodyFont: font }
			},
			scales: {
				x: {
					stacked,
					ticks: { precision: 0, color: palette.axis, font },
					grid: { display: !horizontal, color: palette.grid },
					border: { color: palette.edge }
				},
				y: {
					stacked,
					ticks: { precision: 0, color: palette.axis, font },
					grid: { display: horizontal, color: palette.grid },
					border: { color: palette.edge }
				}
			},
			onClick: (_event, elements) => {
				if (elements.length > 0) {
					setup.onselect?.(elements[0].index);
				}
			}
		}
	};
}

/**
 * Chart.js подключается динамически и только в браузере: на сервере рисовать
 * нечем, а в общий бандл страницы библиотека не нужна.
 */
export async function loadChart(): Promise<typeof Chart> {
	const { Chart: ChartClass, registerables } = await import('chart.js');

	ChartClass.register(...registerables);

	return ChartClass;
}
