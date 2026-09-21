<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FilterSelect from '$lib/components/directory/filter-select.svelte';
	import { toLookupOptions } from '$lib/components/directory/labels';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { PersonListItem } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

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

<svelte:head><title>Контакты — LCT CRM</title></svelte:head>

<Header title="Контакты" description="Люди, с которыми идёт работа, и их роли в организациях.">
	{#snippet actions()}
		{#if data.canWrite}
			<Button href={resolve('/(app)/people/new')}>
				<PlusIcon aria-hidden="true" />
				Новый человек
			</Button>
		{/if}
	{/snippet}
</Header>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<div class="flex flex-wrap items-center gap-3" data-tour="people-filters">
		<FilterSelect
			param="organization"
			label="Организация"
			options={toLookupOptions(data.organizations)}
		/>
		{#if data.managesPii}
			<FilterSelect param="retention" label="Срок хранения" options={RETENTION_OPTIONS} />
		{/if}
	</div>

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
		searchPlaceholder="Поиск по ФИО и организации"
		emptyTitle={data.filtered ? 'Под фильтр никто не подошёл' : 'Людей пока нет'}
		emptyDescription={data.filtered
			? 'Смягчите условия или очистите поиск.'
			: 'Заведите человека — дальше ему назначают роль в организации.'}
		onopen={open}
	/>
</div>
