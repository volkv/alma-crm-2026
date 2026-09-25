<script lang="ts">
	import PlusIcon from '@lucide/svelte/icons/plus';
	import UsersIcon from '@lucide/svelte/icons/users';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import {
		EXCHANGE_STATE_LABELS,
		LEARNING_PURPOSE_LABELS,
		type LearningGroupView
	} from '$lib/contracts/exchange';
	import { formatDate, formatDateTime } from '$lib/format';
	import { getCardCommands } from './commands.svelte';
	import ContextSection from './context-section.svelte';
	import { describeUncountedGroup, type CardExchange } from './model';

	/**
	 * Потоки в системе обучения — компактно: что заявлено, что пришло в ответ и
	 * как идёт обучение. Форма заявки открывается кнопкой, а не стоит на карточке
	 * постоянно: поток заводят раз в семестр, а читают его состояние каждый день.
	 */
	let {
		groups,
		programs,
		learningStages,
		issue,
		canSend,
		canComplete
	}: {
		groups: readonly LearningGroupView[];
		/** Программы записи: по ним видно, что программу потока из записи убрали. */
		programs: CardExchange['programs'];
		/** Стадии с данными обучения: по ним видно, что стадия не берёт назначение потока. */
		learningStages: CardExchange['learningStages'];
		/** Почему новый поток сейчас не заявить; `null` — можно. */
		issue: string | null;
		/** Есть ли право заявлять потоки. */
		canSend: boolean;
		/** Можно ли отметить обучение завершённым без итога из системы обучения. */
		canComplete: boolean;
	} = $props();

	const commands = getCardCommands();
	const id = 'card-learning';

	/** Поимённый список потока словами: сколько внесено и сколько из них уже в LMS. */
	const learnersLabel = (group: LearningGroupView) =>
		group.learnerCount === 0
			? 'Поимённого списка нет'
			: `Слушателей в списке: ${group.learnerCount}, передано в LMS: ${group.transferredCount}`;

	/** Судьба заявки словами: пока результатов нет, важна именно она. */
	const requestLabel = (group: LearningGroupView) =>
		group.messageState === null
			? 'заявка не отправлялась'
			: `заявка: ${EXCHANGE_STATE_LABELS[group.messageState].toLowerCase()}`;

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
				disabled={!canSend || issue !== null}
				aria-describedby={issue === null ? undefined : `${id}-issue`}
				onclick={() => commands.open({ kind: 'send-group' })}
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
						<p class="text-xs break-words text-muted-foreground">
							{[
								group.program === null
									? 'программа не закреплена'
									: `${group.program.code} — ${group.program.name}`,
								group.products.length === 0
									? null
									: `продукты: ${group.products.map((product) => product.code).join(', ')}`,
								group.purpose === null ? null : LEARNING_PURPOSE_LABELS[group.purpose],
								group.plannedSeats === null ? null : `мест ${group.plannedSeats}`,
								group.startsOn === null ? null : `с ${formatDate(group.startsOn)}`,
								group.endsOn === null ? null : `по ${formatDate(group.endsOn)}`,
								group.finishedOn === null ? null : `окончание ${formatDate(group.finishedOn)}`,
								group.lastResultAt === null
									? requestLabel(group)
									: `данные от ${formatDateTime(group.lastResultAt)}`
							]
								.filter((part) => part !== null)
								.join(' · ')}
						</p>
						{#if group.lastError !== null}
							<p class="text-xs break-words text-danger-soft-foreground">{group.lastError}</p>
						{/if}
						{#if group.completionMark !== null}
							<p class="text-xs break-words text-muted-foreground">
								Завершение отметил {group.completionMark.byName ?? 'сотрудник'}
								{formatDateTime(group.completionMark.at)}: «{group.completionMark.comment}»
							</p>
						{/if}
						{#if !group.countsForStage}
							<p class="text-xs break-words text-warning-soft-foreground">
								{describeUncountedGroup(group, { programs, learningStages })}
							</p>
						{/if}
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span class="text-xs text-muted-foreground">{learnersLabel(group)}</span>
							<Button
								size="xs"
								variant="outline"
								onclick={() => commands.open({ kind: 'roster', groupId: group.id })}
							>
								<UsersIcon aria-hidden="true" />
								Слушатели…
							</Button>
						</div>
						{#if canComplete && group.trainingState !== 'completed'}
							<Button
								size="xs"
								variant="outline"
								class="self-start"
								onclick={() => commands.open({ kind: 'complete-group', groupId: group.id })}
							>
								Обучение завершено…
							</Button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</ContextSection>
</div>
