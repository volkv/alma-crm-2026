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
	import { toLookupOptions } from '$lib/components/directory/labels';
	import { clearedFiltersHref } from '$lib/components/directory/query';
	import { openWhenRequested } from '$lib/components/create-dialog/create-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { PersonListItem } from '$lib/contracts/directory';
	import CreatePersonDialog from './create-person-dialog.svelte';
	import { FOR_ORGANIZATION_PARAM } from './create-params';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/**
	 * Окно «Добавить контакт». `?create` (и `&for=<организация>` из формы
	 * контакта организации) открывает его сразу, а параметры уходят из адреса.
	 */
	let createOpen = $state(false);

	openWhenRequested(
		() => data.createPerson?.openOnLoad ?? false,
		() => (createOpen = true),
		FOR_ORGANIZATION_PARAM
	);

	const masked = $derived(data.rows.some((row) => row.person.contactsMasked));

	/** Единственный вопрос, который задают сроку хранения: чей уже прошёл. */
	const RETENTION_OPTIONS = [{ value: 'expired', label: 'Срок хранения истёк' }];

	const columns: ColumnDef<DataTableFeatures, PersonListItem>[] = [
		{
			id: 'lastName',
			accessorFn: (row) => row.person.lastName,
			header: 'Фамилия',
			meta: { title: 'Фамилия' },
			enableHiding: false,
			cell: ({ row }) => renderSnippet(nameCell, row.original)
		},
		{
			id: 'organizations',
			accessorFn: (row) => row.organizations.length,
			header: 'Организации',
			meta: { title: 'Организации' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(organizationsCell, row.original)
		},
		{
			id: 'email',
			accessorFn: (row) => row.person.email,
			header: 'Почта',
			meta: { title: 'Почта' },
			enableSorting: false,
			cell: ({ row }) => row.original.person.email ?? '—'
		},
		{
			id: 'phone',
			accessorFn: (row) => row.person.phone,
			header: 'Телефон',
			meta: { title: 'Телефон' },
			enableSorting: false,
			cell: ({ row }) => row.original.person.phone ?? '—'
		}
	];

	function open(row: PersonListItem) {
		return goto(resolve('/(app)/people/[id=uuid]', { id: row.person.id }));
	}

	const FILTER_PARAMS = ['organization', 'retention'] as const;

	let tableApi = $state<SvelteTable<DataTableFeatures, PersonListItem> | null>(null);

	const filters = $derived<StripFilter[]>([
		singleParamFilter(page.url, {
			param: 'organization',
			label: 'Организация',
			options: toLookupOptions(data.organizations),
			testId: 'people-filter-organization'
		}),
		...(data.managesPii
			? [
					singleParamFilter(page.url, {
						param: 'retention',
						label: 'Срок хранения',
						options: RETENTION_OPTIONS,
						testId: 'people-filter-retention'
					})
				]
			: [])
	]);
</script>

{#snippet nameCell(row: PersonListItem)}
	<span class="flex flex-wrap items-center gap-2">
		<span class="font-medium">
			{[row.person.lastName, row.person.firstName, row.person.middleName]
				.filter((part) => part !== null && part !== '')
				.join(' ')}
		</span>
		{#if row.person.anonymizedAt !== null}
			<StatusBadge tone="neutral">Обезличен</StatusBadge>
		{:else if row.retentionExpired}
			<StatusBadge tone="warning" dot title="Срок хранения истёк {row.person.retentionUntil}">
				Срок истёк
			</StatusBadge>
		{/if}
	</span>
{/snippet}

{#snippet organizationsCell(row: PersonListItem)}
	{#if row.organizations.length === 0}
		<span class="text-faint">—</span>
	{:else}
		<span class="text-muted-foreground">
			{row.organizations.map((organization) => organization.label).join(', ')}
		</span>
	{/if}
{/snippet}

{#if data.createPerson !== null}
	<CreatePersonDialog bind:open={createOpen} create={data.createPerson} />
{/if}

<svelte:head><title>Контакты — Альма CRM</title></svelte:head>

<Header title="Контакты" description="Люди, с которыми идёт работа, и их роли в организациях.">
	{#snippet actions()}
		{#if data.createPerson !== null}
			<Button onclick={() => (createOpen = true)}>
				<PlusIcon aria-hidden="true" />
				Добавить контакт
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
	<!-- Ряд отборов, общий для списков (`filter-bar.svelte`): поиск первым,
		«Колонки» в конце — свои у таблицы выключены. -->
	<FilterBar
		data-tour="people-filters"
		testId="people"
		search={searchParam(page.url, 'Поиск по ФИО и организации')}
		{filters}
		clearHref={data.filtered ? clearedFiltersHref(page.url, FILTER_PARAMS) : null}
	>
		{#snippet end()}
			<ColumnsMenu table={tableApi} labelClass="max-2xl:sr-only" title="Колонки" />
		{/snippet}
	</FilterBar>

	{#if masked}
		<InlineHint tone="info">
			Почта и телефон показаны закрытыми: полные контакты видны с правом «Просмотр контактов людей
			без маскирования».
		</InlineHint>
	{/if}

	<DataTable
		data-tour="people-table"
		{columns}
		rows={data.rows}
		total={data.total}
		getRowId={(row) => row.person.id}
		columnsMenu={false}
		ontable={(table) => (tableApi = table)}
		emptyTitle={data.filtered ? 'Под фильтр никто не подошёл' : 'Людей пока нет'}
		emptyAction={data.filtered ? resetFilters : undefined}
		emptyDescription={data.filtered
			? 'Смягчите условия или очистите поиск.'
			: 'Добавьте человека — дальше ему назначают роль в организации.'}
		onopen={open}
	/>
</div>
