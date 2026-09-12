<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDate, formatNumber } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/**
	 * Обычная таблица, а не `DataTable`: версий процесса единицы, их не ищут и
	 * не листают — их читают целиком, поэтому ни страницы, ни фильтра здесь нет.
	 */
</script>

<svelte:head><title>Маршруты стадий — LCT CRM</title></svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title>Версии процесса</Card.Title>
		<Card.Description>
			Процесс описан данными: стадии с нормативами и чек-листами и переходы между ними.
			Опубликованную версию менять нельзя — на неё уже сослались взаимодействия, — поэтому изменение
			процесса оформляется новой версией с тем же ключом. Маршрут по умолчанию ровно один: его
			предлагают новому взаимодействию.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if data.routes.length === 0}
			<EmptyState
				title="Маршрутов пока нет"
				description="Система приезжает с готовым маршрутом работы с учебным заведением; если его нет, база заливалась без начальных данных."
			/>
		{:else}
			<div class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head>Название</Table.Head>
							<Table.Head>Ключ</Table.Head>
							<Table.Head class="w-20 text-right">Версия</Table.Head>
							<Table.Head class="w-48">Состояние</Table.Head>
							<Table.Head class="w-24 text-right">Стадий</Table.Head>
							<Table.Head class="w-32 text-right">Активных</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.routes as route (route.id)}
							<Table.Row class="h-row">
								<Table.Cell class="font-medium">
									<a
										class="rounded-sm underline-offset-4 focus-ring hover:underline"
										href={resolve('/(app)/settings/routes/[id=uuid]', { id: route.id })}
									>
										{route.name}
									</a>
								</Table.Cell>
								<Table.Cell class="text-muted-foreground">{route.key}</Table.Cell>
								<Table.Cell class="text-right">{route.version}</Table.Cell>
								<Table.Cell>
									<span class="flex flex-wrap items-center gap-1">
										{#if route.publishedAt === null}
											<StatusBadge tone="warning">Черновик</StatusBadge>
										{:else}
											<StatusBadge
												tone="success"
												title="Опубликован {formatDate(route.publishedAt)}"
											>
												Опубликован
											</StatusBadge>
										{/if}
										{#if route.isDefault}
											<StatusBadge tone="accent">По умолчанию</StatusBadge>
										{/if}
									</span>
								</Table.Cell>
								<Table.Cell class="text-right">{formatNumber(route.stageCount)}</Table.Cell>
								<Table.Cell class="text-right">
									{formatNumber(route.activeInteractions)}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
