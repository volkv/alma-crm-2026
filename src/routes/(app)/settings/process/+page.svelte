<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatNumber } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/**
	 * Обычная таблица, а не `DataTable`: пространств единицы, их не ищут и не
	 * листают — их читают целиком, поэтому ни страницы, ни фильтра здесь нет.
	 *
	 * Строка ведёт в редактор целиком, а не только названием: раздел открывают
	 * ради того, чтобы войти в процесс, и вход обязан быть виден — отсюда и
	 * колонка «Открыть» справа. Описание пространства переносится по словам: в
	 * одну строку оно уносило вправо всё остальное, и на ноутбуке состояние,
	 * число стадий и число незавершённых оказывались за краем.
	 */
	function open(key: string) {
		return goto(resolve('/(app)/settings/process/[key]', { key }));
	}
</script>

<svelte:head><title>Процесс — LCT CRM</title></svelte:head>

<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
<Card.Root data-tour="workspaces">
	<Card.Header>
		<Card.Title>Процесс</Card.Title>
		<Card.Description>
			Процесс описан данными: стадии с нормативами и чек-листами и переходы между ними. В каждом
			пространстве действует ровно один процесс; его изменение готовят черновиком и применяют ко
			всем незавершённым взаимодействиям пространства сразу.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if data.workspaces.length === 0}
			<EmptyState
				title="Пространств нет"
				description="Пространства приезжают вместе со схемой базы; если их нет, база разворачивалась без миграций."
			/>
		{:else}
			<div class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head>Пространство</Table.Head>
							<!-- Описанию задана ширина: без неё браузер отдавал место колонке
								названия, и три слова переносились на шесть строк. -->
							<Table.Head class="w-80">Кого ведём</Table.Head>
							<Table.Head class="w-40">Состояние</Table.Head>
							<Table.Head class="w-20 text-right">Стадий</Table.Head>
							<Table.Head class="w-32 text-right">Незавершённых</Table.Head>
							<Table.Head class="w-28"><span class="sr-only">Действия</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.workspaces as workspace (workspace.id)}
							<Table.Row class="h-row cursor-pointer" onclick={() => void open(workspace.key)}>
								<Table.Cell
									class="font-medium whitespace-normal"
									onclick={(event) => event.stopPropagation()}
								>
									<a
										class="rounded-sm text-primary underline-offset-4 focus-ring hover:underline"
										href={resolve('/(app)/settings/process/[key]', { key: workspace.key })}
									>
										{workspace.name}
									</a>
								</Table.Cell>
								<Table.Cell class="whitespace-normal text-muted-foreground">
									{workspace.description ?? '—'}
								</Table.Cell>
								<Table.Cell>
									<span class="flex flex-wrap items-center gap-1">
										{#if workspace.stageCount === 0}
											<StatusBadge tone="danger">Процесс не описан</StatusBadge>
										{:else}
											<StatusBadge tone="success">Действует</StatusBadge>
										{/if}
										{#if workspace.hasDraft}
											<StatusBadge tone="warning">Черновик изменений</StatusBadge>
										{/if}
									</span>
								</Table.Cell>
								<Table.Cell class="text-right">{formatNumber(workspace.stageCount)}</Table.Cell>
								<Table.Cell class="text-right">
									{formatNumber(workspace.activeInteractions)}
								</Table.Cell>
								<Table.Cell class="text-right" onclick={(event) => event.stopPropagation()}>
									<!-- Ссылка, а не кнопка: открывает адрес, и открывать его
										должны уметь и средняя кнопка мыши, и клавиатура. -->
									<!-- `data-tour` — метка подсказок по этому экрану
										(`$lib/onboarding/screens`): рамка встаёт вокруг входа в
										процесс первого пространства. -->
									<Button
										data-tour="process-open"
										variant="outline"
										size="sm"
										href={resolve('/(app)/settings/process/[key]', { key: workspace.key })}
										aria-label="Открыть процесс: {workspace.name}"
									>
										Открыть
										<ArrowRightIcon aria-hidden="true" />
									</Button>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
