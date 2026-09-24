<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { Button } from '$lib/components/ui/button/index.js';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FilterSelect from '$lib/components/directory/filter-select.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import SectionTabs from '$lib/components/stats/section-tabs.svelte';
	import { STAT_SNAPSHOT_STATUS_TONES } from '$lib/components/stats/labels';
	import type { FieldOption } from '$lib/components/form/field-select.svelte';
	import {
		isCollectedSnapshot,
		isEmptyCoverage,
		STAT_SNAPSHOT_MODE_LABELS,
		STAT_SNAPSHOT_STATUSES,
		STAT_SNAPSHOT_STATUS_LABELS,
		STAT_SOURCES,
		STAT_SOURCE_LABELS,
		type StatSnapshotListItem
	} from '$lib/contracts/stats';
	import { formatDate, formatDateTime, formatNumber, pluralize } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const SOURCE_OPTIONS: readonly FieldOption[] = STAT_SOURCES.map((source) => ({
		value: source,
		label: STAT_SOURCE_LABELS[source]
	}));

	const STATUS_OPTIONS: readonly FieldOption[] = STAT_SNAPSHOT_STATUSES.map((status) => ({
		value: status,
		label: STAT_SNAPSHOT_STATUS_LABELS[status]
	}));

	const columns: ColumnDef<DataTableFeatures, StatSnapshotListItem>[] = [
		{
			id: 'source',
			accessorFn: (row) => row.source,
			header: 'Источник',
			meta: { title: 'Источник' },
			enableSorting: false,
			enableHiding: false,
			cell: ({ row }) => renderSnippet(sourceCell, row.original)
		},
		{
			id: 'mode',
			accessorFn: (row) => row.mode,
			header: 'Режим',
			meta: { title: 'Режим' },
			enableSorting: false,
			cell: ({ row }) => STAT_SNAPSHOT_MODE_LABELS[row.original.mode]
		},
		{
			id: 'periodStart',
			accessorFn: (row) => row.periodStart,
			header: 'Период',
			meta: { title: 'Период' },
			cell: ({ row }) => renderSnippet(periodCell, row.original)
		},
		{
			id: 'coverage',
			header: 'Область',
			meta: { title: 'Область' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(coverageCell, row.original)
		},
		{
			id: 'status',
			accessorFn: (row) => row.status,
			header: 'Состояние',
			meta: { title: 'Состояние' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(statusCell, row.original)
		},
		{
			id: 'rowCount',
			accessorFn: (row) => row.rowCount,
			header: 'Строк',
			meta: { title: 'Строк', align: 'end' },
			cell: ({ row }) => formatNumber(row.original.rowCount)
		},
		{
			id: 'errorCount',
			accessorFn: (row) => row.errorCount,
			header: 'С ошибками',
			meta: { title: 'С ошибками', align: 'end' },
			cell: ({ row }) => renderSnippet(errorsCell, row.original)
		},
		{
			id: 'author',
			accessorFn: (row) => row.authorName ?? '',
			header: 'Загрузил',
			meta: { title: 'Загрузил' },
			enableSorting: false,
			cell: ({ row }) => row.original.authorName ?? '—'
		},
		{
			id: 'createdAt',
			accessorFn: (row) => row.createdAt,
			header: 'Когда',
			meta: { title: 'Когда' },
			cell: ({ row }) => formatDateTime(row.original.createdAt)
		}
	];

	function open(row: StatSnapshotListItem) {
		return goto(resolve('/(app)/data/[id=uuid]', { id: row.id }));
	}
</script>

{#snippet sourceCell(row: StatSnapshotListItem)}
	<span class="flex min-w-0 flex-col">
		<span class="font-medium">{STAT_SOURCE_LABELS[row.source]}</span>
		{#if row.fileName}
			<span class="max-w-56 truncate text-xs text-muted-foreground" title={row.fileName}>
				{row.fileName}
			</span>
		{:else if isCollectedSnapshot(row)}
			<span class="text-xs text-muted-foreground">собран из учебных групп</span>
		{/if}
	</span>
{/snippet}

{#snippet periodCell(row: StatSnapshotListItem)}
	<span class="whitespace-nowrap">
		{formatDate(row.periodStart)} — {formatDate(row.periodEnd)}
	</span>
{/snippet}

{#snippet coverageCell(row: StatSnapshotListItem)}
	{#if isEmptyCoverage(row.coverage)}
		<span class="text-muted-foreground">Всё, что в файле</span>
	{:else}
		<span>{pluralize(row.coverageSize, ['запись', 'записи', 'записей'])}</span>
	{/if}
{/snippet}

{#snippet statusCell(row: StatSnapshotListItem)}
	<span class="flex flex-wrap items-center gap-1">
		<StatusBadge tone={STAT_SNAPSHOT_STATUS_TONES[row.status]}>
			{STAT_SNAPSHOT_STATUS_LABELS[row.status]}
		</StatusBadge>
		{#if row.isCurrent}
			<StatusBadge tone="accent" dot title="Учитывается в показателях">Текущий</StatusBadge>
		{:else if row.status === 'confirmed'}
			<StatusBadge tone="neutral" title="Замещён более поздней выгрузкой">Замещён</StatusBadge>
		{/if}
	</span>
{/snippet}

{#snippet errorsCell(row: StatSnapshotListItem)}
	{#if row.errorCount === 0}
		<span class="text-muted-foreground">0</span>
	{:else}
		<span class="font-medium text-danger-soft-foreground">{formatNumber(row.errorCount)}</span>
	{/if}
{/snippet}

<svelte:head><title>Данные об обучении — Альма CRM</title></svelte:head>

<Header
	title="Данные об обучении"
	description="Загрузки статистики с сопоставлением колонок, построчной проверкой и подтверждением: показатели считаются только по подтверждённым снимкам."
>
	{#snippet actions()}
		{#if data.canImport}
			<Button variant="outline" href={resolve('/(app)/data/collect')}>
				<LayersIcon aria-hidden="true" />
				Собрать из результатов групп
			</Button>
			<Button href={resolve('/(app)/data/new')}>
				<UploadIcon aria-hidden="true" />
				Загрузить файл
			</Button>
		{/if}
	{/snippet}
</Header>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<SectionTabs />

	{#if data.total === 0 && !data.filtered}
		<div class="rounded-lg border border-border bg-surface shadow-xs">
			<EmptyState
				icon={DatabaseIcon}
				title="Данных пока нет"
				description="Загрузите выгрузку в XLSX или CSV: система предложит сопоставление колонок, покажет ошибки построчно и посчитает показатели после подтверждения."
			>
				{#snippet action()}
					{#if data.canImport}
						<Button href={resolve('/(app)/data/new')}>Загрузить файл</Button>
					{:else}
						<p class="text-sm text-muted-foreground">
							Загрузка данных доступна роли с правом «stats.import».
						</p>
					{/if}
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-3" data-tour="data-filters">
			<FilterSelect param="source" label="Источник" options={SOURCE_OPTIONS} />
			<FilterSelect param="status" label="Состояние" options={STATUS_OPTIONS} />
			<span class="text-sm text-muted-foreground">Всего: {formatNumber(data.total)}</span>
		</div>

		<DataTable
			data-tour="data-table"
			{columns}
			rows={data.rows}
			total={data.total}
			getRowId={(row) => row.id}
			searchPlaceholder="Поиск по имени файла и примечанию"
			emptyTitle="Под фильтр ничего не подошло"
			emptyDescription="Смягчите условия или очистите поиск."
			onopen={open}
		/>
	{/if}
</div>
