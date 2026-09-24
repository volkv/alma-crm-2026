<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import FilterXIcon from '@lucide/svelte/icons/filter-x';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FilterSelect from '$lib/components/directory/filter-select.svelte';
	import {
		LIFECYCLE_STATUS_LABELS,
		LIFECYCLE_STATUS_OPTIONS,
		LIFECYCLE_STATUS_TONES,
		PROGRAM_LEVEL_LABELS,
		PROGRAM_LEVEL_OPTIONS
	} from '$lib/components/directory/labels';
	import { clearedFiltersHref } from '$lib/components/directory/query';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { ProgramListItem } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const columns: ColumnDef<DataTableFeatures, ProgramListItem>[] = [
		{
			id: 'priority',
			accessorFn: (row) => row.program.priority,
			header: 'Приоритет',
			meta: { title: 'Приоритет', align: 'end' },
			cell: ({ row }) => renderSnippet(priorityCell, row.original)
		},
		{
			id: 'code',
			accessorFn: (row) => row.program.code,
			header: 'Код',
			meta: { title: 'Код' },
			enableHiding: false,
			cell: ({ row }) => row.original.program.code
		},
		{
			id: 'name',
			accessorFn: (row) => row.program.name,
			header: 'Название',
			meta: { title: 'Название' },
			cell: ({ row }) => renderSnippet(nameCell, row.original)
		},
		{
			id: 'level',
			accessorFn: (row) => row.program.level,
			header: 'Уровень',
			meta: { title: 'Уровень' },
			cell: ({ row }) => PROGRAM_LEVEL_LABELS[row.original.program.level]
		},
		{
			id: 'directionCode',
			accessorFn: (row) => row.program.directionCode,
			header: 'Направление',
			meta: { title: 'Направление' },
			enableSorting: false,
			cell: ({ row }) => row.original.program.directionCode ?? '—'
		},
		{
			id: 'status',
			accessorFn: (row) => row.program.status,
			header: 'Состояние',
			meta: { title: 'Состояние' },
			cell: ({ row }) => renderSnippet(statusCell, row.original)
		},
		{
			id: 'latestVersion',
			accessorFn: (row) => row.latestVersion,
			header: 'Версия',
			meta: { title: 'Версия', align: 'end' },
			enableSorting: false,
			cell: ({ row }) =>
				row.original.latestVersion === null ? '—' : `в. ${row.original.latestVersion}`
		}
	];

	function open(row: ProgramListItem) {
		return goto(resolve('/(app)/programs/[id=uuid]', { id: row.program.id }));
	}
</script>

{#snippet priorityCell(row: ProgramListItem)}
	{#if row.program.priority === null}
		<span class="text-faint">—</span>
	{:else}
		<StatusBadge tone="accent">{row.program.priority}</StatusBadge>
	{/if}
{/snippet}

{#snippet nameCell(row: ProgramListItem)}
	<span class="font-medium">{row.program.name}</span>
{/snippet}

{#snippet statusCell(row: ProgramListItem)}
	<StatusBadge tone={LIFECYCLE_STATUS_TONES[row.program.status]} dot>
		{LIFECYCLE_STATUS_LABELS[row.program.status]}
	</StatusBadge>
{/snippet}

<svelte:head><title>Программы — Альма CRM</title></svelte:head>

<Header
	title="Программы"
	description="Образовательные программы оператора: по ним сверяют планы и отчёты. Порядок — ручной приоритет, затем название."
>
	{#snippet actions()}
		{#if data.canWrite}
			<Button href={resolve('/(app)/programs/new')}>
				<PlusIcon aria-hidden="true" />
				Новая программа
			</Button>
		{/if}
	{/snippet}
</Header>

{#snippet resetFilters()}
	<Button variant="outline" href={clearedFiltersHref(page.url, ['level', 'status'])}>
		<FilterXIcon aria-hidden="true" />
		Сбросить фильтры
	</Button>
{/snippet}

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<div class="flex flex-wrap items-center gap-3" data-tour="programs-filters">
		<FilterSelect param="level" label="Уровень" options={PROGRAM_LEVEL_OPTIONS} />
		<FilterSelect param="status" label="Состояние" options={LIFECYCLE_STATUS_OPTIONS} />
	</div>

	<DataTable
		data-tour="programs-table"
		{columns}
		rows={data.rows}
		total={data.total}
		getRowId={(row) => row.program.id}
		defaultSort={{ columnId: 'priority', direction: 'asc' }}
		searchPlaceholder="Поиск по коду, названию, направлению"
		emptyTitle={data.filtered ? 'Под фильтр ничего не подошло' : 'Программ пока нет'}
		emptyAction={data.filtered ? resetFilters : undefined}
		emptyDescription={data.filtered
			? 'Смягчите условия или очистите поиск.'
			: 'Заведите программу — на неё ссылаются взаимодействия и отчёты.'}
		onopen={open}
	/>
</div>
