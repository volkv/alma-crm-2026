<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { renderSnippet, type ColumnDef, type SvelteTable } from '@tanstack/svelte-table';
	import FilterXIcon from '@lucide/svelte/icons/filter-x';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { Button } from '$lib/components/ui/button/index.js';
	import ColumnsMenu from '$lib/components/data-table/columns-menu.svelte';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import Flash from '$lib/components/directory/flash.svelte';
	import {
		EDUCATION_LEVEL_LABELS,
		EDUCATION_LEVEL_OPTIONS,
		ORGANIZATION_KIND_LABELS,
		ORGANIZATION_KIND_OPTIONS,
		ORGANIZATION_KIND_TONES
	} from '$lib/components/directory/labels';
	import {
		clearedFiltersHref,
		filterHref,
		toggledFilterHref
	} from '$lib/components/directory/query';
	import FilterBar from '$lib/components/filters/filter-bar.svelte';
	import type { StripFilter } from '$lib/components/filters/filter-strip.svelte';
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
			header: 'Тип',
			meta: { title: 'Тип' },
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

	const FILTER_PARAMS = ['kind', 'level'] as const;

	let tableApi = $state<SvelteTable<DataTableFeatures, OrganizationRow> | null>(null);

	function toggle(param: (typeof FILTER_PARAMS)[number], value: string) {
		void goto(toggledFilterHref(page.url, param, value), { keepFocus: true, noScroll: true });
	}

	const filters = $derived<StripFilter[]>([
		{
			kind: 'list',
			key: 'kind',
			label: 'Тип',
			options: ORGANIZATION_KIND_OPTIONS,
			selected: data.filters.kind,
			testId: 'organizations-filter-kind',
			ontoggle: (value) => toggle('kind', value)
		},
		{
			kind: 'list',
			key: 'level',
			label: 'Уровень',
			options: EDUCATION_LEVEL_OPTIONS,
			selected: data.filters.level,
			testId: 'organizations-filter-level',
			ontoggle: (value) => toggle('level', value)
		}
	]);

	function open(row: OrganizationRow) {
		return goto(resolve('/(app)/organizations/[id=uuid]', { id: row.organization.id }));
	}
</script>

<!-- Краткое название из реестра бывает полным, в три строки ширины экрана
	(«…университет, …университет или СПбГУ»). Ячейка переносит его и режет на
	второй строке, а целиком оно в подсказке: иначе одна строка растягивала бы
	таблицу вбок и прятала остальные колонки за прокруткой. -->
{#snippet nameCell(row: OrganizationRow)}
	<div class="line-clamp-2 max-w-md min-w-48 whitespace-normal" title={row.organization.shortName}>
		<span class="font-medium">{row.organization.shortName}</span>
		{#if row.organization.educationLevel}
			<span class="ml-2 text-xs text-muted-foreground">
				{EDUCATION_LEVEL_LABELS[row.organization.educationLevel]}
			</span>
		{/if}
	</div>
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
	<Button variant="outline" href={clearedFiltersHref(page.url, FILTER_PARAMS)}>
		<FilterXIcon aria-hidden="true" />
		Сбросить фильтры
	</Button>
{/snippet}

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<!-- Ряд отборов тот же, что у взаимодействий (`filter-bar.svelte`), поэтому
		своя строка поиска и меню «Колонки» таблицы выключены: поиск стоит первым
		в ряду, «Колонки» — в его конце. -->
	<FilterBar
		data-tour="organizations-filters"
		testId="organizations"
		search={{
			value: data.search,
			placeholder: 'Поиск по названию, ИНН, региону',
			onsearch: (value) =>
				void goto(filterHref(page.url, 'q', value), { keepFocus: true, noScroll: true })
		}}
		{filters}
		clearHref={data.filtered ? clearedFiltersHref(page.url, FILTER_PARAMS) : null}
	>
		{#snippet end()}
			<ColumnsMenu table={tableApi} labelClass="max-2xl:sr-only" title="Колонки" />
		{/snippet}
	</FilterBar>

	<DataTable
		data-tour="organizations-table"
		{columns}
		rows={data.rows}
		total={data.total}
		getRowId={(row) => row.organization.id}
		columnsMenu={false}
		ontable={(table) => (tableApi = table)}
		emptyTitle={data.filtered ? 'Под фильтр ничего не подошло' : 'Организаций пока нет'}
		emptyAction={data.filtered ? resetFilters : undefined}
		emptyDescription={data.filtered
			? 'Смягчите условия или очистите поиск.'
			: 'Заведите первую организацию — с неё начинается взаимодействие.'}
		onopen={open}
	/>
</div>
