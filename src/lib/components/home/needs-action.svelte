<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import type { DateInput } from '$lib/format';
	import { formatDate } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import SlaChip from '$lib/components/sla-chip.svelte';
	import StageTimeline from '$lib/components/stage-timeline.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { toTimelineStages } from '$lib/components/interactions/timeline';
	import type { OverviewImpediment, OverviewTask } from '$lib/server/interactions/overview';
	import { interactionHref } from './links';

	/**
	 * Список на утро: чем заняться в первую очередь и что этому мешает. Порядок
	 * строк считает сервер — просрочка, помеха, близкий срок, — а таблица его не
	 * пересортировывает: тогда «первое сверху» значило бы разное на разных
	 * экранах.
	 */
	let {
		tasks,
		basis,
		now
	}: {
		tasks: readonly OverviewTask[];
		/** `all` — своих записей нет, показаны просроченные по всей области. */
		basis: 'mine' | 'all';
		/** Момент, на который собрана сводка: от него считаются сроки. */
		now: DateInput;
	} = $props();

	const badgeTone = (impediment: OverviewImpediment) =>
		impediment.kind === 'blocker'
			? impediment.blocksTransition
				? 'danger'
				: 'warning'
			: 'neutral';

	function impedimentLabel(impediment: OverviewImpediment): string {
		switch (impediment.kind) {
			case 'blocker':
				return 'Помеха';
			case 'waiting':
				return 'Ждём';
			case 'silence':
				return 'Тишина';
		}
	}

	function impedimentText(impediment: OverviewImpediment): string {
		switch (impediment.kind) {
			case 'blocker':
				return impediment.text;
			case 'waiting':
				return impediment.party === null
					? impediment.text
					: `${impediment.party}: ${impediment.text}`;
			case 'silence':
				return `событий нет с ${formatDate(impediment.since)}`;
		}
	}
</script>

{#if tasks.length === 0}
	<EmptyState
		icon={CircleCheckIcon}
		title={basis === 'mine' ? 'Ничего не горит' : 'Просроченных взаимодействий нет'}
		description={basis === 'mine'
			? 'По вашим взаимодействиям нет ни просрочки, ни помех, ни близких сроков.'
			: 'Ни по одному взаимодействию в вашей области доступа срок стадии не прошёл.'}
	/>
{:else}
	{#if basis === 'all'}
		<div class="px-4 pt-3">
			<InlineHint>
				Ваших взаимодействий сейчас нет — показаны просроченные по всей области доступа.
			</InlineHint>
		</div>
	{/if}

	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head>Взаимодействие</Table.Head>
				<Table.Head>Стадия</Table.Head>
				<Table.Head>Срок</Table.Head>
				<Table.Head>Что мешает</Table.Head>
				<Table.Head class="w-0"><span class="sr-only">Действие</span></Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each tasks as task (task.interaction.id)}
				{@const row = task.interaction}
				<Table.Row>
					<!-- Ячейка таблицы по умолчанию не переносит строк: длинное название
					     без этого уезжает поверх соседней колонки. -->
					<Table.Cell class="max-w-64 whitespace-normal">
						<a
							href={interactionHref(row.id)}
							class="rounded-sm font-medium focus-ring hover:underline"
						>
							{row.title}
						</a>
						<p class="truncate text-xs text-muted-foreground">
							{row.institutionName ?? 'Учебное заведение не указано'}
						</p>
					</Table.Cell>

					<Table.Cell class="max-w-52 min-w-44">
						{#if row.stage === null}
							<span class="text-faint">не начато</span>
						{:else}
							<span class="block truncate text-xs text-muted-foreground">{row.stage.name}</span>
							<StageTimeline stages={toTimelineStages(row.progress)} compact class="mt-1" />
						{/if}
					</Table.Cell>

					<Table.Cell>
						{#if row.dueAt === null}
							<span class="text-faint">—</span>
						{:else if row.isPaused}
							<StatusBadge tone="neutral" dot title="Часы стадии остановлены">на паузе</StatusBadge>
						{:else}
							<SlaChip deadline={row.dueAt} {now} />
						{/if}
					</Table.Cell>

					<Table.Cell class="max-w-72 whitespace-normal">
						{#if task.impediment === null}
							<span class="text-faint">ничего не мешает</span>
						{:else}
							<span class="flex flex-wrap items-baseline gap-1.5">
								<StatusBadge tone={badgeTone(task.impediment)}>
									{impedimentLabel(task.impediment)}
								</StatusBadge>
								<span class="min-w-0 text-xs text-muted-foreground">
									{impedimentText(task.impediment)}
								</span>
							</span>
						{/if}
					</Table.Cell>

					<Table.Cell>
						<Button variant="outline" size="sm" href={interactionHref(row.id)}>Открыть</Button>
					</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
{/if}
