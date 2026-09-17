<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button/index.js';
	import PageHeader from '$lib/components/page-header.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import BreakdownCard from '$lib/components/reports/breakdown-card.svelte';
	import FilterBar from '$lib/components/reports/filter-bar.svelte';
	import ReportChart from '$lib/components/reports/report-chart.svelte';
	import ReportTable from '$lib/components/reports/report-table.svelte';
	import {
		exportHref,
		interactionsHref,
		modeHref,
		pageHref,
		reportHref,
		toggledHref,
		unsupportedListFilters
	} from '$lib/components/reports/query';
	import {
		REPORT_FORMATS,
		REPORT_FORMAT_LABELS,
		REPORT_MODES,
		REPORT_MODE_LABELS,
		type ReportParam
	} from '$lib/contracts/reports';
	import { formatNumber, pluralize } from '$lib/format';
	import { cn } from '$lib/utils';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const selectedColumns = $derived(data.meta.columns.map((column) => column.key));

	const isFiltered = $derived(
		data.meta.filters.some((filter) => filter.label !== 'Режим' && filter.label !== 'Период')
	);

	const first = $derived(data.totals.rowCount === 0 ? 0 : (data.page - 1) * data.pageSize + 1);
	const last = $derived(Math.min(data.page * data.pageSize, data.totals.rowCount));

	const droppedByList = $derived(unsupportedListFilters(page.url));

	const funnelSummary = $derived(
		data.charts.funnel === null
			? ''
			: data.charts.funnel.stages
					.filter((bucket) => bucket.value > 0)
					.map((bucket) => `${bucket.label}: ${bucket.value}`)
					.join('; ') || 'на стадиях никого'
	);

	const movementSummary = $derived(
		data.charts.movement === null
			? ''
			: data.charts.movement.series
					.map(
						(series) => `${series.label}: ${series.values.reduce((sum, value) => sum + value, 0)}`
					)
					.join('; ')
	);

	/** Токены серий: шесть видов событий — шесть цветов темы. */
	const SERIES_TOKENS = [
		'--color-primary',
		'--color-info',
		'--color-warning',
		'--color-danger',
		'--color-success',
		'--color-faint'
	];

	const breakdownParams: Record<string, ReportParam> = {
		organizations: 'org',
		directions: 'dir',
		products: 'prod',
		owners: 'owner'
	};

	function selectStage(index: number) {
		const bucket = data.charts.funnel?.stages[index];

		if (bucket?.filter !== null && bucket?.filter !== undefined) {
			void goto(toggledHref(page.url, bucket.filter.param as ReportParam, bucket.filter.value), {
				keepFocus: true,
				noScroll: true
			});
		}
	}

	function selectBucket(index: number) {
		const bucket = data.charts.movement?.buckets[index];

		if (bucket !== undefined) {
			// Клик по столбцу сужает период до его интервала: это фильтр того же
			// отчёта, а не переход в список — список показывает текущую стадию, и
			// числа не сошлись бы.
			void goto(reportHref(page.url, { from: bucket.from, to: bucket.to }), {
				keepFocus: true,
				noScroll: true
			});
		}
	}
</script>

<PageHeader
	title="Отчёты по взаимодействиям"
	description="Где работа стоит на дату и что за период произошло. Числа экрана, диаграмм и файлов — одни и те же."
	breadcrumbs={[{ label: 'Главная', href: resolve('/') }]}
