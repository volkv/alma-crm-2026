<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Table from '$lib/components/ui/table/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import TableIcon from '@lucide/svelte/icons/table';
	import type { ReportCell, ReportColumnView, ReportRow } from '$lib/contracts/reports';
	import { formatDate, formatDateTime, formatNumber } from '$lib/format';

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
	<div class="overflow-x-auto rounded-lg border border-border bg-surface shadow-xs">
		<Table.Root data-slot="report-table">
			<Table.Header>
				<Table.Row>
					{#each columns as column (column.key)}
						<Table.Head class={column.kind === 'number' ? 'text-right' : undefined}>
							{column.label}
							<span class="block text-xs font-normal text-faint">{column.note}</span>
						</Table.Head>
					{/each}
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each rows as row (row.rowKey)}
					<Table.Row data-row={row.interactionId}>
						{#each row.cells as cell, position (columns[position].key)}
							<Table.Cell class={columns[position].kind === 'number' ? 'text-right' : undefined}>
								{#if cell.kind === 'link' && cell.value !== null}
									<!-- Адрес карточки в ячейке абсолютный: он нужен файлам, которые
									     живут вне приложения. На экране ссылка собирается маршрутом —
									     так её проверяет сборка, а переход остаётся клиентским. -->
									<a
										class="text-link focus-ring hover:text-link-hover"
										href={resolve('/(app)/interactions/[id=uuid]', { id: row.interactionId })}
									>
										{cell.value}
									</a>
								{:else}
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
