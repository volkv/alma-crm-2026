<script lang="ts">
	import type { Chart as ChartInstance, ChartConfiguration } from 'chart.js';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button/index.js';
	import { downloadChartPdf, downloadChartPng } from './chart-file';
	import { valueLabelsPlugin } from './value-labels';

	/**
	 * Диаграмма отчёта.
	 *
	 * Chart.js подключается динамически и только на клиенте: библиотека рисует в
	 * `canvas`, поэтому растр для PNG и PDF получается одним вызовом холста — без
	 * сериализации SVG, подстановки шрифтов и внешних стилей. Экземпляр создаётся
	 * и уничтожается в `$effect`: при смене выборки диаграмма пересобирается, а
	 * не наслаивается на прежнюю.
	 *
	 * Сервер серии не рисует — он отдаёт числа тем же набором строк, из которого
	 * собрана таблица. Поэтому сумма столбцов и число строк совпадают по
	 * построению, а не по совпадению.
	 */
	let {
		labels,
		datasets,
		horizontal = false,
		stacked = false,
		title,
		note,
		fileName,
		summary,
		onselect
	}: {
		labels: readonly string[];
		/** Серия: подпись, значения по категориям и токен цвета из темы. */
		datasets: readonly { label: string; values: readonly number[]; token: string }[];
		horizontal?: boolean;
		stacked?: boolean;
		title: string;
		note: string;
		/** Основа имени файла: расширение дописывают кнопки. */
		fileName: string;
		/** Пересказ чисел словами: `canvas` для чтения с экрана недоступен. */
		summary: string;
		/** Клик по столбцу: сужает выборку тем же адресом, что и фильтр. */
		onselect?: (index: number) => void;
	} = $props();

	/**
	 * Столбцы списком под диаграммой.
	 *
	 * Диаграмма нарисована на холсте: столбца в разметке нет, поэтому выбрать его
	 * можно было только мышью — ни фокуса, ни `Enter`. Список даёт то же самое
	 * действие кнопкой на каждый столбец, и он же называет числа рядом с
	 * названиями, а не только внутри картинки.
	 */
	const columnTotals = $derived(
		labels.map((_, index) =>
			datasets.reduce((total, series) => total + (series.values[index] ?? 0), 0)
		)
	);

	/**
	 * Холст с экземпляром диаграммы на нём.
	 *
	 * `canvas` — растр: ни столбца, ни его границ в разметке нет, и добраться до
	 * геометрии можно только через сам экземпляр. Он кладётся на элемент, потому
	 * что элемент — единственное, что видно снаружи компонента; вторая версия
	 * Chart.js делала это сама, третья убрала свойство из своего API.
	 */
	type ChartCanvas = HTMLCanvasElement & { chart?: ChartInstance };

	let canvas = $state<ChartCanvas | null>(null);
	let chart = $state<ChartInstance | null>(null);

	/** Цвет серии — из токена темы: `#hex` в компоненте недопустим. */
	function themeColor(token: string): string {
		const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();

		// Токена может не оказаться только если его переименовали в теме: пустой
		// цвет Chart.js молча превратит в прозрачный, поэтому лучше видимый серый.
		return value === '' ? '#94a3b8' : value;
	}

	$effect(() => {
		const element = canvas;

		if (element === null) {
			return;
		}

		const configuration: ChartConfiguration<'bar', number[], string> = {
			type: 'bar',
			// Подписи значений рисует свой плагин — прямо на холсте, поэтому число
			// над столбцом уезжает и в PNG, и в PDF диаграммы вместе с картинкой.
			plugins: [
				valueLabelsPlugin({
					stacked,
					horizontal,
					color: themeColor('--color-foreground'),
					fontFamily: getComputedStyle(element).fontFamily
				})
			],
			data: {
				labels: [...labels],
				datasets: datasets.map((series) => ({
					label: series.label,
					data: [...series.values],
					backgroundColor: themeColor(series.token),
					borderWidth: 0,
					borderRadius: 2,
					maxBarThickness: 28
				}))
			},
			options: {
				indexAxis: horizontal ? 'y' : 'x',
				responsive: true,
				maintainAspectRatio: false,
				// Двойная плотность: PNG диаграммы годится и для вставки в документ.
				devicePixelRatio: 2,
				animation: false,
				// Место под подпись значения: без запаса число у самого длинного
				// столбца обрезается краем холста.
				layout: { padding: horizontal ? { right: 32 } : { top: 18 } },
				plugins: {
					legend: { display: datasets.length > 1, position: 'bottom' },
					tooltip: { enabled: true }
				},
				scales: {
					x: { stacked, ticks: { precision: 0 }, grid: { display: !horizontal } },
					y: { stacked, ticks: { precision: 0 }, grid: { display: horizontal } }
				},
				onClick: (_event, elements) => {
					if (elements.length > 0) {
						onselect?.(elements[0].index);
					}
				}
			}
		};

		let disposed = false;
		let instance: ChartInstance | null = null;

		void (async () => {
			const { Chart, registerables } = await import('chart.js');

			if (disposed) {
				return;
			}

			Chart.register(...registerables);
			instance = new Chart(element, configuration);
			element.chart = instance;
			chart = instance;
		})();

		return () => {
			disposed = true;
			instance?.destroy();
			delete element.chart;
			chart = null;
		};
	});

	function save(kind: 'png' | 'pdf') {
		const element = chart?.canvas ?? canvas;

		if (element === null || element === undefined) {
			return;
		}

		if (kind === 'png') {
			downloadChartPng(element, `${fileName}.png`);
		} else {
			downloadChartPdf(element, `${fileName}.pdf`);
		}
	}
</script>

<section class="rounded-lg border border-border bg-surface p-4 shadow-xs" data-slot="report-chart">
	<header class="mb-3 flex flex-wrap items-start justify-between gap-2">
		<div class="min-w-0">
			<h2 class="text-sm font-semibold">{title}</h2>
			<p class="mt-0.5 text-xs text-muted-foreground">{note}</p>
		</div>
		<div class="flex shrink-0 gap-1.5">
			<Button variant="outline" size="xs" onclick={() => save('png')} data-testid="chart-png">
				<DownloadIcon aria-hidden="true" />
				PNG
			</Button>
			<Button variant="outline" size="xs" onclick={() => save('pdf')} data-testid="chart-pdf">
				<DownloadIcon aria-hidden="true" />
				PDF
			</Button>
		</div>
	</header>

	<div class="h-72" role="img" aria-label="{title}. {summary}">
		<canvas bind:this={canvas} data-testid="report-chart-canvas"></canvas>
	</div>

	{#if onselect}
		<!-- Тот же переход, что и по клику на столбец: с клавиатуры до холста не
			добраться, а отбор по стадии — не украшение диаграммы, а работа. -->
		<div class="mt-3 flex flex-wrap items-center gap-1.5">
			<span class="text-xs text-muted-foreground">Отобрать по столбцу:</span>
			{#each labels as label, index (label)}
				<button
					type="button"
					class="inline-flex items-center gap-1 rounded-4xl border border-border px-2 py-0.5 text-xs focus-ring hover:bg-surface-muted"
					aria-label="столбец: {label}, {columnTotals[index]}"
					data-testid="chart-column"
					onclick={() => onselect?.(index)}
				>
					<span>{label}</span>
					<span class="font-medium text-muted-foreground">{columnTotals[index]}</span>
				</button>
			{/each}
		</div>
	{/if}
</section>