>
	{#snippet actions()}
		{#each REPORT_FORMATS as format (format)}
			<Button
				variant="outline"
				size="sm"
				href={exportHref(page.url, format)}
				data-sveltekit-reload
				data-testid="report-export-{format}"
			>
				<DownloadIcon aria-hidden="true" />
				{REPORT_FORMAT_LABELS[format]}
			</Button>
		{/each}
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-4">
	<nav class="-mx-1 overflow-x-auto px-1 py-0.5" aria-label="Режим отчёта">
		<div class="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-[3px]">
			{#each REPORT_MODES as mode (mode)}
				<a
					href={modeHref(page.url, mode)}
					aria-current={data.meta.mode === mode ? 'page' : undefined}
					data-testid="report-mode-{mode}"
					class={cn(
						'inline-flex items-center rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap text-muted-foreground focus-ring hover:text-foreground',
						data.meta.mode === mode && 'bg-surface text-foreground shadow-xs'
					)}
				>
					{REPORT_MODE_LABELS[mode]}
				</a>
			{/each}
		</div>
	</nav>

	<InlineHint tone="info">{data.meta.semantics}</InlineHint>

	<FilterBar
		query={data.query}
		options={data.options}
		available={data.available}
		{selectedColumns}
		{isFiltered}
	/>

	<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
		<div class="flex flex-col rounded-lg border border-border bg-surface px-3 py-3">
			<span class="text-xs text-muted-foreground">
				{data.meta.mode === 'snapshot' ? 'Взаимодействий' : 'Событий'}
			</span>
			<span class="mt-1 text-2xl leading-none font-semibold" data-testid="report-row-count">
				{formatNumber(data.totals.rowCount)}
			</span>
			<span class="mt-1 text-xs text-faint">строк в отчёте</span>
		</div>
		<div class="flex flex-col rounded-lg border border-border bg-surface px-3 py-3">
			<span class="text-xs text-muted-foreground">Взаимодействий в выборке</span>
			<span class="mt-1 text-2xl leading-none font-semibold">
				{formatNumber(data.totals.interactionCount)}
			</span>
			<span class="mt-1 text-xs text-faint">
				{data.meta.mode === 'snapshot' ? 'по одному на строку' : 'одно даёт несколько событий'}
			</span>
		</div>
		{#if data.meta.mode === 'snapshot'}
			<div class="flex flex-col rounded-lg border border-border bg-surface px-3 py-3">
				<span class="text-xs text-muted-foreground">На паузе</span>
				<span class="mt-1 text-2xl leading-none font-semibold">
					{formatNumber(data.totals.paused)}
				</span>
				<span class="mt-1 text-xs text-faint">часы норматива стоят</span>
			</div>
			<div class="flex flex-col rounded-lg border border-border bg-surface px-3 py-3">
				<span class="text-xs text-muted-foreground">Просрочено</span>
				<span class="mt-1 text-2xl leading-none font-semibold">
					{formatNumber(data.totals.overdue)}
				</span>
				<span class="mt-1 text-xs text-faint">на момент среза</span>
			</div>
		{:else}
			<div class="flex flex-col rounded-lg border border-border bg-surface px-3 py-3">
				<span class="text-xs text-muted-foreground">Перенос при изменении процесса</span>
				<span class="mt-1 text-2xl leading-none font-semibold">
					{formatNumber(data.charts.movement?.migrated ?? 0)}
				</span>
				<span class="mt-1 text-xs text-faint">переходом не считается</span>
			</div>
		{/if}
	</div>

	{#if data.charts.funnel !== null}
		{@const funnel = data.charts.funnel}
		<ReportChart
			title="Распределение по стадиям на дату среза"
			note={funnel.note}
			fileName="Отчёт по взаимодействиям — воронка"
			summary={funnelSummary}
			labels={funnel.stages.map((bucket) => bucket.label)}
			datasets={[
				{
					label: 'Взаимодействий',
					values: funnel.stages.map((bucket) => bucket.value),
					token: '--color-primary'
				}
			]}
			horizontal
			onselect={selectStage}
		/>
		<p class="text-xs text-muted-foreground">
			Вне воронки:
			{#each funnel.closed as bucket, index (bucket.key)}
				{index > 0 ? ', ' : ' '}{bucket.label} — {formatNumber(bucket.value)}
			{/each}
		</p>
	{/if}

	{#if data.charts.movement !== null}
		{@const movement = data.charts.movement}
		<ReportChart
			title="Динамика переходов"
			note={movement.note}
			fileName="Отчёт по взаимодействиям — динамика"
			summary={movementSummary}
			labels={movement.buckets.map((bucket) => bucket.label)}
			datasets={movement.series.map((series, index) => ({
				label: series.label,
				values: series.values,
				token: SERIES_TOKENS[index % SERIES_TOKENS.length]
			}))}
			stacked
			onselect={selectBucket}
		/>
		<p class="text-xs text-muted-foreground">
			Переносов при изменении процесса за период: {formatNumber(movement.migrated)} — в серии они не входят.
		</p>
	{/if}

	<ReportTable columns={data.meta.columns} rows={data.rows} {isFiltered} />

	{#if data.totals.rowCount > 0}
		<div class="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
			<span>{first}–{last} из {formatNumber(data.totals.rowCount)}</span>
			<div class="flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={data.page <= 1}
					href={pageHref(page.url, data.page - 1)}
				>
					Назад
				</Button>
				<span>Страница {data.page} из {data.pages}</span>
				<Button
					variant="outline"
					size="sm"
					disabled={data.page >= data.pages}
					href={pageHref(page.url, data.page + 1)}
				>
					Вперёд
				</Button>
			</div>
		</div>
	{/if}

	<div class="flex flex-col gap-1">
		<a class="text-sm text-primary focus-ring" href={interactionsHref(page.url)}>
			Открыть эти взаимодействия в списке
		</a>
		{#if droppedByList.length > 0}
			<InlineHint tone="warning">
				Список взаимодействий понимает не все фильтры отчёта: {droppedByList.join(', ')} — он не переносит.
				Числа списка и отчёта на такой ссылке не совпадут.
			</InlineHint>
		{/if}
	</div>

	<div class="grid gap-3 md:grid-cols-2">
		{#each data.charts.breakdowns as breakdown (breakdown.key)}
			<BreakdownCard
				{breakdown}
				param={breakdownParams[breakdown.key]}
				rowCount={data.totals.rowCount}
			/>
		{/each}
	</div>

	<p class="text-xs text-faint">
		Область доступа: {data.meta.scope}. Колонки с пометкой «на дату» считаются на момент среза и
		после публикации изменённого процесса не меняются; с пометкой «сейчас» — описывают запись
		сегодня. Всего колонок в наборе: {pluralize(data.meta.columns.length, [
			'колонка',
			'колонки',
			'колонок'
		])}.
	</p>
</div>
