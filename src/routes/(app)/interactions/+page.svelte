<script lang="ts">
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import { toast } from 'svelte-sonner';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import UserCogIcon from '@lucide/svelte/icons/user-cog';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import EmptyState from '$lib/components/empty-state.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import SlaChip from '$lib/components/sla-chip.svelte';
	import StageTimeline from '$lib/components/stage-timeline.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { toTimelineStages } from '$lib/components/interactions/timeline';
	import {
		STAGE_CATEGORIES,
		type InteractionListItem,
		type InteractionStatus,
		type StageCategory
	} from '$lib/contracts/interactions';
	import { formatDateTime } from '$lib/format';
	import {
		filtersHref,
		INTERACTION_STATUS_LABELS,
		STAGE_CATEGORY_LABELS,
		type InteractionFilters
	} from './filters';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let assignOpen = $state(false);
	let assignIds = $state<string[]>([]);
	let assignUserId = $state('');

	$effect(() => {
		if (form && 'assigned' in form) {
			toast.success(`Ответственный назначен: ${form.assigned}`);
		} else if (form && 'message' in form) {
			toast.error(form.message);
		}
	});

	const columns: ColumnDef<DataTableFeatures, InteractionListItem>[] = [
		{
			accessorKey: 'title',
			header: 'Взаимодействие',
			meta: { title: 'Взаимодействие' },
			enableHiding: false,
			cell: ({ row }) => renderSnippet(titleCell, row.original)
		},
		{
			accessorKey: 'institutionName',
			header: 'Учебное заведение',
			meta: { title: 'Учебное заведение' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(nameCell, row.original.institutionName)
		},
		{
			accessorKey: 'customerName',
			header: 'Заказчик',
			meta: { title: 'Заказчик' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(nameCell, row.original.customerName)
		},
		{
			id: 'stage',
			header: 'Стадия',
			meta: { title: 'Стадия' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(stageCell, row.original)
		},
		{
			accessorKey: 'dueAt',
			header: 'Срок',
			meta: { title: 'Срок' },
			cell: ({ row }) => renderSnippet(slaCell, row.original)
		},
		{
			accessorKey: 'ownerName',
			header: 'Ответственный',
			meta: { title: 'Ответственный' },
			enableSorting: false
		},
		{
			accessorKey: 'lastActivityAt',
			header: 'Активность',
			meta: { title: 'Активность', align: 'end' },
			cell: ({ row }) => formatDateTime(row.original.lastActivityAt)
		}
	];

	/**
	 * Колонки, с которых список начинается свёрнутым на ноутбуке.
	 *
	 * Заказчик здесь потому, что взаимодействие ведут с учебным заведением, а
	 * компания за ним у большинства строк одна и та же и в списке ничего не
	 * различает. Ужатая до нечитаемости колонка срока стоит дороже: срок — то,
	 * ради чего список открывают. Меню «Колонки» возвращает любую из них.
	 */
	const HIDDEN_ON_LAPTOP = ['customerName', 'ownerName', 'lastActivityAt'];

	function open(row: InteractionListItem) {
		return goto(resolve('/(app)/interactions/[id=uuid]', { id: row.id }));
	}

	function go(changes: Partial<InteractionFilters>) {
		return goto(filtersHref(page.url, changes), { keepFocus: true, noScroll: true });
	}
</script>

<!-- Наименование организации бывает длиной в строку устава, а колонки справа от
	него важнее: ширина ограничена, целиком читается подсказкой. -->
{#snippet nameCell(value: string | null)}
	{#if value === null}
		<span class="text-faint">—</span>
	{:else}
		<span class="block max-w-48 truncate" title={value}>{value}</span>
	{/if}
{/snippet}

{#snippet titleCell(row: InteractionListItem)}
	<div class="flex max-w-64 min-w-0 flex-col gap-0.5">
		<span class="truncate font-medium">{row.title}</span>
		<span class="flex flex-wrap items-center gap-1">
			{#if row.status !== 'active'}
				<StatusBadge tone={row.status === 'completed' ? 'success' : 'neutral'}>
					{INTERACTION_STATUS_LABELS[row.status]}
				</StatusBadge>
			{/if}
			{#if row.openBlockers > 0}
				<StatusBadge tone="warning" dot>Помех: {row.openBlockers}</StatusBadge>
			{/if}
			{#if row.isStale}
				<StatusBadge tone="neutral" dot title="Давно не было событий">Тишина</StatusBadge>
			{/if}
		</span>
	</div>
{/snippet}

<!-- Колонка стадии ограничена по ширине так же, как колонки организаций: и
	название стадии, и полоса из четырнадцати сегментов растянули бы её на треть
	таблицы, а справа стоит срок — то, ради чего список и открывают. -->
{#snippet stageCell(row: InteractionListItem)}
	{#if row.stage === null}
		<span class="text-faint">не начато</span>
	{:else}
		<div class="flex max-w-40 min-w-0 flex-col gap-1">
			<span class="truncate text-xs text-muted-foreground" title={row.stage.name}>
				{row.stage.name}
			</span>
			<StageTimeline stages={toTimelineStages(row.progress)} compact />
		</div>
	{/if}
{/snippet}

{#snippet slaCell(row: InteractionListItem)}
	{#if row.dueAt === null}
		<span class="text-faint">—</span>
	{:else if row.isPaused}
		<StatusBadge tone="neutral" dot title="Часы стадии остановлены">на паузе</StatusBadge>
	{:else}
		<SlaChip deadline={row.dueAt} />
	{/if}
{/snippet}

<svelte:head>
	<title>Взаимодействия — LCT CRM</title>
</svelte:head>

<PageHeader
	title="Взаимодействия"
	description="Работа с учебными заведениями: где стоит каждое дело и сколько у него осталось времени."
>
	{#snippet actions()}
		<Button href={resolve('/interactions/new')}>
			<PlusIcon aria-hidden="true" />
			Создать взаимодействие
		</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<div class="flex flex-wrap items-center gap-2">
		<label class="flex items-center gap-2 text-sm">
			<span class="text-muted-foreground">Статус</span>
			<select
				class="h-control rounded-md border border-input bg-background px-2 text-sm focus-ring"
				value={data.filters.status ?? ''}
				onchange={(event) =>
					go({
						status:
							event.currentTarget.value === ''
								? null
								: (event.currentTarget.value as InteractionStatus)
					})}
			>
				<option value="">Любой</option>
				{#each Object.entries(INTERACTION_STATUS_LABELS) as [value, label] (value)}
					<option {value}>{label}</option>
				{/each}
			</select>
		</label>

		<label class="flex items-center gap-2 text-sm">
			<span class="text-muted-foreground">Стадия</span>
			<select
				class="h-control rounded-md border border-input bg-background px-2 text-sm focus-ring"
				value={data.filters.stageCategory ?? ''}
				onchange={(event) =>
					go({
						stageCategory:
							event.currentTarget.value === '' ? null : (event.currentTarget.value as StageCategory)
					})}
			>
				<option value="">Любая</option>
				{#each STAGE_CATEGORIES as category (category)}
					<option value={category}>{STAGE_CATEGORY_LABELS[category]}</option>
				{/each}
			</select>
		</label>

		<Button
			variant={data.filters.overdue ? 'default' : 'outline'}
			size="sm"
			aria-pressed={data.filters.overdue}
			onclick={() => go({ overdue: !data.filters.overdue })}
		>
			Просроченные
		</Button>
		<Button
			variant={data.filters.mine ? 'default' : 'outline'}
			size="sm"
			aria-pressed={data.filters.mine}
			onclick={() => go({ mine: !data.filters.mine })}
		>
			Мои
		</Button>
	</div>

	{#if data.total === 0 && !data.isFiltered}
		<div class="rounded-lg border border-border bg-surface">
			<EmptyState
				title="Взаимодействий пока нет"
				description="Заведите первое: выберите учебное заведение, программы и ответственного — маршрут стадий подставится сам."
			>
				{#snippet action()}
					<Button href={resolve('/interactions/new')}>
						<PlusIcon aria-hidden="true" />
						Создать взаимодействие
					</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		<DataTable
			{columns}
			rows={data.rows}
			total={data.total}
			getRowId={(row) => row.id}
			searchPlaceholder="Поиск по названию и организации"
			emptyTitle="Ничего не найдено"
			emptyDescription="Измените запрос или сбросьте фильтры."
			initialHiddenColumns={HIDDEN_ON_LAPTOP}
			onopen={open}
		>
			{#snippet bulkActions({ ids, clear })}
				{#if data.canAssign}
					<Button
						variant="outline"
						size="sm"
						onclick={() => {
							assignIds = ids;
							assignUserId = data.users[0]?.id ?? '';
							assignOpen = true;
							clear();
						}}
					>
						<UserCogIcon aria-hidden="true" />
						Назначить ответственного
					</Button>
				{/if}
			{/snippet}
		</DataTable>
	{/if}
</div>

<Dialog.Root bind:open={assignOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Назначить ответственного</Dialog.Title>
			<Dialog.Description>
				Выбрано взаимодействий: {assignIds.length}. Смена ответственного попадёт в историю каждого
				из них.
			</Dialog.Description>
		</Dialog.Header>

		<form
			method="POST"
			action="?/assign"
			use:enhance={() => {
				return async ({ update }) => {
					assignOpen = false;
					await update();
				};
			}}
			class="flex flex-col gap-4"
		>
			{#each assignIds as id (id)}
				<input type="hidden" name="interactionId" value={id} />
			{/each}

			<label class="flex flex-col gap-1.5 text-sm">
				<span>Ответственный</span>
				<select
					name="userId"
					bind:value={assignUserId}
					class="h-control rounded-md border border-input bg-background px-2 text-sm focus-ring"
				>
					{#each data.users as user (user.id)}
						<option value={user.id}>{user.name} — {user.roleName}</option>
					{/each}
				</select>
			</label>

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (assignOpen = false)}>Отмена</Button>
				<Button type="submit" disabled={assignUserId === ''}>Назначить</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
