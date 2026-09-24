<script lang="ts">
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import { toast } from 'svelte-sonner';
	import FilterXIcon from '@lucide/svelte/icons/filter-x';
	import ListFilterIcon from '@lucide/svelte/icons/list-filter';
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
	import * as SegmentedControl from '$lib/components/ui/segmented-control/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FilterSelect from '$lib/components/directory/filter-select.svelte';
	import type { FieldOption } from '$lib/components/form/field-select.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import Header from '$lib/components/header.svelte';
	import SlaChip from '$lib/components/sla-chip.svelte';
	import StageTimeline from '$lib/components/stage-timeline.svelte';
	import StatusBadge, { type StatusTone } from '$lib/components/status-badge.svelte';
	import Board from '$lib/components/interactions/board.svelte';
	import ListFilter from '$lib/components/interactions/list-filter.svelte';
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
		toggledFilterHref,
		type InteractionFilters,
		type ListAttributeParam
	} from './filters';
	import { storeView } from './view-preference';
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
			meta: { title: 'Стадия', stackInline: true },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(stageCell, row.original)
		},
		{
			accessorKey: 'dueAt',
			header: 'Срок',
			meta: { title: 'Срок', stackInline: true },
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
	 * Колонки, которые уступают место, когда список не помещается, — в том
	 * порядке, в каком их не жалко. На телефоне их нет с самого начала: блок
	 * записи — это название, вуз, стадия и срок.
	 *
	 * Компания-заказчик первая потому, что взаимодействие ведут с учебным
	 * заведением, а компания за ним у большинства строк одна и та же и в списке
	 * ничего не различает. Ужатая до нечитаемости колонка срока стоит дороже:
	 * срок — то, ради чего список открывают. Меню «Колонки» возвращает любую.
	 */
	const SECONDARY_COLUMNS = ['customerName', 'lastActivityAt', 'ownerName'];

	/**
	 * Почему на запись стоит посмотреть, кроме срока, — одной меткой. Помеха и
	 * тишина вокруг записи — две стороны одного «застряло», и две плашки под
	 * каждым вторым названием превращали список в пёструю ленту.
	 *
	 * Тишина — самый слабый из признаков: у просроченной записи или записи с
	 * помехой она ничего не добавляет к уже красной или жёлтой метке, а на
	 * каждой строке перестаёт различать строки. Поэтому своей меткой она
	 * выходит только там, где больше ничего не горит, а рядом с помехой
	 * остаётся в подсказке.
	 */
	function attentionOf(
		row: InteractionListItem
	): { tone: StatusTone; label: string; hint: string } | null {
		const blocked = row.openBlockers > 0;

		if (blocked) {
			return {
				tone: 'warning',
				label: `Помех: ${row.openBlockers}`,
				hint: [`Открытых помех: ${row.openBlockers}`, row.isStale ? 'давно не было событий' : null]
					.filter((hint) => hint !== null)
					.join('; ')
			};
		}

		if (row.isStale && !row.isOverdue) {
			return { tone: 'neutral', label: 'Тишина', hint: 'Давно не было событий' };
		}

		return null;
	}

	/** Сколько отборов включено — число на кнопке «Фильтры» на телефоне. */
	const activeFilters = $derived(
		[
			data.filters.status !== null,
			data.filters.stageCategory !== null,
			data.filters.overdue,
			data.filters.mine,
			data.filters.org.length > 0,
			data.filters.dir.length > 0,
			data.filters.prog.length > 0,
			data.filters.prod.length > 0,
			data.view === 'board' && data.search !== ''
		].filter(Boolean).length
	);

	let filtersOpen = $state(false);

	/** Таблица со своей строкой поиска — туда встаёт переключатель вида. */
	const showsTable = $derived(data.view === 'table' && (data.total > 0 || data.isFiltered));

	/** Ключ пространства стоит в адресе, и все ссылки раздела считаются от него. */
	const workspace = $derived(data.workspace.key);
	const newHref = $derived(resolve('/(app)/w/[workspace]/interactions/new', { workspace }));

	function open(row: InteractionListItem) {
		return goto(resolve('/(app)/w/[workspace]/interactions/[id=uuid]', { workspace, id: row.id }));
	}

	function go(changes: Partial<InteractionFilters>) {
		return goto(filtersHref(page.url, workspace, changes), { keepFocus: true, noScroll: true });
	}

	/** Добавляет или снимает одно значение многозначного фильтра: вуз, направление, программа, продукт. */
	function toggleAttr(param: ListAttributeParam, value: string) {
		void goto(toggledFilterHref(page.url, workspace, param, value), {
			keepFocus: true,
			noScroll: true
		});
	}

	/**
	 * Представление живёт в адресе рядом с фильтрами: отобранный набор один, и
	 * ссылка на него должна переносить и способ, которым на него смотрят.
	 *
	 * Оба значения пишутся в адрес явно, и таблица тоже: адрес без параметра
	 * теперь значит не «таблица», а «как обычно» — то представление, которое
	 * человек выбрал в прошлый раз.
	 */
	function viewHref(mode: InteractionViewMode) {
		return filterHref(page.url, 'view', mode);
	}

	// Показанное представление и есть выбор человека — и на него запоминается:
	// в следующий раз раздел откроется им же (`view-preference.ts`).
	$effect(() => {
		storeView(data.view);
	});
</script>

<!-- Наименование организации бывает длиной в строку устава, а колонки справа от
	него важнее: ширина ограничена, целиком читается подсказкой. В блоке на
	телефоне ему отдана вся строка. -->
{#snippet nameCell(value: string | null)}
	{#if value === null}
		<span class="text-faint">—</span>
	{:else}
		<span
			class="block max-w-48 truncate max-sm:max-w-none max-sm:text-xs max-sm:text-muted-foreground"
			title={value}>{value}</span
		>
	{/if}
{/snippet}

{#snippet titleCell(row: InteractionListItem)}
	<!-- Названия различаются хвостом («…по прикладной информатике» против
		«…прикладная информатика»), поэтому они переносятся на вторую строку, а
		не обрезаются на первой; нижняя граница ширины не даёт таблице сжать
		название в столбик раньше, чем уступят место второстепенные колонки. -->
	<div
		class="flex max-w-80 min-w-60 flex-col gap-1 whitespace-normal max-sm:max-w-none max-sm:min-w-0"
	>
		<span class="line-clamp-2 font-medium" title={row.title}>{row.title}</span>
		{#if row.status !== 'active'}
			<StatusBadge tone={row.status === 'completed' ? 'success' : 'neutral'} class="self-start">
				{INTERACTION_STATUS_LABELS[row.status]}
			</StatusBadge>
		{/if}
	</div>
{/snippet}

<!-- Колонка стадии ограничена по ширине так же, как колонки организаций: и
	название стадии, и полоса из четырнадцати сегментов растянули бы её на треть
	таблицы, а справа стоит срок — то, ради чего список и открывают. -->
{#snippet stageCell(row: InteractionListItem)}
	{#if row.stage === null}
		<span class="text-faint">не начато</span>
	{:else}
		<div class="flex max-w-40 min-w-0 flex-col gap-1 max-sm:w-36">
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

<!-- Срок и то, что ещё требует внимания, стоят вместе: всё, из-за чего за
	запись берутся сейчас, читается в одной колонке, а под названием остаётся
	только само название. -->
{#snippet slaCell(row: InteractionListItem)}
	{@const attention = attentionOf(row)}
	<div class="flex flex-col items-start gap-1">
		{#if row.dueAt === null}
			<span class="text-faint">—</span>
		{:else if row.isPaused}
			<StatusBadge tone="neutral" dot title="Часы стадии остановлены">на паузе</StatusBadge>
		{:else}
			<SlaChip deadline={row.dueAt} />
		{/if}
		{#if attention !== null}
			<StatusBadge tone={attention.tone} dot title={attention.hint}>
				{attention.label}
			</StatusBadge>
		{/if}
	</div>
{/snippet}

<svelte:head>
	<title>Взаимодействия — Альма CRM</title>
</svelte:head>

<Header
	title="Взаимодействия"
	description="{data.workspace.name}: где стоит каждое дело и сколько у него осталось времени."
>
	{#snippet actions()}
		<!-- В пространстве без назначенного процесса заводить нечего: стадии, на
			которую встанет запись, не существует. Кнопки нет вовсе — предложить
			действие и отказать в нём хуже, чем не предлагать. -->
		{#if data.workspace.hasWorkflow}
			<Button href={newHref}>
				<PlusIcon aria-hidden="true" />
				Создать взаимодействие
			</Button>
		{/if}
	{/snippet}
</Header>

<!-- Представление — часть адреса: ссылкой на список делятся вместе с тем,
	каким его смотрели. В таблице переключатель стоит в строке поиска рядом с
	«Колонками»: над списком остаются две строки контролов, а не три. -->
{#snippet viewSwitch()}
	<SegmentedControl.LinkGroup aria-label="Представление">
		<SegmentedControl.Link href={viewHref('table')} current={data.view === 'table'}>
			<TableIcon aria-hidden="true" />
			Таблица
		</SegmentedControl.Link>
		<SegmentedControl.Link href={viewHref('board')} current={data.view === 'board'}>
			<KanbanIcon aria-hidden="true" />
			Доска
		</SegmentedControl.Link>
	</SegmentedControl.LinkGroup>
{/snippet}

{#snippet resetFilters()}
	<Button variant="outline" href={clearedFiltersHref(page.url, workspace)}>
		<FilterXIcon aria-hidden="true" />
		Сбросить фильтры
	</Button>
{/snippet}

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<!-- На телефоне отборы свёрнуты в панель за кнопкой «Фильтры»: восемь
		контролов занимали весь первый экран, и до самого списка надо было
		листать. С `sm` обёртка панели исчезает из раскладки (`contents`), и
		отборы стоят в общем ряду, как стояли. Цели нажатия на телефоне — 44 px. -->
	<div
		class="flex flex-wrap items-center gap-3 max-sm:[&_a]:min-h-11 max-sm:[&_button]:min-h-11"
		data-tour="interactions-filters"
	>
		<Button
			variant={activeFilters > 0 ? 'secondary' : 'outline'}
			class="sm:hidden"
			aria-expanded={filtersOpen}
			aria-controls="interactions-filter-panel"
			onclick={() => (filtersOpen = !filtersOpen)}
		>
			<ListFilterIcon aria-hidden="true" />
			Фильтры{activeFilters > 0 ? ` (${activeFilters})` : ''}
		</Button>

		<div
			id="interactions-filter-panel"
			class="{filtersOpen
				? 'flex'
				: 'hidden'} order-last w-full flex-wrap items-center gap-3 sm:order-none sm:contents"
		>
			<FilterSelect param="status" label="Статус" options={STATUS_OPTIONS} allLabel="Любой" />
			<FilterSelect param="stage" label="Стадия" options={STAGE_OPTIONS} allLabel="Любая" />
			<ListFilter
				label="Вуз"
				options={data.filterOptions.organizations}
				selected={data.filters.org}
				testId="interactions-filter-org"
				ontoggle={(value) => toggleAttr('org', value)}
			/>
			<ListFilter
				label="Направление"
				options={data.filterOptions.directions}
				selected={data.filters.dir}
				testId="interactions-filter-dir"
				ontoggle={(value) => toggleAttr('dir', value)}
			/>
			<ListFilter
				label="Программа"
				options={data.filterOptions.programs}
				selected={data.filters.prog}
				testId="interactions-filter-prog"
				ontoggle={(value) => toggleAttr('prog', value)}
			/>
			<ListFilter
				label="Продукт"
				options={data.filterOptions.products}
				selected={data.filters.prod}
				testId="interactions-filter-prod"
				ontoggle={(value) => toggleAttr('prod', value)}
			/>

			<Button
				variant={data.filters.overdue ? 'selected' : 'outline'}
				aria-pressed={data.filters.overdue}
				onclick={() => go({ overdue: !data.filters.overdue })}
			>
				Просроченные
			</Button>
			<Button
				variant={data.filters.mine ? 'selected' : 'outline'}
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
		</div>

		<!-- Без таблицы (доска, пустой раздел) строки поиска нет, и переключатель
			встаёт в конец строки отборов. -->
		{#if !showsTable}
			<div class="ms-auto">{@render viewSwitch()}</div>
		{/if}
	</div>

	<!-- `data-tour` — метка подсказок: рамка встаёт вокруг списка целиком —
		и таблицы, и доски (`$lib/onboarding/screens`). -->
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
						{#if data.workspace.hasWorkflow}
							<Button href={newHref}>
								<PlusIcon aria-hidden="true" />
								Создать взаимодействие
							</Button>
						{/if}
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
				initialHiddenColumns={SECONDARY_COLUMNS}
				stacked
				defaultSort={{ columnId: 'dueAt', direction: 'asc' }}
				bulkActions={data.canAssign ? assignAction : undefined}
				toolbar={viewSwitch}
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
