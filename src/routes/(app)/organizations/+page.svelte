<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import FilterXIcon from '@lucide/svelte/icons/filter-x';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { Button } from '$lib/components/ui/button/index.js';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FilterSelect from '$lib/components/directory/filter-select.svelte';
	import Flash from '$lib/components/directory/flash.svelte';
	import {
		EDUCATION_LEVEL_LABELS,
		EDUCATION_LEVEL_OPTIONS,
		ORGANIZATION_KIND_LABELS,
		ORGANIZATION_KIND_OPTIONS,
		ORGANIZATION_KIND_TONES
	} from '$lib/components/directory/labels';
	import { clearedFiltersHref } from '$lib/components/directory/query';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatNumber } from '$lib/format';
	import type { OrganizationRow } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const columns: ColumnDef<DataTableFeatures, OrganizationRow>[] = [
		{
			id: 'shortName',
			accessorFn: (row) => row.organization.shortName,
			header: 'Название',
			meta: { title: 'Название' },
			enableHiding: false,
			cell: ({ row }) => renderSnippet(nameCell, row.original)
		},
		{
			id: 'kind',
			accessorFn: (row) => row.organization.kind,
			header: 'Вид',
			meta: { title: 'Вид' },
			cell: ({ row }) => renderSnippet(kindCell, row.original)
		},
		{
			id: 'inn',
			accessorFn: (row) => row.organization.inn,
			header: 'ИНН',
			meta: { title: 'ИНН' },
			cell: ({ row }) => row.original.organization.inn ?? '—'
		},
		{
			id: 'region',
			accessorFn: (row) => row.organization.region,
			header: 'Регион',
			meta: { title: 'Регион' },
			cell: ({ row }) => row.original.organization.region ?? '—'
		},
		{
			id: 'siteCount',
			accessorFn: (row) => row.siteCount,
			header: 'Площадок',
			meta: { title: 'Площадок', align: 'end' },
			cell: ({ row }) => formatNumber(row.original.siteCount)
		},
		{
			id: 'isActive',
			accessorFn: (row) => row.organization.isActive,
			header: 'Состояние',
			meta: { title: 'Состояние' },
			cell: ({ row }) => renderSnippet(stateCell, row.original)
		}
	];

	function open(row: OrganizationRow) {
		return goto(resolve('/(app)/organizations/[id=uuid]', { id: row.organization.id }));
	}
</script>

{#snippet nameCell(row: OrganizationRow)}
	<span class="font-medium">{row.organization.shortName}</span>
	{#if row.organization.educationLevel}
		<span class="ml-2 text-xs text-muted-foreground">
			{EDUCATION_LEVEL_LABELS[row.organization.educationLevel]}
		</span>
	{/if}
{/snippet}

{#snippet kindCell(row: OrganizationRow)}
	<StatusBadge tone={ORGANIZATION_KIND_TONES[row.organization.kind]}>
		{ORGANIZATION_KIND_LABELS[row.organization.kind]}
	</StatusBadge>
{/snippet}

{#snippet stateCell(row: OrganizationRow)}
	{#if row.organization.isActive}
		<StatusBadge tone="success" dot>Активна</StatusBadge>
	{:else}
		<StatusBadge tone="neutral" dot>В архиве</StatusBadge>
	{/if}
{/snippet}

<svelte:head><title>Организации — Альма CRM</title></svelte:head>

<Flash messages={{ archived: 'Организация переведена в архив' }} />

<Header
	title="Организации"
	description="Учебные заведения, компании-заказчики и операторы, с которыми идёт работа."
>
	{#snippet actions()}
		{#if data.canImport}
			<!-- Вход в мастер импорта стоит здесь, а не отдельным пунктом меню:
				каталог заказчика — это строки про вузы, и заводят его из справочника
				организаций. Отдельный раздел обещал бы место, где импорт живёт
				постоянно, а он одноразовый: файл, предпросмотр, применение. -->
			<!-- `data-tour` — метка подсказок (`$lib/onboarding/screens`). -->
			<Button
				variant="outline"
				href={resolve('/organizations/import')}
				data-tour="directory-import"
			>
				<UploadIcon aria-hidden="true" />
				Импорт каталога
			</Button>
		{/if}
		{#if data.canWrite}
			<Button href={resolve('/organizations/new')}>
				<PlusIcon aria-hidden="true" />
				Новая организация
			</Button>
		{/if}
	{/snippet}
</Header>

{#snippet resetFilters()}
	<Button variant="outline" href={clearedFiltersHref(page.url, ['kind', 'level'])}>
		<FilterXIcon aria-hidden="true" />
		Сбросить фильтры
	</Button>
{/snippet}

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<div class="flex flex-wrap items-center gap-3" data-tour="organizations-filters">
		<FilterSelect param="kind" label="Вид" options={ORGANIZATION_KIND_OPTIONS} />
		<FilterSelect param="level" label="Уровень" options={EDUCATION_LEVEL_OPTIONS} />
	</div>

	<DataTable
		data-tour="organizations-table"
		{columns}
		rows={data.rows}
		total={data.total}
		getRowId={(row) => row.organization.id}
		searchPlaceholder="Поиск по названию, ИНН, региону"
		emptyTitle={data.filtered ? 'Под фильтр ничего не подошло' : 'Организаций пока нет'}
		emptyAction={data.filtered ? resetFilters : undefined}
		emptyDescription={data.filtered
			? 'Смягчите условия или очистите поиск.'
			: 'Заведите первую организацию — с неё начинается взаимодействие.'}
		onopen={open}
	/>
</div>
