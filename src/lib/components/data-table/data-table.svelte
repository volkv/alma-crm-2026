<script lang="ts" generics="TData extends RowData">
	import { untrack, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		createTable,
		FlexRender,
		type ColumnDef,
		type ColumnVisibilityState,
		type RowData,
		type RowSelectionState
	} from '@tanstack/svelte-table';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import Columns3Icon from '@lucide/svelte/icons/columns-3';
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { formatNumber } from '$lib/format';
	import { cn } from '$lib/utils';
	import EmptyState from '../empty-state.svelte';
	import { features, type DataTableFeatures } from './features';
	import { PAGE_SIZES, readTableQuery, tableHref, type SortDirection } from './query';

	/**
	 * The list view of the product: one page of rows the server has already
	 * filtered, sorted and sliced, plus the controls that ask it for a different
	 * one. Every such control writes to the query string and navigates, so a
	 * list is always a link — nothing about what the user is looking at lives
	 * only in memory.
	 *
	 * The component never fetches. The page's `load` reads the query with
	 * `readTableQuery`, returns `rows` and `total`, and the table renders them.
	 *
	 * Keyboard: `↑`/`↓` or `k`/`j` move between rows, `Enter` opens the active
	 * row, `/` jumps to the search box.
	 */
	let {
		columns,
		rows,
		total,
		getRowId,
		loading = false,
		searchPlaceholder,
		emptyTitle = 'Ничего не найдено',
		emptyDescription,
		emptyAction,
		initialHiddenColumns = [],
		defaultSort,
		onopen,
		bulkActions,
		class: className
	}: {
		columns: ColumnDef<DataTableFeatures, TData>[];
		/** The current page of rows, in the order they should be shown. */
		rows: TData[];
		/** How many rows match the query in total, across all pages. */
		total: number;
		/** Stable identity of a row — selection survives paging on it. */
		getRowId: (row: TData) => string;
		loading?: boolean;
		/** Omit to hide the search box for a list that is not searchable. */
		searchPlaceholder?: string;
		emptyTitle?: string;
		emptyDescription?: string;
		/**
		 * Действие в пустом состоянии — обычно «Сбросить фильтры». Совет снять
		 * отбор без кнопки, которая его снимает, заставляет человека собирать
		 * адрес руками: список отобран ссылкой, и снимать отбор должна ссылка.
		 */
		emptyAction?: Snippet;
		/**
		 * Columns that start hidden on a narrow screen — the ones a reader can
		 * live without when the important ones would otherwise be cut off. The
		 * menu overrides this: the choice is the reader's, the width only decides
		 * where the list starts.
		 */
		initialHiddenColumns?: readonly string[];
		/**
		 * Порядок, в котором сервер отдаёт список, пока в адресе не сказано
		 * иного. Заголовок обязан называть его вслух: страница, отсортированная
		 * сервером, но подписанная «не отсортировано», врёт о том, почему строки
		 * лежат именно так.
		 */
		defaultSort?: { columnId: string; direction?: SortDirection };
		/** Opening a row: a click, `Enter`, or a double click. */
		onopen?: (row: TData) => void;
		/** Actions over the selected rows; selection is off when this is absent. */
		bulkActions?: Snippet<[{ ids: string[]; clear: () => void }]>;
		class?: string;
	} = $props();

	/**
	 * Ширина окна, ниже которой второстепенные колонки стартуют скрытыми:
	 * подрезанная справа таблица врёт о данных сильнее, чем честно спрятанная
	 * колонка. Это порог удобства, а не обещание, что выше него поместится всё:
	 * сколько места нужно списку, решают его собственные колонки и данные в них.
	 */
	const WIDE_VIEWPORT = 1440;

	const query = $derived(readTableQuery(page.url));
	const selectable = $derived(Boolean(bulkActions));
	/** Порядок, который сейчас на экране: из адреса, а без него — умолчание. */
	const sort = $derived<{ columnId: string; direction: SortDirection } | null>(
		query.sortBy === null
			? defaultSort === undefined
				? null
				: { columnId: defaultSort.columnId, direction: defaultSort.direction ?? 'asc' }
			: { columnId: query.sortBy, direction: query.sortDirection }
	);

	let rowSelection = $state<RowSelectionState>({});
	let columnVisibility = $state<ColumnVisibilityState>({});
	let searchInput = $state<HTMLElement | null>(null);
	let tableRoot = $state<HTMLElement | null>(null);
	let activeIndex = $state(-1);

	/**
	 * Ширину окна знает только браузер, поэтому стартовая видимость ставится
	 * после гидратации и ровно один раз: дальше видимостью распоряжается
	 * человек, и менять её за ним при повороте экрана нельзя.
	 */
	let widthApplied = false;

	$effect(() => {
		if (widthApplied || initialHiddenColumns.length === 0) return;

		widthApplied = true;

		if (window.innerWidth < WIDE_VIEWPORT) {
			columnVisibility = Object.fromEntries(initialHiddenColumns.map((id) => [id, false]));
		}
	});

	const table = createTable<DataTableFeatures, TData>({
		features,
		get columns() {
			return columns;
		},
		get data() {
			return rows;
		},
		get getRowId() {
			return getRowId;
		},
		// The server owns ordering and slicing; the table only holds the state
		// that says which page of which order is on screen.
		manualSorting: true,
		manualPagination: true,
		get rowCount() {
			return total;
		},
		state: {
			get sorting() {
				return sort === null ? [] : [{ id: sort.columnId, desc: sort.direction === 'desc' }];
			},
			get pagination() {
				return { pageIndex: query.page - 1, pageSize: query.size };
			},
			get rowSelection() {
				return rowSelection;
			},
			get columnVisibility() {
				return columnVisibility;
			}
		},
		onRowSelectionChange: (updater) => {
			rowSelection = typeof updater === 'function' ? updater(rowSelection) : updater;
		},
		onColumnVisibilityChange: (updater) => {
			columnVisibility = typeof updater === 'function' ? updater(columnVisibility) : updater;
		}
	});

	const visibleColumnCount = $derived(table.getVisibleLeafColumns().length + (selectable ? 1 : 0));
	const skeletonRows = $derived(Array.from({ length: Math.min(query.size, 8) }, (_, i) => i));
	const skeletonCells = $derived(Array.from({ length: visibleColumnCount }, (_, i) => i));
	const selectedIds = $derived(Object.keys(rowSelection).filter((id) => rowSelection[id]));
	/**
	 * Roving tabindex: exactly one row is reachable with Tab — the active one, or
	 * the first row before anything has been focused — and the arrows or `j`/`k`
	 * move from there.
	 */
	const activeRow = $derived(Math.max(activeIndex, 0));
	const firstOnPage = $derived(total === 0 ? 0 : (query.page - 1) * query.size + 1);
	const lastOnPage = $derived(Math.min(query.page * query.size, total));
	const pageCount = $derived(Math.max(1, Math.ceil(total / query.size)));

	function go(changes: Parameters<typeof tableHref>[1]) {
		return goto(tableHref(page.url, changes), { keepFocus: true, noScroll: true });
	}

	function toggleSort(columnId: string) {
		const nextDirection = sort?.columnId === columnId && sort.direction === 'asc' ? 'desc' : 'asc';

		return go({ sortBy: columnId, sortDirection: nextDirection, page: 1 });
	}

	/**
	 * Выделение принадлежит отобранному набору, а не списку вообще: сменился
	 * запрос — на экране другие строки, и панель «Выбрано: 17» над пустым
	 * результатом обещает действие над тем, чего не видно. Страницы одного и
	 * того же запроса выделение переживает: это по-прежнему тот же набор.
	 */
	let selectionScope = untrack(() => query.search);

	$effect(() => {
		if (query.search === selectionScope) return;

		selectionScope = query.search;
		rowSelection = {};
	});

	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	// A pending search must not navigate after the page that owns it is gone.
	$effect(() => () => clearTimeout(searchTimer));

	function onSearchInput(event: Event & { currentTarget: HTMLInputElement }) {
		const value = event.currentTarget.value;

		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => void go({ search: value, page: 1 }), 250);
	}

	function focusRow(index: number) {
		activeIndex = index;
		tableRoot?.querySelectorAll<HTMLElement>('tbody tr[data-row]')[index]?.focus();
	}

	function onTableKeydown(event: KeyboardEvent) {
		const model = table.getRowModel().rows;
		if (model.length === 0) return;

		if (event.key === 'ArrowDown' || event.key === 'j') {
			event.preventDefault();
			focusRow(Math.min(activeIndex + 1, model.length - 1));
		} else if (event.key === 'ArrowUp' || event.key === 'k') {
			event.preventDefault();
			focusRow(Math.max(activeIndex - 1, 0));
		} else if (event.key === 'Enter' && activeIndex >= 0) {
			event.preventDefault();
			onopen?.(model[activeIndex].original);
		}
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key !== '/' || !searchInput) return;

		const target = event.target;
		const typing =
			target instanceof HTMLElement &&
			(target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
		if (typing) return;

		event.preventDefault();
		searchInput.focus();
		if (searchInput instanceof HTMLInputElement) searchInput.select();
	}

	function columnTitle(column: { id: string; columnDef: { header?: unknown; meta?: unknown } }) {
		const meta = column.columnDef.meta as { title?: string } | undefined;
		if (meta?.title) return meta.title;

		return typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id;
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class={cn('flex flex-col gap-3', className)} data-slot="data-table">
	<div class="flex flex-wrap items-center gap-2">
		{#if searchPlaceholder}
			<div class="relative min-w-0 flex-1 sm:max-w-xs">
				<SearchIcon
					class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<Input
					bind:ref={searchInput}
					type="search"
					value={query.search}
					placeholder={searchPlaceholder}
					aria-label={searchPlaceholder}
					class="pl-8"
					oninput={onSearchInput}
				/>
			</div>
		{/if}

		<div class="ml-auto flex items-center gap-2">
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" size="sm">
							<Columns3Icon aria-hidden="true" />
							Колонки
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-52">
					<!-- Заголовок обязан стоять внутри группы: без неё bits-ui не находит
						контекст и всё содержимое меню не отрисовывается вовсе. -->
					<DropdownMenu.Group>
						<DropdownMenu.GroupHeading>Показывать колонки</DropdownMenu.GroupHeading>
						<DropdownMenu.Separator />
						{#each table
							.getAllLeafColumns()
							.filter((column) => column.getCanHide()) as column (column.id)}
							<DropdownMenu.CheckboxItem
								checked={column.getIsVisible()}
								onCheckedChange={(checked) => column.toggleVisibility(checked)}
								closeOnSelect={false}
							>
								{columnTitle(column)}
							</DropdownMenu.CheckboxItem>
						{/each}
					</DropdownMenu.Group>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>
	</div>

	{#if selectable && selectedIds.length > 0}
		<div
			class="flex flex-wrap items-center gap-2 rounded-md border border-primary-soft-border bg-primary-soft px-3 py-2"
		>
			<span class="text-sm font-medium text-primary"
				>Выбрано: {formatNumber(selectedIds.length)}</span
			>
			<div class="ml-auto flex items-center gap-2">
				{@render bulkActions?.({ ids: selectedIds, clear: () => (rowSelection = {}) })}
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Снять выделение"
					onclick={() => (rowSelection = {})}
				>
					<XIcon aria-hidden="true" />
				</Button>
			</div>
		</div>
	{/if}

	<div class="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
		<div bind:this={tableRoot}>
			<Table.Root containerClass="max-h-[70vh]" onkeydown={onTableKeydown}>
				<Table.Header class="sticky top-0 z-10 bg-surface-muted">
					{#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
						<Table.Row class="hover:bg-transparent">
							{#if selectable}
								<Table.Head class="w-10 pr-0">
									<Checkbox
										checked={table.getIsAllPageRowsSelected()}
										indeterminate={table.getIsSomePageRowsSelected() &&
											!table.getIsAllPageRowsSelected()}
										onCheckedChange={(checked) => table.toggleAllPageRowsSelected(checked)}
										aria-label="Выбрать все строки на странице"
									/>
								</Table.Head>
							{/if}
							{#each headerGroup.headers as header (header.id)}
								{@const align = header.column.columnDef.meta?.align === 'end'}
								<Table.Head class={align ? 'text-right' : undefined}>
									{#if header.column.getCanSort()}
										{@const sorted = header.column.getIsSorted()}
										<button
											type="button"
											class={cn(
												'-mx-1 flex h-6 items-center gap-1 rounded px-1 focus-ring hover:text-foreground',
												align && 'ml-auto flex-row-reverse',
												sorted && 'text-foreground'
											)}
											onclick={() => toggleSort(header.column.id)}
										>
											<FlexRender {header} />
											{#if sorted === 'asc'}
												<ArrowUpIcon class="size-3" aria-hidden="true" />
											{:else if sorted === 'desc'}
												<ArrowDownIcon class="size-3" aria-hidden="true" />
											{:else}
												<ChevronsUpDownIcon class="size-3 opacity-40" aria-hidden="true" />
											{/if}
											<span class="sr-only">
												{sorted === 'asc'
													? 'по возрастанию'
													: sorted === 'desc'
														? 'по убыванию'
														: 'не отсортировано'}
											</span>
										</button>
									{:else}
										<FlexRender {header} />
									{/if}
								</Table.Head>
							{/each}
						</Table.Row>
					{/each}
				</Table.Header>

				<Table.Body>
					{#if loading}
						{#each skeletonRows as rowIndex (rowIndex)}
							<Table.Row class="h-row hover:bg-transparent">
								{#each skeletonCells as cellIndex (cellIndex)}
									<Table.Cell><Skeleton class="h-3.5 w-full max-w-40" /></Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					{:else if table.getRowModel().rows.length === 0}
						<Table.Row class="hover:bg-transparent">
							<Table.Cell colspan={visibleColumnCount} class="p-0">
								<EmptyState
									title={emptyTitle}
									description={emptyDescription}
									action={emptyAction}
								/>
							</Table.Cell>
						</Table.Row>
					{:else}
						{#each table.getRowModel().rows as row, index (row.id)}
							<Table.Row
								data-row={index}
								class={cn(
									'h-row cursor-default focus-visible:bg-primary-soft focus-visible:outline-none',
									onopen && 'cursor-pointer'
								)}
								tabindex={index === activeRow ? 0 : -1}
								data-state={row.getIsSelected() ? 'selected' : undefined}
								onfocus={() => (activeIndex = index)}
								onclick={() => onopen?.(row.original)}
							>
								{#if selectable}
									<!-- A click on the box must not reach the row, which would open the record. -->
									<Table.Cell class="w-10 pr-0" onclick={(event) => event.stopPropagation()}>
										<Checkbox
											checked={row.getIsSelected()}
											onCheckedChange={(checked) => row.toggleSelected(checked)}
											aria-label="Выбрать строку"
										/>
									</Table.Cell>
								{/if}
								{#each row.getVisibleCells() as cell (cell.id)}
									<Table.Cell
										class={cell.column.columnDef.meta?.align === 'end' ? 'text-right' : undefined}
									>
										<FlexRender {cell} />
									</Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					{/if}
				</Table.Body>
			</Table.Root>
		</div>
	</div>

	<div class="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
		<!-- Пустой список объяснён один раз — в самой таблице. Второе сообщение
			«Нет записей» под ней говорило о том же другими словами. -->
		<p>
			{#if total > 0}
				{formatNumber(firstOnPage)}–{formatNumber(lastOnPage)} из {formatNumber(total)}
			{/if}
		</p>

		<div class="flex items-center gap-3">
			<div class="flex items-center gap-2">
				<Label for="page-size" class="hidden font-normal text-muted-foreground sm:inline">
					Строк на странице
				</Label>
				<Select.Root
					type="single"
					value={String(query.size)}
					onValueChange={(size) => void go({ size: Number(size), page: 1 })}
				>
					<Select.Trigger id="page-size" size="sm" aria-label="Строк на странице">
						{query.size}
					</Select.Trigger>
					<Select.Content>
						{#each PAGE_SIZES as size (size)}
							<Select.Item value={String(size)} label={String(size)} />
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="flex items-center gap-1">
				<Button
					variant="outline"
					size="icon-sm"
					aria-label="Предыдущая страница"
					disabled={query.page <= 1}
					onclick={() => go({ page: query.page - 1 })}
				>
					<ChevronLeftIcon aria-hidden="true" />
				</Button>
				<span class="px-1 whitespace-nowrap">{query.page} / {pageCount}</span>
				<Button
					variant="outline"
					size="icon-sm"
					aria-label="Следующая страница"
					disabled={query.page >= pageCount}
					onclick={() => go({ page: query.page + 1 })}
				>
					<ChevronRightIcon aria-hidden="true" />
				</Button>
			</div>
		</div>
	</div>
</div>
