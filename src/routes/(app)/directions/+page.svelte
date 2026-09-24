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
	import Flash from '$lib/components/directory/flash.svelte';
	import {
		DIRECTION_STATE_LABELS,
		DIRECTION_STATE_OPTIONS,
		DIRECTION_STATE_TONES
	} from '$lib/components/directory/labels';
	import { clearedFiltersHref } from '$lib/components/directory/query';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { DirectionListItem } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const columns: ColumnDef<DataTableFeatures, DirectionListItem>[] = [
		{
			id: 'position',
			accessorFn: (row) => row.direction.position,
			header: 'Порядок',
			meta: { title: 'Порядок', align: 'end' },
			cell: ({ row }) => row.original.direction.position
		},
		{
			id: 'code',
			accessorFn: (row) => row.direction.code,
			header: 'Код',
			meta: { title: 'Код' },
			enableHiding: false,
			cell: ({ row }) => row.original.direction.code
		},
		{
			id: 'name',
			accessorFn: (row) => row.direction.name,
			header: 'Название',
			meta: { title: 'Название' },
			cell: ({ row }) => renderSnippet(nameCell, row.original)
		},
		{
			id: 'productCount',
			accessorFn: (row) => row.productCount,
			header: 'Продуктов',
			meta: { title: 'Продуктов', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => row.original.productCount
		},
		{
			id: 'programCount',
			accessorFn: (row) => row.programCount,
			header: 'Программ',
			meta: { title: 'Программ', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => row.original.programCount
		},
		{
			id: 'state',
			accessorFn: (row) => row.direction.isActive,
			header: 'Состояние',
			meta: { title: 'Состояние' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(stateCell, row.original)
		}
	];

	function open(row: DirectionListItem) {
		return goto(resolve('/(app)/directions/[id=uuid]', { id: row.direction.id }));
	}
</script>

{#snippet nameCell(row: DirectionListItem)}
	<span class="font-medium">{row.direction.name}</span>
{/snippet}

{#snippet stateCell(row: DirectionListItem)}
	<!-- Не `state`: это имя закрывает руну `$state` для всего файла. -->
	{@const directionState = row.direction.isActive ? 'active' : 'archived'}
	<StatusBadge tone={DIRECTION_STATE_TONES[directionState]} dot>
		{DIRECTION_STATE_LABELS[directionState]}
	</StatusBadge>
{/snippet}

<svelte:head><title>Направления — Альма CRM</title></svelte:head>

<Flash messages={{ archived: 'Направление отправлено в архив' }} />

<Header
	title="Направления"
	description="ИТ-направления оператора: по ним назначают ответственных за вуз и собирают разрезы отчёта."
>
	{#snippet actions()}
		{#if data.canWrite}
			<Button href={resolve('/(app)/directions/new')}>
				<PlusIcon aria-hidden="true" />
				Новое направление
			</Button>
		{/if}
	{/snippet}
</Header>

{#snippet resetFilters()}
	<Button variant="outline" href={clearedFiltersHref(page.url, ['state'])}>
		<FilterXIcon aria-hidden="true" />
		Сбросить фильтры
	</Button>
{/snippet}

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<div class="flex flex-wrap items-center gap-3" data-tour="directions-filters">
		<FilterSelect param="state" label="Состояние" options={DIRECTION_STATE_OPTIONS} />
	</div>

	<DataTable
		data-tour="directions-table"
		{columns}
		rows={data.rows}
		total={data.total}
		getRowId={(row) => row.direction.id}
		defaultSort={{ columnId: 'position', direction: 'asc' }}
		searchPlaceholder="Поиск по коду и названию"
		emptyTitle={data.filtered ? 'Под фильтр ничего не подошло' : 'Направлений пока нет'}
		emptyAction={data.filtered ? resetFilters : undefined}
		emptyDescription={data.filtered
			? 'Смягчите условия или очистите поиск.'
			: 'Заведите направление — по нему назначают ответственных и собирают отчёт.'}
		onopen={open}
	/>
</div>
