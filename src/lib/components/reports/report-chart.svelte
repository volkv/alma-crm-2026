<script lang="ts">
	import type { Chart as ChartInstance } from 'chart.js';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button/index.js';
	import { theme } from '$lib/theme.svelte';
	import {
		chartConfiguration,
		horizontalHeight,
		loadChart,
		screenPalette,
		type ChartSeries
	} from './chart-config';
	import { downloadChartPdf, downloadChartPng, renderChartSheet } from './chart-file';

	/**
	 * Диаграмма отчёта.
	 *
	 * Chart.js подключается динамически и только на клиенте: библиотека рисует в
	 * `canvas`, поэтому растр для PNG и PDF получается вызовом холста — без
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
		context,
		fileName,
		summary,
		onselect
	}: {
		labels: readonly string[];
		/** Серия: ключ (он выбирает цвет), подпись и значения по категориям. */
		datasets: readonly ChartSeries[];
		horizontal?: boolean;
		stacked?: boolean;
		title: string;
		note: string;
		/** Условия выборки для шапки выгруженного файла: период, отбор, доступ. */
		context: readonly string[];
		/** Основа имени файла: расширение дописывают кнопки. */
		fileName: string;
		/** Пересказ чисел словами: `canvas` для чтения с экрана недоступен. */
		summary: string;
		/** Клик по столбцу: сужает выборку тем же адресом, что и фильтр. */
		onselect?: (index: number) => void;
	} = $props();

	/**
	 * Столбцы списком под диаграммой — для клавиатуры и чтения с экрана.
	 *
	 * Диаграмма нарисована на холсте: столбца в разметке нет, поэтому выбрать его
	 * можно было бы только мышью — ни фокуса, ни `Enter`. Список даёт то же самое
	 * действие кнопкой на каждый столбец. Глазу он не нужен — подписи оси и числа
	 * на холсте говорят то же самое, — поэтому скрыт и появляется, только когда
	 * фокус попадает внутрь.
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

	/**
	 * Высота холста. Горизонтальные полосы — от числа строк: воронка из трёх
	 * стадий и из двенадцати не должны быть одной высоты с полосами разной
	 * толщины.
	 */
	const height = $derived(horizontal ? horizontalHeight(labels.length) : 256);

	/**
	 * Цвета — из токенов темы. Тема приходит аргументом и в самой работе не
	 * участвует: смена темы меняет значения всех токенов разом, и без этой
	 * зависимости тёмная диаграмма осталась бы со светлой сеткой и подписями.
	 */
	const palette = $derived.by(() => {
		void theme.resolved;

		return screenPalette(datasets);
	});

	$effect(() => {
		const element = canvas;

		if (element === null) {
			return;
		}

		const configuration = chartConfiguration({
			labels,
			datasets,
			horizontal,
			stacked,
			palette,
			fontFamily: getComputedStyle(element).fontFamily,
			legend: datasets.length > 1,
			onselect
		});

		let disposed = false;
		let instance: ChartInstance | null = null;

		void (async () => {
			const Chart = await loadChart();

			if (disposed) {
				return;
			}

			instance = new Chart(element, configuration);
			element.chart = instance;
		})();

		return () => {
			disposed = true;
			instance?.destroy();
			delete element.chart;
		};
	});

	let saving = $state(false);

	async function save(kind: 'png' | 'pdf') {
		if (canvas === null) {
			return;
		}

		saving = true;

		try {
			const sheet = await renderChartSheet({
				title,
				context,
				labels,
				datasets,
				horizontal,
				stacked,
				fontFamily: getComputedStyle(canvas).fontFamily
			});

			if (kind === 'png') {
				downloadChartPng(sheet, `${fileName}.png`);
			} else {
				downloadChartPdf(sheet, `${fileName}.pdf`);
			}
		} finally {
			saving = false;
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
			<Button
				variant="outline"
				size="xs"
				disabled={saving}
				onclick={() => void save('png')}
				data-testid="chart-png"
			>
				<DownloadIcon aria-hidden="true" />
				PNG
			</Button>
			<Button
				variant="outline"
				size="xs"
				disabled={saving}
				onclick={() => void save('pdf')}
				data-testid="chart-pdf"
			>
				<DownloadIcon aria-hidden="true" />
				PDF
			</Button>
		</div>
	</header>

	<div style:height="{height}px" role="img" aria-label="{title}. {summary}">
		<canvas bind:this={canvas} data-testid="report-chart-canvas"></canvas>
	</div>

	{#if onselect}
		<!-- Тот же переход, что и по клику на столбец: с клавиатуры до холста не
			добраться, а отбор по стадии — не украшение диаграммы, а работа. Глазом
			список виден, только пока фокус внутри него. -->
		<div
			class="sr-only flex-wrap items-center gap-1.5 focus-within:not-sr-only focus-within:mt-3 focus-within:flex"
		>
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
