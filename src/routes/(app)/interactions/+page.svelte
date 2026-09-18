<script lang="ts">
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import { toast } from 'svelte-sonner';
	import FilterXIcon from '@lucide/svelte/icons/filter-x';
	import KanbanIcon from '@lucide/svelte/icons/kanban';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TableIcon from '@lucide/svelte/icons/table';
	import UserCogIcon from '@lucide/svelte/icons/user-cog';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FilterSelect from '$lib/components/directory/filter-select.svelte';
	import type { FieldOption } from '$lib/components/form/field-select.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import SlaChip from '$lib/components/sla-chip.svelte';
	import StageTimeline from '$lib/components/stage-timeline.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import Board from '$lib/components/interactions/board.svelte';
	import { toTimelineStages } from '$lib/components/interactions/timeline';
	import { filterHref } from '$lib/components/directory/query';
	import {
		INTERACTION_STATUSES,
		PARTY_ROLE_LABELS,
		STAGE_CATEGORIES,
		type InteractionListItem,
		type InteractionViewMode
	} from '$lib/contracts/interactions';
	import { formatDateTime } from '$lib/format';
	import {
		clearedFiltersHref,
		filtersHref,
		INTERACTION_STATUS_LABELS,
		STAGE_CATEGORY_LABELS,
		type InteractionFilters
	} from './filters';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const STATUS_OPTIONS: readonly FieldOption[] = INTERACTION_STATUSES.map((status) => ({
		value: status,
		label: INTERACTION_STATUS_LABELS[status]
	}));

	const STAGE_OPTIONS: readonly FieldOption[] = STAGE_CATEGORIES.map((category) => ({
		value: category,
		label: STAGE_CATEGORY_LABELS[category]
	}));

	let assignOpen = $state(false);
	let assignIds = $state<string[]>([]);
	let assignUserId = $state('');

	// Массовое назначение живёт в таблице: выбирают строки в ней, и в режиме
	// доски выбирать нечего — список ответственных туда не грузится.
	const users = $derived(data.view === 'table' ? data.users : []);

	const assignUserName = $derived.by(() => {
		const user = users.find((candidate) => candidate.id === assignUserId);

		return user === undefined ? 'Выберите ответственного' : `${user.name} — ${user.roleName}`;
	});

	$effect(() => {
		if (form && 'moved' in form) {
			toast.success('Взаимодействие переведено на другую стадию');
		} else if (form && 'assigned' in form) {
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
			header: PARTY_ROLE_LABELS.educational_institution,
			meta: { title: PARTY_ROLE_LABELS.educational_institution },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(nameCell, row.original.institutionName)
		},
		{
			accessorKey: 'customerName',
			header: PARTY_ROLE_LABELS.customer,
			meta: { title: PARTY_ROLE_LABELS.customer },
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
	 * Компания-заказчик здесь потому, что взаимодействие ведут с учебным
	 * заведением, а компания за ним у большинства строк одна и та же и в списке
	 * ничего не различает. Ужатая до нечитаемости колонка срока стоит дороже: срок — то,
	 * ради чего список открывают. Меню «Колонки» возвращает любую из них.
	 */
	const HIDDEN_ON_LAPTOP = ['customerName', 'ownerName', 'lastActivityAt'];

	function open(row: InteractionListItem) {
		return goto(resolve('/(app)/interactions/[id=uuid]', { id: row.id }));
	}

	function go(changes: Partial<InteractionFilters>) {
		return goto(filtersHref(page.url, changes), { keepFocus: true, noScroll: true });
	}

	/**
	 * Представление живёт в адресе рядом с фильтрами: отобранный набор один, и
	 * ссылка на него должна переносить и способ, которым на него смотрят.
	 */
	function viewHref(mode: InteractionViewMode) {
		return filterHref(page.url, 'view', mode === 'board' ? 'board' : '');
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
	<!-- Названия различаются хвостом («…по прикладной информатике» против
		«…прикладная информатика»), поэтому колонке отдано место, которое всё
		равно пустовало справа; что не поместилось — читается подсказкой. -->
	<div class="flex max-w-80 min-w-0 flex-col gap-0.5">
		<span class="truncate font-medium" title={row.title}>{row.title}</span>
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

{#snippet assignAction({ ids, clear }: { ids: string[]; clear: () => void })}
	<Button
		variant="outline"
		size="sm"
		onclick={() => {
			assignIds = ids;
			assignUserId = users[0]?.id ?? '';
			assignOpen = true;
			clear();
		}}
	>
		<UserCogIcon aria-hidden="true" />
		Назначить ответственного
	</Button>
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

{#snippet resetFilters()}
	<Button variant="outline" href={clearedFiltersHref(page.url)}>
		<FilterXIcon aria-hidden="true" />
		Сбросить фильтры
	</Button>
{/snippet}

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<div class="flex flex-wrap items-center gap-3">
		<FilterSelect param="status" label="Статус" options={STATUS_OPTIONS} allLabel="Любой" />
		<FilterSelect param="stage" label="Стадия" options={STAGE_OPTIONS} allLabel="Любая" />

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

		<!-- Поиск принадлежит таблице и живёт в её строке поиска; на доске такой
			строки нет, поэтому унаследованный из адреса запрос показан рядом с
			фильтрами — иначе отобранный набор нечем было бы объяснить и снять. -->
		{#if data.view === 'board' && data.search !== ''}
			<span class="flex items-center gap-1 text-xs text-muted-foreground">
				Поиск: «{data.search}»
				<Button href={filterHref(page.url, 'q', '')} variant="ghost" size="xs">Сбросить</Button>
			</span>
		{/if}

		<!-- Представление — часть адреса: ссылкой на список делятся вместе с тем,
			каким его смотрели. -->
		<div class="ms-auto flex items-center gap-1" role="group" aria-label="Представление">
			<Button
				href={viewHref('table')}
				variant={data.view === 'table' ? 'default' : 'outline'}
				size="sm"
				aria-current={data.view === 'table' ? 'page' : undefined}
			>
				<TableIcon aria-hidden="true" />
				Таблица
			</Button>
			<Button
				href={viewHref('board')}
				variant={data.view === 'board' ? 'default' : 'outline'}
				size="sm"
				aria-current={data.view === 'board' ? 'page' : undefined}
			>
				<KanbanIcon aria-hidden="true" />
				Доска
			</Button>
		</div>
	</div>

	<!-- `data-tour` — метка для подсказок первого входа (`$lib/onboarding/steps`). -->
	<div data-tour="interactions-list" class="min-w-0">
		{#if data.view === 'board'}
			<Board board={data.board} canTransition={data.canTransition} isFiltered={data.isFiltered} />
		{:else if data.total === 0 && !data.isFiltered}
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
			<!-- Чекбоксы появляются только там, где выделению есть что делать:
			назначить ответственного может не всякая роль, а выделение без
			единого действия обещает работу, которой нет. -->
			<DataTable
				{columns}
				rows={data.rows}
				total={data.total}
				getRowId={(row) => row.id}
				searchPlaceholder="Поиск по названию и организации"
				emptyTitle="Ничего не найдено"
				emptyDescription="Под этот запрос и отбор не попало ни одной записи."
				emptyAction={data.isFiltered ? resetFilters : undefined}
				initialHiddenColumns={HIDDEN_ON_LAPTOP}
				defaultSort={{ columnId: 'dueAt', direction: 'asc' }}
				bulkActions={data.canAssign ? assignAction : undefined}
				onopen={open}
			/>
		{/if}
	</div>
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

			<div class="flex flex-col gap-1.5">
				<Label for="assignUserId">Ответственный</Label>
				<Select.Root type="single" name="userId" bind:value={assignUserId}>
					<Select.Trigger id="assignUserId" class="w-full">{assignUserName}</Select.Trigger>
					<Select.Content>
						{#each users as user (user.id)}
							<Select.Item value={user.id} label="{user.name} — {user.roleName}" />
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (assignOpen = false)}>Отмена</Button>
				<Button type="submit" disabled={assignUserId === ''}>Назначить</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
