<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help';
	import { Button } from '$lib/components/ui/button/index.js';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import BreakdownCard from '$lib/components/reports/breakdown-card.svelte';
	import ExportMenu from '$lib/components/reports/export-menu.svelte';
	import FilterBar from '$lib/components/reports/filter-bar.svelte';
	import ReportChart from '$lib/components/reports/report-chart.svelte';
	import ReportTable from '$lib/components/reports/report-table.svelte';
	import {
		interactionsHref,
		modeHref,
		movementDrilldownHref,
		pageHref,
		stageDrilldownHref,
		unsupportedListFilters
	} from '$lib/components/reports/query';
	import {
		REPORT_MODES,
		REPORT_MODE_LABELS,
		type ReportFunnelWorkspace,
		type ReportParam
	} from '$lib/contracts/reports';
	import { formatDate, formatDateTime, formatNumber, pluralize } from '$lib/format';
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

	/**
	 * Методология — по кнопке. Правило подсчёта и моменты фильтров стояли над
	 * отбором тремя абзацами и отодвигали результат за первый экран; тот, кто
	 * проверяет число, раскроет их, а тот, кто смотрит, — нет. Выбор живёт в
	 * компоненте: смена режима и фильтров его не сбрасывает.
	 */
	let methodOpen = $state(false);

	/**
	 * Условия выборки для шапки выгруженной диаграммы: картинка в чужом
	 * документе должна сама говорить, за какой период и по какому отбору она.
	 */
	const chartContext = $derived.by(() => {
		const base = data.meta.filters.filter(
			(filter) => filter.label === 'Режим' || filter.label === 'Период'
		);
		const narrowing = data.meta.filters.filter(
			(filter) => filter.label !== 'Режим' && filter.label !== 'Период'
		);

		return [
			base.map((filter) => `${filter.label}: ${filter.value}`).join(' · '),
			narrowing.length === 0
				? 'Отбор: без фильтров'
				: `Отбор: ${narrowing.map((filter) => `${filter.label} — ${filter.value}`).join('; ')}`,
			`Область доступа: ${data.meta.scope}. Собран ${formatDateTime(data.meta.generatedAt)}, отчёт ${data.meta.reportId}`
		];
	});

	/** Пересказ воронки словами: `canvas` для чтения с экрана недоступен. */
	function funnelSummary(workspace: ReportFunnelWorkspace): string {
		return (
			workspace.stages
				.filter((bucket) => bucket.value > 0)
				.map((bucket) => `${bucket.label}: ${bucket.value}`)
				.join('; ') || 'на стадиях никого'
		);
	}

	const movementSummary = $derived(
		data.charts.movement === null
			? ''
			: data.charts.movement.series
					.map(
						(series) => `${series.label}: ${series.values.reduce((sum, value) => sum + value, 0)}`
					)
					.join('; ')
	);

	const breakdownParams: Record<string, ReportParam> = {
		organizations: 'org',
		directions: 'dir',
		products: 'prod',
		owners: 'owner'
	};

	/** Режим и период выписываются в ссылку явно: «сегодня» завтра другое. */
	const period = $derived({
		mode: data.meta.mode,
		from: data.meta.period.start,
		to: data.meta.period.end
	});

	/**
	 * Клик по полосе воронки ведёт к списку взаимодействий, которые за ней
	 * стоят, — к таблице этого же отчёта под диаграммой: только она считает
	 * стадию на дату среза так же, как воронка, и число её строк равно числу на
	 * полосе. В адрес уезжают пространство и ключ стадии, остальные фильтры
	 * остаются — полоса нарисована под ними же.
	 */
	function selectStage(workspace: ReportFunnelWorkspace, index: number) {
		const bucket = workspace.stages[index];

		if (bucket?.filter != null) {
			void goto(stageDrilldownHref(page.url, period, workspace.workspaceKey, bucket.filter.value), {
				keepFocus: true,
				noScroll: true
			});
		}
	}

	function selectBucket(index: number) {
		const bucket = data.charts.movement?.buckets[index];

		if (bucket !== undefined) {
			// Клик по столбцу сужает период до его интервала, не трогая остальные
			// фильтры: это те же события, показанные крупнее.
			void goto(movementDrilldownHref(page.url, data.meta.mode, bucket), {
				keepFocus: true,
				noScroll: true
			});
		}
	}
</script>

