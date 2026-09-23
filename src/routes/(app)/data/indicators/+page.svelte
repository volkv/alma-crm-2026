<script lang="ts">
	import { resolve } from '$app/paths';
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import ChartNoAxesColumnIcon from '@lucide/svelte/icons/chart-no-axes-column';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button/index.js';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FilterSelect from '$lib/components/directory/filter-select.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import SectionTabs from '$lib/components/stats/section-tabs.svelte';
	import { measureText } from '$lib/components/stats/labels';
	import type { FieldOption } from '$lib/components/form/field-select.svelte';
	import {
		statPeriodKey,
		STAT_PERIOD_KIND_LABELS,
		type StatIndicatorRow
	} from '$lib/contracts/stats';
	import { formatDate, formatNumber } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const PERIOD_OPTIONS: readonly FieldOption[] = $derived(
		data.periods.map((period) => ({
			value: statPeriodKey(period),
			label: `${STAT_PERIOD_KIND_LABELS[period.kind]}: ${formatDate(period.start)} — ${formatDate(period.end)}`
		}))
	);

	const PROGRAM_OPTIONS: readonly FieldOption[] = $derived(
		data.filters.programs.map((program) => ({ value: program.id, label: program.label }))
	);

	const ORGANIZATION_OPTIONS: readonly FieldOption[] = $derived(
		data.filters.organizations.map((organization) => ({
			value: organization.id,
			label: organization.label
		}))
	);

	const columns: ColumnDef<DataTableFeatures, StatIndicatorRow>[] = [
		{
			id: 'program',
			accessorFn: (row) => row.programName,
			header: 'Программа',
			meta: { title: 'Программа' },
			enableSorting: false,
			enableHiding: false,
			cell: ({ row }) => renderSnippet(programCell, row.original)
		},
		{
			id: 'organization',
			accessorFn: (row) => row.organizationName,
			header: 'Организация',
			meta: { title: 'Организация' },
			enableSorting: false,
			cell: ({ row }) => row.original.organizationName
		},
		{
			id: 'period',
			header: 'Период',
			meta: { title: 'Период' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(periodCell, row.original)
		},
		{
			id: 'applications',
			header: 'Заявки',
			meta: { title: 'Заявки', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => measureText(row.original.applications)
		},
		{
			id: 'enrolled',
			header: 'Зачислено',
			meta: { title: 'Зачислено', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => measureText(row.original.enrolled)
		},
		{
			id: 'parallelStreams',
			header: 'Потоки',
			meta: { title: 'Потоки', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => measureText(row.original.parallelStreams)
		},
		{
			id: 'completed',
			header: 'Завершили',
			meta: { title: 'Завершили', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => measureText(row.original.completed)
		},
		{
			id: 'coveragePlan',
			header: 'Охват, план',
			meta: { title: 'Охват, план', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => measureText(row.original.coveragePlan)
		},
		{
			id: 'coverageFact',
			header: 'Охват, факт',
			meta: { title: 'Охват, факт', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => measureText(row.original.coverageFact)
		},
		{
			id: 'snapshotCount',
			header: 'Снимков',
			meta: { title: 'Снимков', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => formatNumber(row.original.snapshotCount)
		}
	];

	/** Выгрузка — про тот же период, что выбран здесь. */
	const periodKey = $derived(data.selected === null ? '' : statPeriodKey(data.selected));

	const exportHref = $derived(
		periodKey === '' ? undefined : `${resolve('/(app)/data/export')}?period=${periodKey}`
	);
</script>

{#snippet programCell(row: StatIndicatorRow)}
	<span class="flex min-w-0 flex-col">
		<span class="max-w-72 truncate font-medium" title={row.programName}>{row.programName}</span>
		<span class="text-xs text-muted-foreground">{row.programCode}</span>
	</span>
{/snippet}

{#snippet periodCell(row: StatIndicatorRow)}
	<span class="whitespace-nowrap">{formatDate(row.periodStart)} — {formatDate(row.periodEnd)}</span>
{/snippet}

<svelte:head><title>Показатели — LCT CRM</title></svelte:head>

<Header
	title="Показатели"
	description="Считаются по подтверждённым снимкам. Прочерк означает, что данных нет, ноль — что ноль записан в выгрузке."
>
	{#snippet actions()}
		<!-- Выгрузка всегда про один период: без выбора кнопка выключена, а
		     причина написана словами ниже, а не спрятана в подсказке мыши. -->
		<Button variant="outline" href={exportHref} disabled={data.selected === null}>
			<DownloadIcon aria-hidden="true" />
			Выгрузить отчёт (xlsx)
		</Button>
	{/snippet}
</Header>

<Breadcrumbs
	items={[{ label: 'Данные об обучении', href: resolve('/(app)/data') }, { label: 'Показатели' }]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<SectionTabs />

	{#if data.periods.length === 0}
		<div class="rounded-lg border border-border bg-surface shadow-xs">
			<EmptyState
				icon={ChartNoAxesColumnIcon}
				title="Показателей пока нет"
				description="Показатель появляется после того, как загруженный снимок подтвердили: до подтверждения числа остаются черновиком."
			>
				{#snippet action()}
					<Button href={resolve('/(app)/data')}>К снимкам данных</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-3" data-tour="data-indicators-filters">
			<FilterSelect param="period" label="Период" options={PERIOD_OPTIONS} allLabel="Все периоды" />
			<FilterSelect param="programId" label="Программа" options={PROGRAM_OPTIONS} />
			<FilterSelect param="organizationId" label="Организация" options={ORGANIZATION_OPTIONS} />
		</div>

		{#if data.selected === null}
			<p class="text-sm text-muted-foreground">
				Период не выбран: строки показаны как есть, по одной на период. Пересекающиеся периоды не
				складываются — одни и те же обучающиеся посчитались бы дважды. По той же причине выключена и
				выгрузка отчёта: она собирается по одному отчётному периоду.
			</p>
		{/if}

		<DataTable
			data-tour="data-indicators-table"
			{columns}
			rows={data.rows}
			total={data.total}
			getRowId={(row) => `${row.programId}-${row.organizationId}-${row.periodStart}`}
			emptyTitle="Под фильтр ничего не подошло"
			emptyDescription="Снимите фильтр или выберите другой период."
			initialHiddenColumns={['coveragePlan', 'coverageFact', 'snapshotCount']}
		/>
	{/if}
</div>
