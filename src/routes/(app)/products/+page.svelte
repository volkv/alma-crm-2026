<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { renderSnippet, type ColumnDef, type SvelteTable } from '@tanstack/svelte-table';
	import FilterXIcon from '@lucide/svelte/icons/filter-x';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import ColumnsMenu from '$lib/components/data-table/columns-menu.svelte';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FilterBar, {
		searchParam,
		singleParamFilter
	} from '$lib/components/filters/filter-bar.svelte';
	import type { StripFilter } from '$lib/components/filters/filter-strip.svelte';
	import {
		LIFECYCLE_STATUS_LABELS,
		LIFECYCLE_STATUS_OPTIONS,
		LIFECYCLE_STATUS_TONES
	} from '$lib/components/directory/labels';
	import { clearedFiltersHref } from '$lib/components/directory/query';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { ProductDetail } from '$lib/contracts/directory';
	import { openWhenRequested } from '$lib/components/create-dialog/create-dialog.svelte';
	import CreateDialog from './create-dialog.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// `?create` в адресе открывает окно сразу — так на него ведут ссылки с
	// других экранов; параметр затем уходит, чтобы обновление не открыло окно снова.
	let createOpen = $state(false);

	openWhenRequested(
		() => data.create?.openOnLoad ?? false,
		() => (createOpen = true)
	);

	const columns: ColumnDef<DataTableFeatures, ProductDetail>[] = [
		{
			id: 'code',
			accessorFn: (row) => row.product.code,
			header: 'Код',
			meta: { title: 'Код' },
			enableHiding: false,
			cell: ({ row }) => row.original.product.code
		},
		{
			id: 'name',
			accessorFn: (row) => row.product.name,
			header: 'Название',
			meta: { title: 'Название' },
			cell: ({ row }) => renderSnippet(nameCell, row.original)
		},
		{
			id: 'vendor',
			accessorFn: (row) => row.vendor?.label ?? null,
			header: 'Правообладатель',
			meta: { title: 'Правообладатель' },
			enableSorting: false,
			cell: ({ row }) => row.original.vendor?.label ?? '—'
		},
		{
			id: 'status',
			accessorFn: (row) => row.product.status,
			header: 'Состояние',
			meta: { title: 'Состояние' },
			cell: ({ row }) => renderSnippet(statusCell, row.original)
		}
	];

	function open(row: ProductDetail) {
		return goto(resolve('/(app)/products/[id=uuid]', { id: row.product.id }));
	}

	const FILTER_PARAMS = ['status'] as const;

	let tableApi = $state<SvelteTable<DataTableFeatures, ProductDetail> | null>(null);

	const filters = $derived<StripFilter[]>([
		singleParamFilter(page.url, {
			param: 'status',
			label: 'Состояние',
			options: LIFECYCLE_STATUS_OPTIONS,
			testId: 'products-filter-status'
		})
	]);
</script>

{#snippet nameCell(row: ProductDetail)}
	<span class="font-medium">{row.product.name}</span>
{/snippet}

{#snippet statusCell(row: ProductDetail)}
	<StatusBadge tone={LIFECYCLE_STATUS_TONES[row.product.status]} dot>
		{LIFECYCLE_STATUS_LABELS[row.product.status]}
	</StatusBadge>
{/snippet}

<svelte:head><title>Продукты — Альма CRM</title></svelte:head>

<Header
	title="Продукты"
	description="То, что оператор предлагает учебным заведениям вместе с программами."
>
	{#snippet actions()}
		{#if data.create !== null}
			<Button onclick={() => (createOpen = true)}>
				<PlusIcon aria-hidden="true" />
				Добавить продукт
			</Button>
		{/if}
	{/snippet}
</Header>

{#if data.create !== null}
	<CreateDialog bind:open={createOpen} create={data.create} />
{/if}

{#snippet resetFilters()}
	<Button variant="outline" href={clearedFiltersHref(page.url, FILTER_PARAMS)}>
		<FilterXIcon aria-hidden="true" />
		Сбросить фильтры
	</Button>
{/snippet}

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<!-- Ряд отборов, общий для списков (`filter-bar.svelte`): поиск первым,
		«Колонки» в конце — свои у таблицы выключены. -->
	<FilterBar
		data-tour="products-filters"
		testId="products"
		search={searchParam(page.url, 'Поиск по коду и названию')}
		{filters}
		clearHref={data.filtered ? clearedFiltersHref(page.url, FILTER_PARAMS) : null}
	>
		{#snippet end()}
			<ColumnsMenu table={tableApi} labelClass="max-2xl:sr-only" title="Колонки" />
		{/snippet}
	</FilterBar>

	<DataTable
		data-tour="products-table"
		{columns}
		rows={data.rows}
		total={data.total}
		getRowId={(row) => row.product.id}
		columnsMenu={false}
		ontable={(table) => (tableApi = table)}
		emptyTitle={data.filtered ? 'Под фильтр ничего не подошло' : 'Продуктов пока нет'}
		emptyAction={data.filtered ? resetFilters : undefined}
		emptyDescription={data.filtered
			? 'Смягчите условия или очистите поиск.'
			: 'Добавьте продукт — на него ссылаются взаимодействия.'}
		onopen={open}
	/>
</div>
