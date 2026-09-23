<script lang="ts">
	import PlusIcon from '@lucide/svelte/icons/plus';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import {
		EXCHANGE_STATE_LABELS,
		LEARNING_PURPOSE_LABELS,
		type LearningGroupView
	} from '$lib/contracts/exchange';
	import { formatDate } from '$lib/format';
	import ContextSection from './context-section.svelte';
	import { mockAction } from './mock';

	/**
	 * Потоки в системе обучения — компактно: что заявлено, что пришло в ответ и
	 * как идёт обучение. Форма заявки открывается кнопкой, а не стоит на карточке
	 * постоянно: поток заводят раз в семестр, а читают его состояние каждый день.
	 */
	let {
		groups,
		issue,
		id = 'card-learning'
	}: {
		groups: readonly LearningGroupView[];
		/** Почему новый поток сейчас не заявить; `null` — можно. */
		issue: string | null;
		id?: string;
	} = $props();

	const TRAINING = {
		completed: { label: 'Обучение завершено', tone: 'success' },
		in_progress: { label: 'Идёт обучение', tone: 'accent' },
		awaiting: { label: 'Ждём данных', tone: 'neutral' }
	} as const;
</script>

<div {id}>
	<ContextSection title="Система обучения">
		{#snippet action()}
			<Button
				size="xs"
				variant="outline"
				disabled={issue !== null}
				aria-describedby={issue === null ? undefined : `${id}-issue`}
				onclick={() => mockAction('Заявить поток')}
			>
				<PlusIcon aria-hidden="true" />
				Заявить поток
			</Button>
		{/snippet}

		{#if issue !== null}
			<p id="{id}-issue" class="text-xs text-muted-foreground">{issue}</p>
		{/if}

		{#if groups.length === 0}
			<p class="text-sm text-muted-foreground">Потоков пока нет.</p>
		{:else}
			<ul class="flex flex-col gap-3">
				{#each groups as group (group.id)}
					<li class="flex flex-col gap-1">
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span class="text-sm font-medium">
								Поток {group.streamNumber}{group.groupExternalId
									? ` · группа ${group.groupExternalId}`
									: ''}
							</span>
							<StatusBadge tone={TRAINING[group.trainingState].tone} dot>
								{TRAINING[group.trainingState].label}
							</StatusBadge>
						</div>
						{#if group.enrolled !== null}
							<dl class="grid grid-cols-3 gap-2 text-center">
								<div class="rounded-md bg-surface-muted px-1 py-1.5">
									<dt class="text-xs text-muted-foreground">зачислено</dt>
									<dd class="text-base font-semibold tabular-nums">{group.enrolled}</dd>
								</div>
								<div class="rounded-md bg-surface-muted px-1 py-1.5">
									<dt class="text-xs text-muted-foreground">завершили</dt>
									<dd class="text-base font-semibold tabular-nums">{group.completed ?? 0}</dd>
								</div>
								<div class="rounded-md bg-surface-muted px-1 py-1.5">
									<dt class="text-xs text-muted-foreground">отчислено</dt>
									<dd class="text-base font-semibold tabular-nums">{group.expelled ?? 0}</dd>
								</div>
							</dl>
						{/if}
						<p class="text-xs text-muted-foreground">
							{[
								group.purpose === null ? null : LEARNING_PURPOSE_LABELS[group.purpose],
								group.plannedSeats === null ? null : `мест ${group.plannedSeats}`,
								group.startsOn === null ? null : `с ${formatDate(group.startsOn)}`,
								group.endsOn === null ? null : `по ${formatDate(group.endsOn)}`
							]
								.filter((part) => part !== null)
								.join(' · ')}
						</p>
						{#if group.messageState === 'failed' || group.messageState === 'retrying'}
							<p class="text-xs text-danger-soft-foreground">
								Заявка: {EXCHANGE_STATE_LABELS[group.messageState].toLowerCase()}{group.lastError
									? ` — ${group.lastError}`
									: ''}
							</p>
						{/if}
						{#if !group.countsForStage}
							<p class="text-xs text-warning-soft-foreground">
								Программы потока нет в записи — стадию он не подтверждает.
							</p>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</ContextSection>
</div>
