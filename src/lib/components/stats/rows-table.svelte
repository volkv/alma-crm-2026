<script lang="ts">
	import * as Table from '$lib/components/ui/table/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDate } from '$lib/format';
	import type { StatRowView } from '$lib/contracts/stats';
	import { measureText } from './labels';

	/**
	 * Строки снимка вместе с претензиями к ним.
	 *
	 * Претензия написана словами и стоит в той же строке, что и данные: список
	 * ошибок отдельно от данных заставляет человека сверять номера строк руками,
	 * а это и есть та работа, ради отмены которой затевался импорт.
	 */
	let {
		rows,
		emptyTitle = 'Строк нет',
		emptyDescription
	}: {
		rows: readonly StatRowView[];
		emptyTitle?: string;
		emptyDescription?: string;
	} = $props();
</script>

{#if rows.length === 0}
	<div class="rounded-lg border border-border bg-surface">
		<EmptyState title={emptyTitle} description={emptyDescription} />
	</div>
{:else}
	<div class="overflow-x-auto rounded-lg border border-border bg-surface">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-12 text-right">№</Table.Head>
					<Table.Head>Организация</Table.Head>
					<Table.Head>Программа</Table.Head>
					<Table.Head>Период</Table.Head>
					<Table.Head class="text-right">Заявки</Table.Head>
					<Table.Head class="text-right">Зачислено</Table.Head>
					<Table.Head class="text-right">Потоки</Table.Head>
					<Table.Head>Проверка</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each rows as row (row.id)}
					<Table.Row data-row-no={row.rowNo}>
						<Table.Cell class="text-right text-muted-foreground">{row.rowNo}</Table.Cell>
						<Table.Cell>{row.organizationName ?? '—'}</Table.Cell>
						<Table.Cell class="max-w-64 truncate" title={row.programName ?? undefined}>
							{row.programName ?? '—'}
						</Table.Cell>
						<Table.Cell class="whitespace-nowrap">
							{formatDate(row.periodStart)} — {formatDate(row.periodEnd)}
						</Table.Cell>
						<Table.Cell class="text-right">{measureText(row.applications)}</Table.Cell>
						<Table.Cell class="text-right">{measureText(row.enrolled)}</Table.Cell>
						<Table.Cell class="text-right">{measureText(row.parallelStreams)}</Table.Cell>
						<Table.Cell>
							{#if row.issues.length === 0}
								{#if row.replacedByRowId !== null}
									<StatusBadge tone="neutral">Заменена исправлением</StatusBadge>
								{:else}
									<StatusBadge tone="success" dot>Верна</StatusBadge>
								{/if}
							{:else}
								<ul class="flex flex-col gap-1">
									{#each row.issues as issue (issue.message)}
										<li class="text-xs text-danger-soft-foreground">{issue.message}</li>
									{/each}
								</ul>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
{/if}
