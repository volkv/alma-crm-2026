<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatNumber } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/**
	 * Обычная таблица, а не `DataTable`: групп процесса единицы, их не ищут и не
	 * листают — их читают целиком, поэтому ни страницы, ни фильтра здесь нет.
	 */
</script>

<svelte:head><title>Процесс — LCT CRM</title></svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title>Процесс</Card.Title>
		<Card.Description>
			Процесс описан данными: стадии с нормативами и чек-листами и переходы между ними. В каждой
			группе контрагентов действует ровно один процесс; его изменение готовят черновиком и применяют
			ко всем незавершённым взаимодействиям группы сразу.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if data.groups.length === 0}
			<EmptyState
				title="Групп процесса нет"
				description="Группы приезжают вместе со схемой базы; если их нет, база разворачивалась без миграций."
			/>
		{:else}
			<div class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head>Группа</Table.Head>
							<Table.Head>Кого ведём</Table.Head>
							<Table.Head class="w-40">Состояние</Table.Head>
							<Table.Head class="w-24 text-right">Стадий</Table.Head>
							<Table.Head class="w-40 text-right">Незавершённых</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.groups as group (group.id)}
							<Table.Row class="h-row">
								<Table.Cell class="font-medium">
									<a
										class="rounded-sm underline-offset-4 focus-ring hover:underline"
										href={resolve('/(app)/settings/process/[key]', { key: group.key })}
									>
										{group.name}
									</a>
								</Table.Cell>
								<Table.Cell class="text-muted-foreground">{group.description ?? '—'}</Table.Cell>
								<Table.Cell>
									<span class="flex flex-wrap items-center gap-1">
										{#if group.stageCount === 0}
											<StatusBadge tone="danger">Процесс не описан</StatusBadge>
										{:else}
											<StatusBadge tone="success">Действует</StatusBadge>
										{/if}
										{#if group.hasDraft}
											<StatusBadge tone="warning">Черновик изменений</StatusBadge>
										{/if}
									</span>
								</Table.Cell>
								<Table.Cell class="text-right">{formatNumber(group.stageCount)}</Table.Cell>
								<Table.Cell class="text-right">
									{formatNumber(group.activeInteractions)}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