{#snippet tile(label: string, value: number, hint: string, testId?: string)}
	<div class="flex min-w-44 flex-1 flex-col rounded-lg border border-border bg-surface px-3 py-2">
		<span class="text-xs text-muted-foreground">{label}</span>
		<span class="mt-0.5 flex items-baseline gap-2">
			<span class="text-2xl leading-tight font-semibold" data-testid={testId}>
				{formatNumber(value)}
			</span>
			<span class="text-xs text-faint">{hint}</span>
		</span>
	</div>
{/snippet}

<Header
	title="Отчёты по взаимодействиям"
	description="Где работа стоит на дату и что за период произошло. Числа экрана, диаграмм и файлов — одни и те же."
>
	{#snippet actions()}
		<ExportMenu rowCount={data.totals.rowCount} />
	{/snippet}
</Header>

<Breadcrumbs
	items={[{ label: 'Главное', href: resolve('/') }, { label: 'Отчёты по взаимодействиям' }]}
/>

<!-- Поля страницы такие же, как у остальных разделов: без них полоса вкладок
	с отрицательным отступом выходила за край окна, а «Колонки» и «Сбросить
	фильтр» стояли вплотную к правому краю. -->
<div class="flex flex-col gap-3 p-4 sm:px-9 sm:py-6">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<nav
			class="-mx-1 overflow-x-auto px-1 py-0.5"
			aria-label="Режим отчёта"
			data-tour="reports-mode"
		>
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
		<Button
			variant="ghost"
			size="sm"
			aria-expanded={methodOpen}
			aria-controls="report-method"
			data-testid="report-method-toggle"
			onclick={() => (methodOpen = !methodOpen)}
		>
			<CircleHelpIcon aria-hidden="true" />
			Как считается
		</Button>
	</div>

	{#if methodOpen}
		<div id="report-method" class="flex flex-col gap-2">
			<InlineHint tone="info">{data.meta.semantics}</InlineHint>

			<!-- Какие фильтры смотрят на дату, а какие на сегодня: те же пометки стоят
			     у колонок, и фильтр с колонкой одного смысла читают одно значение. -->
			<p class="text-xs text-muted-foreground" data-testid="report-filter-moments">
				{#if data.meta.mode === 'snapshot'}
					Стадия, состояние, ответственный за вуз, просрочка и пауза — на {formatDate(
						data.meta.period.end
					)}. Просрочка считается по нормативу стадии, действовавшему в тот день: правка процесса её
					задним числом не меняет.
				{:else}
					Состояние и ответственный за вуз — на {formatDate(data.meta.period.end)}, конец периода;
					стадия — та, из которой или в которую перешли.
				{/if}
				Вуз, тип контрагента, направление, программа, продукт, ответственный и статус передачи — по текущим
				значениям записи.
			</p>
		</div>
	{/if}

	<FilterBar
		query={data.query}
		options={data.options}
		available={data.available}
		{selectedColumns}
		{isFiltered}
	/>

	<!-- `data-tour` — метка подсказок (`$lib/onboarding/screens`). -->
	<div class="flex flex-wrap gap-3" data-tour="reports-totals">
		{#if data.meta.mode === 'snapshot'}
			<!-- В срезе строка и есть взаимодействие: второе «взаимодействий в
			     выборке» повторило бы то же число. -->
			{@render tile('Взаимодействий', data.totals.rowCount, 'строк в отчёте', 'report-row-count')}
			{@render tile('На паузе', data.totals.paused, 'часы норматива стоят')}
			{@render tile('Просрочено', data.totals.overdue, 'на момент среза')}
		{:else}
			{@render tile('Событий', data.totals.rowCount, 'строк в отчёте', 'report-row-count')}
			{@render tile(
				'Взаимодействий в выборке',
				data.totals.interactionCount,
				'одно даёт несколько событий'
			)}
			{@render tile(
				'Перенос при изменении процесса',
				data.charts.movement?.migrated ?? 0,
				'переходом не считается'
			)}
		{/if}
	</div>

	{#if data.charts.funnel !== null}
		{@const funnel = data.charts.funnel}
		<!-- Воронка своя у каждого пространства: у B2B и B2C разные стадии, и
		     полосы двух процессов в одной картинке читались бы как один путь. -->
		{#each funnel.workspaces as workspace (workspace.workspaceId)}
			<ReportChart
				title={funnel.workspaces.length > 1
					? `Распределение по стадиям на дату среза — ${workspace.workspaceName}`
					: 'Распределение по стадиям на дату среза'}
				note={funnel.note}
				fileName="Отчёт по взаимодействиям — воронка {workspace.workspaceName}"
				summary={funnelSummary(workspace)}
				labels={workspace.stages.map((bucket) => bucket.label)}
				datasets={[
					{
						key: 'count',
						label: 'Взаимодействий',
						values: workspace.stages.map((bucket) => bucket.value)
					}
				]}
				context={chartContext}
				horizontal
				onselect={(index) => selectStage(workspace, index)}
			/>
		{/each}
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
			datasets={movement.series}
			context={chartContext}
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
		<a class="text-sm text-link focus-ring hover:text-link-hover" href={interactionsHref(page.url)}>
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

	<p class="text-xs text-faint" data-testid="report-identity">
		Собран {formatDateTime(data.meta.generatedAt)}: итоги, диаграммы и строки прочитаны из одного
		состояния базы. Выгрузка собирается заново и несёт в шапке свой идентификатор и момент сборки —
		те же, что в журнале действий.
	</p>

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
