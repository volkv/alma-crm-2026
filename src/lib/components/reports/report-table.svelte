<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Table from '$lib/components/ui/table/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import TableIcon from '@lucide/svelte/icons/table';
	import type {
		ReportCell,
		ReportColumnKey,
		ReportColumnView,
		ReportRow
	} from '$lib/contracts/reports';
	import { formatDate, formatDateTime, formatNumber } from '$lib/format';
	import { cn } from '$lib/utils';

	/**
	 * Таблица отчёта. Ячейка типизирована в объекте отчёта, поэтому вёрстка не
	 * решает, число перед ней или дата: числа выравниваются вправо, даты
	 * показываются днём, моменты — днём и временем, а пустое значение остаётся
	 * пустым. Прочерк и ноль — разные ответы: ноль означает записанный ноль.
	 */
	let {
		columns,
		rows,
		isFiltered
	}: {
		columns: readonly ReportColumnView[];
		rows: readonly ReportRow[];
		/** Пустая выборка под фильтром и пустой раздел — разные состояния. */
		isFiltered: boolean;
	} = $props();

	/**
	 * Колонки, которые остаются в записи на телефоне. Пятнадцать колонок в
	 * ширину 390 px превращались в одну обрезанную ссылку на строку; запись
	 * держит название, где взаимодействие стоит или куда перешло и сколько
	 * стоит. Остальные колонки — в выгрузке и на широком экране.
	 */
	const PHONE_COLUMNS: ReadonlySet<ReportColumnKey> = new Set([
		'interaction',
		'organization',
		'stage',
		'daysOnStage',
		'overdueDays',
		'stageFrom',
		'stageTo',
		'moveKind',
		'movedAt'
	]);

	/*
	 * Раскладка блоком — те же строки и ячейки, переставленные стилями ниже
	 * `sm`, как у списка взаимодействий: одна разметка на обе ширины.
	 */
	const STACK_BLOCK = 'max-sm:block';
	const STACK_ROW =
		'max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:gap-x-3 max-sm:gap-y-1 max-sm:px-3 max-sm:py-2.5';
	const STACK_CELL =
		'max-sm:block max-sm:min-w-0 max-sm:p-0 max-sm:text-left max-sm:whitespace-normal';

	const hiddenOnPhone = $derived(columns.filter((column) => !PHONE_COLUMNS.has(column.key)).length);

	/** Класс ячейки: выравнивание числа и её место в записи на телефоне. */
	function cellClass(column: ReportColumnView, cell: ReportCell): string {
		const shown =
			PHONE_COLUMNS.has(column.key) && !(cell.kind !== 'link' && plainText(cell) === '');

		return cn(
			column.kind === 'number' && 'text-right',
			STACK_CELL,
			cell.kind === 'link' ? 'max-sm:basis-full' : 'max-sm:basis-auto max-sm:text-xs',
			!shown && 'max-sm:hidden'
		);
	}

	function plainText(cell: ReportCell): string {
		switch (cell.kind) {
			case 'text':
				return cell.value ?? '';
			case 'number':
				return cell.value === null ? '' : formatNumber(cell.value);
			case 'date':
				return cell.value === null ? '' : formatDate(cell.value);
			case 'datetime':
				return cell.value === null ? '' : formatDateTime(cell.value);
			case 'list':
				return cell.values.join(', ');
			case 'link':
				return cell.value ?? '';
		}
	}
</script>

{#if rows.length === 0}
	<div class="rounded-lg border border-border bg-surface shadow-xs">
		<EmptyState
			icon={TableIcon}
			title={isFiltered ? 'Под фильтр не попало ни одной строки' : 'Показывать пока нечего'}
			description={isFiltered
				? 'Проверьте период и условия: отчёт считает только то, что уже произошло.'
				: 'Взаимодействий за этот период ещё нет — отчёт наполнится вместе с работой.'}
		/>
	</div>
{:else}
	{#if hiddenOnPhone > 0}
		<p class="text-xs text-muted-foreground sm:hidden" data-testid="report-table-phone-note">
			На телефоне в записи — ключевые колонки. Все колонки — на широком экране и в выгрузке.
		</p>
	{/if}
	<div class="overflow-x-auto rounded-lg border border-border bg-surface shadow-xs">
		<Table.Root data-slot="report-table" class={STACK_BLOCK} containerClass={STACK_BLOCK}>
			<Table.Header class="max-sm:hidden">
				<Table.Row>
					{#each columns as column (column.key)}
						<Table.Head class={column.kind === 'number' ? 'text-right' : undefined}>
							{column.label}
							<span class="block text-xs font-normal text-faint">{column.note}</span>
						</Table.Head>
					{/each}
				</Table.Row>
			</Table.Header>
			<Table.Body class={STACK_BLOCK}>
				{#each rows as row (row.rowKey)}
					<Table.Row data-row={row.interactionId} class={STACK_ROW}>
						{#each row.cells as cell, position (columns[position].key)}
							{@const column = columns[position]}
							<Table.Cell class={cellClass(column, cell)}>
								{#if cell.kind === 'link' && cell.value !== null}
									<!-- Адрес карточки в ячейке абсолютный: он нужен файлам, которые
									     живут вне приложения. На экране ссылка собирается маршрутом —
									     так её проверяет сборка, а переход остаётся клиентским. -->
									<a
										class="text-link focus-ring hover:text-link-hover max-sm:line-clamp-2 max-sm:font-medium"
										href={resolve('/(app)/interactions/[id=uuid]', { id: row.interactionId })}
									>
										{cell.value}
									</a>
								{:else}
									<span class="text-muted-foreground sm:hidden">{column.label}:</span>
									{plainText(cell)}
								{/if}
							</Table.Cell>
						{/each}
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
{/if}
