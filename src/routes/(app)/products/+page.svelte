<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FilterSelect from '$lib/components/directory/filter-select.svelte';
	import {
		LIFECYCLE_STATUS_LABELS,
		LIFECYCLE_STATUS_OPTIONS,
		LIFECYCLE_STATUS_TONES
	} from '$lib/components/directory/labels';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { ProductDetail } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

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
		{#if data.canWrite}
			<Button href={resolve('/(app)/products/new')}>
				<PlusIcon aria-hidden="true" />
				Новый продукт
			</Button>
		{/if}
	{/snippet}
</Header>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<div class="flex flex-wrap items-center gap-3" data-tour="products-filters">
		<FilterSelect param="status" label="Состояние" options={LIFECYCLE_STATUS_OPTIONS} />
	</div>

	<DataTable
		data-tour="products-table"
		{columns}
		rows={data.rows}
		total={data.total}
		getRowId={(row) => row.product.id}
		searchPlaceholder="Поиск по коду и названию"
		emptyTitle={data.filtered ? 'Под фильтр ничего не подошло' : 'Продуктов пока нет'}
		emptyDescription={data.filtered
			? 'Смягчите условия или очистите поиск.'
			: 'Заведите продукт — на него ссылаются взаимодействия.'}
		onopen={open}
	/>
</div>
