<script lang="ts">
	import { renderSnippet, type ColumnDef, type SvelteTable } from '@tanstack/svelte-table';
	import { toast } from 'svelte-sonner';
	import FunnelXIcon from '@lucide/svelte/icons/funnel-x';
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
	import ColumnsMenu from '$lib/components/data-table/columns-menu.svelte';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import EmptyState from '$lib/components/empty-state.svelte';
	import Header from '$lib/components/header.svelte';
	import SlaChip from '$lib/components/sla-chip.svelte';
	import StageTimeline from '$lib/components/stage-timeline.svelte';
	import StatusBadge, { type StatusTone } from '$lib/components/status-badge.svelte';
	import Board from '$lib/components/interactions/board.svelte';
	import FilterBar from '$lib/components/filters/filter-bar.svelte';
	import type { StripFilter } from '$lib/components/filters/filter-strip.svelte';
	import ActiveSlices, { type ActiveSlice } from '$lib/components/filters/active-slices.svelte';
	import OwnerFilter from '$lib/components/interactions/owner-filter.svelte';
	import { toTimelineStages } from '$lib/components/interactions/timeline';
	import { filterHref } from '$lib/components/directory/query';
	import {
		INTERACTION_LIST_STATE_LABELS,
		INTERACTION_LIST_STATES,
		INTERACTION_STATUSES,
		PARTY_ROLE_LABELS,
		STAGE_CATEGORIES,
		type InteractionFilterOption,
		type InteractionListItem,
		type InteractionListState,
		type InteractionStatus,
		type InteractionViewMode,
		type StageCategory
	} from '$lib/contracts/interactions';
	import {
		MY_DAY_INTERACTION_KINDS,
		MY_DAY_SECTIONS,
		type MyDayInteractionKind
	} from '$lib/contracts/my-day';
	import { formatDateTime, pluralize } from '$lib/format';
	import { cn } from '$lib/utils';
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

	const STATUS_OPTIONS: readonly InteractionFilterOption[] = INTERACTION_STATUSES.map((status) => ({
		value: status,
		label: INTERACTION_STATUS_LABELS[status]
	}));

	const STAGE_OPTIONS: readonly InteractionFilterOption[] = STAGE_CATEGORIES.map((category) => ({
		value: category,
		label: STAGE_CATEGORY_LABELS[category]
	}));

	const STATE_OPTIONS: readonly InteractionFilterOption[] = INTERACTION_LIST_STATES.map(
		(state) => ({ value: state, label: INTERACTION_LIST_STATE_LABELS[state] })
	);

	const DAY_OPTIONS: readonly InteractionFilterOption[] = MY_DAY_INTERACTION_KINDS.map((kind) => ({
		value: kind,
		label: MY_DAY_SECTIONS[kind].title
	}));

	/** Окно «закрыты за N дней», которое включает переключатель, — как у плитки главной. */
	const CLOSED_WINDOW_DAYS = 30;

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

	/**
	 * Как назвать сторону в колонке и фильтре — по тому, с кем работает
	 * пространство: «Вуз» у учебных заведений, «Компания» и «Физлицо» у
	 * коммерческого обучения, «Контрагент», когда видов несколько. Основная
	 * сторона коммерческого обучения записана заказчиком, поэтому там одна
	 * колонка стороны — по заказчику, а колонки учебного заведения нет.
	 */
	const institutionSpace = $derived(
		data.counterpartyKinds.length === 1 && data.counterpartyKinds[0] === 'educational_institution'
	);
	const partyLabel = $derived.by(() => {
		if (data.counterpartyKinds.length !== 1) return 'Контрагент';

		const [kind] = data.counterpartyKinds;

		return kind === 'educational_institution'
			? 'Вуз'
			: kind === 'individual'
				? 'Физлицо'
				: 'Компания';
	});

	const partyColumns = $derived<ColumnDef<DataTableFeatures, InteractionListItem>[]>(
		institutionSpace
			? [
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
					}
				]
			: [
					{
						// У вузовского дела в смешанном пространстве сторона — вуз.
						id: 'party',
						header: partyLabel,
						meta: { title: partyLabel },
						enableSorting: false,
						cell: ({ row }) =>
							renderSnippet(nameCell, row.original.institutionName ?? row.original.customerName)
					}
				]
	);

	const columns: ColumnDef<DataTableFeatures, InteractionListItem>[] = $derived([
		{
			accessorKey: 'title',
			header: 'Взаимодействие',
			meta: { title: 'Взаимодействие' },
			enableHiding: false,
			cell: ({ row }) => renderSnippet(titleCell, row.original)
		},
		...partyColumns,
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
	]);

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

	/** Ключ пространства стоит в адресе, и все ссылки раздела считаются от него. */
	const workspace = $derived(data.workspace.key);

	/**
	 * Таблица на экране — и у неё есть колонки, которые можно выбрать. Меню
	 * «Колонки» стоит не в панели списка, а в ряду отборов рядом с
	 * переключателем вида (`columnsMenu={false}` и `ontable`): отдельная
	 * строка ради одной кнопки отнимала у таблицы высоту первого экрана.
	 */
	const tableShown = $derived(data.view === 'table' && (data.total > 0 || data.isFiltered));
	let tableApi = $state<SvelteTable<DataTableFeatures, InteractionListItem> | null>(null);
	const newHref = $derived(resolve('/(app)/w/[workspace]/interactions/new', { workspace }));

	/**
	 * Почему завести дело нельзя; `null` — можно. Без назначенного или без
	 * описанного процесса стадии, на которую встанет запись, не существует, и
	 * кнопка говорит об этом, а не падает в конце заполненной формы.
	 */
	const createBlocked = $derived(
		data.process === null
			? 'Пространству не назначен процесс'
			: data.process.described
				? null
				: `В процессе «${data.process.name}» ещё нет стадий`
	);

	function open(row: InteractionListItem) {
		return goto(resolve('/(app)/w/[workspace]/interactions/[id=uuid]', { workspace, id: row.id }));
	}

	function go(changes: Partial<InteractionFilters>) {
		return goto(filtersHref(page.url, workspace, changes), { keepFocus: true, noScroll: true });
	}

	/**
	 * Добавляет или снимает одно значение многозначного фильтра: вуз, направление,
	 * программа, продукт, ответственный.
	 */
	function toggleAttr(param: ListAttributeParam, value: string) {
		void goto(toggledFilterHref(page.url, workspace, param, value), {
			keepFocus: true,
			noScroll: true
		});
	}

	/**
	 * Одиночный фильтр в том же дропдауне, что и многозначные: выбранный пункт
	 * снимается повторным нажатием, другой — заменяет прежний.
	 */
	function pickStatus(value: InteractionStatus) {
		void go({ status: data.filters.status === value ? null : value });
	}

	function pickStage(value: StageCategory) {
		void go({ stageCategory: data.filters.stageCategory === value ? null : value });
	}

	function pickState(value: InteractionListState) {
		void go({ state: data.filters.state === value ? null : value });
	}

	function pickDay(value: MyDayInteractionKind) {
		void go({ day: data.filters.day === value ? null : value });
	}

	/**
	 * Фильтры ленты по порядку важности: не поместившиеся по ширине уходят с
	 * конца в панель под воронкой (`filter-strip.svelte`). Стадии на доске нет —
	 * колонки и есть стадии (сервер параметр там тоже не читает).
	 */
	const stripFilters = $derived.by((): StripFilter[] => {
		const list = (
			key: 'org' | 'dir' | 'prog' | 'prod',
			label: string,
			options: readonly InteractionFilterOption[]
		): StripFilter => ({
			kind: 'list',
			key,
			label,
			options,
			selected: data.filters[key],
			testId: `interactions-filter-${key}`,
			ontoggle: (value) => toggleAttr(key, value)
		});

		return [
			{
				kind: 'list',
				key: 'status',
				label: 'Статус',
				options: STATUS_OPTIONS,
				selected: data.filters.status === null ? [] : [data.filters.status],
				single: true,
				testId: 'interactions-filter-status',
				ontoggle: (value) => pickStatus(value as InteractionStatus)
			},
			...(data.view === 'table'
				? [
						{
							kind: 'list',
							key: 'stage',
							label: 'Стадия',
							options: STAGE_OPTIONS,
							selected: data.filters.stageCategory === null ? [] : [data.filters.stageCategory],
							single: true,
							testId: 'interactions-filter-stage',
							ontoggle: (value: string) => pickStage(value as StageCategory)
						} satisfies StripFilter
					]
				: []),
			list('org', partyLabel, data.filterOptions.organizations),
			list('dir', 'Направление', data.filterOptions.directions),
			list('prog', 'Программа', data.filterOptions.programs),
			list('prod', 'Продукт', data.filterOptions.products),
			{
				kind: 'toggle',
				key: 'overdue',
				label: 'Просроченные',
				active: data.filters.overdue,
				testId: 'interactions-filter-overdue',
				ontoggle: () => void go({ overdue: !data.filters.overdue })
			},
			// Состояние, раздел «Моего дня» и окно закрытия — только у таблицы:
			// на них ведут числа главной, а доска показывает не каждую запись.
			...(data.view === 'table'
				? ([
						{
							kind: 'list',
							key: 'state',
							label: 'Состояние',
							options: STATE_OPTIONS,
							selected: data.filters.state === null ? [] : [data.filters.state],
							single: true,
							testId: 'interactions-filter-state',
							ontoggle: (value: string) => pickState(value as InteractionListState)
						},
						{
							kind: 'list',
							key: 'day',
							label: 'Мой день',
							options: DAY_OPTIONS,
							selected: data.filters.day === null ? [] : [data.filters.day],
							single: true,
							testId: 'interactions-filter-day',
							ontoggle: (value: string) => pickDay(value as MyDayInteractionKind)
						},
						{
							kind: 'toggle',
							key: 'closed',
							label: `Закрыты за ${pluralize(data.filters.closedWithin ?? CLOSED_WINDOW_DAYS, ['день', 'дня', 'дней'])}`,
							active: data.filters.closedWithin !== null,
							testId: 'interactions-filter-closed',
							ontoggle: () =>
								void go({
									closedWithin: data.filters.closedWithin === null ? CLOSED_WINDOW_DAYS : null
								})
						}
					] satisfies StripFilter[])
				: [])
		];
	});

	/**
	 * Срезы, на которые ведут числа главной, — меткой над списком: в ряду
	 * отборов они стоят последними и на узком экране уходят в «Ещё фильтры».
	 */
	const activeSlices = $derived.by((): ActiveSlice[] => {
		if (data.view !== 'table') {
			return [];
		}

		const slices: ActiveSlice[] = [];
		const { day, state, closedWithin } = data.filters;

		if (day !== null) {
			slices.push({
				key: 'day',
				label: `Мой день: ${MY_DAY_SECTIONS[day].title.toLowerCase()}`,
				removeHref: filtersHref(page.url, workspace, { day: null })
			});
		}

		if (state !== null) {
			slices.push({
				key: 'state',
				label: `Состояние: ${INTERACTION_LIST_STATE_LABELS[state].toLowerCase()}`,
				removeHref: filtersHref(page.url, workspace, { state: null })
			});
		}

		if (closedWithin !== null) {
			slices.push({
				key: 'closed',
				label: `Закрыты за ${pluralize(closedWithin, ['день', 'дня', 'дней'])}`,
				removeHref: filtersHref(page.url, workspace, { closedWithin: null })
			});
		}

		return slices;
	});

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
	// в следующий раз раздел откроется им же (`view-preference.ts`). Кроме
	// таблицы в пространстве без процесса: её выбрал не человек, а сервер.
	$effect(() => {
		if (data.rememberView) storeView(data.view);
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
		<!-- Без описанного процесса заводить нечем: стадии, на которую встанет
			запись, не существует. Кнопка недоступна и называет причину — иначе
			форма заполнялась бы целиком и отказывала только при сохранении. -->
		{#if createBlocked === null}
			<Button href={newHref}>
				<PlusIcon aria-hidden="true" />
				Создать взаимодействие
			</Button>
		{:else}
			<Button disabled title={createBlocked} aria-describedby="create-blocked">
				<PlusIcon aria-hidden="true" />
				Создать взаимодействие
			</Button>
			<span id="create-blocked" class="sr-only">{createBlocked}</span>
		{/if}
	{/snippet}
</Header>

<!-- Представление — часть адреса: ссылкой на список делятся вместе с тем,
	каким его смотрели. Переключатель стоит в конце ряда отборов и у таблицы, и
	у доски.

	Ниже `2xl` у вариантов остаются одни значки: с подписями переключатель
	отнимал у ряда место ещё под два фильтра, а на телефоне не влезал во вторую
	строку рядом с фильтрами. Подпись тогда остаётся читалке и подсказке под
	курсором. Слева от переключателя в таблице — меню «Колонки», тоже значком.
	-->
{#snippet endControls()}
	<div class="flex shrink-0 items-center gap-2">
		{#if tableShown}
			<ColumnsMenu table={tableApi} labelClass="max-2xl:sr-only" title="Колонки" />
		{/if}
		{@render viewSwitch()}
	</div>
{/snippet}

{#snippet viewSwitch()}
	<SegmentedControl.LinkGroup aria-label="Представление" class="shrink-0 flex-nowrap">
		<SegmentedControl.Link
			href={viewHref('table')}
			current={data.view === 'table'}
			title="Таблица"
			aria-label="Таблица"
		>
			<TableIcon aria-hidden="true" />
			<span class="max-2xl:sr-only">Таблица</span>
		</SegmentedControl.Link>
		<SegmentedControl.Link
			href={viewHref('board')}
			current={data.view === 'board'}
			title="Доска"
			aria-label="Доска"
		>
			<KanbanIcon aria-hidden="true" />
			<span class="max-2xl:sr-only">Доска</span>
		</SegmentedControl.Link>
	</SegmentedControl.LinkGroup>
{/snippet}

{#snippet resetFilters()}
	<Button variant="outline" href={clearedFiltersHref(page.url, workspace)}>
		<FunnelXIcon aria-hidden="true" />
		Сбросить фильтры
	</Button>
{/snippet}

<!-- Доска с `sm` занимает остаток экрана под отборами: оболочка ограничивает
	страницу ростом экрана, а эта колонка и обёртка списка передают остаток
	доске (`board.svelte`). Таблица растёт по строкам, как раньше. -->
<div
	class={cn(
		'flex flex-col gap-4 p-4 sm:px-9 sm:py-6',
		data.view === 'board' && 'sm:min-h-0 sm:flex-1 sm:gap-3 sm:py-4'
	)}
>
	<!-- Ряд отборов: поиск, ответственные, фильтры, переключатель вида
		(`filter-bar.svelte`). Сброс снимает всё разом: фильтры, ответственных и
		поиск (`clearedFiltersHref`). -->
	<FilterBar
		data-tour="interactions-filters"
		testId="interactions"
		search={{
			value: data.search,
			placeholder: 'Поиск по названию и организации',
			onsearch: (value) =>
				void goto(filterHref(page.url, 'q', value), { keepFocus: true, noScroll: true })
		}}
		filters={stripFilters}
		clearHref={data.isFiltered ? clearedFiltersHref(page.url, workspace) : null}
		end={endControls}
	>
		{#snippet lead()}
			<OwnerFilter
				options={data.filterOptions.owners}
				selected={data.filters.owner}
				currentUser={data.user ?? null}
				ontoggle={(value) => toggleAttr('owner', value)}
			/>
		{/snippet}
	</FilterBar>

	<ActiveSlices slices={activeSlices} testId="interactions-slices" />

	<!-- `data-tour` — метка подсказок: рамка встаёт вокруг списка целиком —
		и таблицы, и доски (`$lib/onboarding/screens`). -->
	<div
		data-tour="interactions-list"
		class={cn('min-w-0', data.view === 'board' && 'sm:flex sm:min-h-0 sm:flex-1 sm:flex-col')}
	>
		{#if data.view === 'board'}
			<Board
				board={data.board}
				canTransition={data.canTransition}
				isFiltered={data.isFiltered}
				workspaceKey={workspace}
				process={data.process}
				canConfigure={data.canConfigure}
			/>
		{:else if data.total === 0 && !data.isFiltered}
			<div class="rounded-lg border border-border bg-surface">
				<EmptyState
					title="Взаимодействий пока нет"
					description={createBlocked === null
						? 'Заведите первое: выберите учебное заведение, программы и ответственного — маршрут стадий подставится сам.'
						: `${createBlocked}: завести дело пока нельзя. ${
								!data.canConfigure
									? 'Процесс настраивает администратор.'
									: data.process === null
										? 'Назначьте процесс в «Настройки → Пространства».'
										: 'Опишите его в «Настройки → Процессы».'
							}`}
				>
					{#snippet action()}
						{#if createBlocked === null}
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
				emptyTitle="Ничего не найдено"
				emptyDescription="Под этот запрос и отбор не попало ни одной записи."
				emptyAction={data.isFiltered ? resetFilters : undefined}
				initialHiddenColumns={SECONDARY_COLUMNS}
				stacked
				defaultSort={{ columnId: 'dueAt', direction: 'asc' }}
				bulkActions={data.canAssign ? assignAction : undefined}
				onopen={open}
				columnsMenu={false}
				ontable={(table) => (tableApi = table)}
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
