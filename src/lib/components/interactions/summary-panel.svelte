<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CornerUpLeftIcon from '@lucide/svelte/icons/corner-up-left';
	import SkipForwardIcon from '@lucide/svelte/icons/skip-forward';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import PlayIcon from '@lucide/svelte/icons/play';
	import type { Snippet } from 'svelte';
	import { enhance } from '$app/forms';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import SlaChip from '$lib/components/sla-chip.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { PAUSE_REASONS, type InteractionSummaryView } from '$lib/contracts/interactions';
	import { formatDateTime } from '$lib/format';
	import { actionEnhance } from './action-enhance';

	/**
	 * Четыре вопроса карточки: что происходит, что мешает, кто должен действовать
	 * и что можно сделать прямо сейчас. Приговор по каждому переходу считает
	 * сервер — панель только показывает его и не прячет недоступное: кнопка с
	 * причиной объясняет процесс, отсутствие кнопки не объясняет ничего.
	 */
	let {
		summary,
		currentStageId,
		closing
	}: {
		summary: InteractionSummaryView;
		/** Стадия, с которой отдаются команды; сервер сверит её со своей. */
		currentStageId: string | null;
		/**
		 * Команды, которые закрывают взаимодействие целиком. Они не про стадию,
		 * поэтому приезжают снаружи, но стоят там же, где остальные ответы на
		 * вопрос «что могу сейчас».
		 */
		closing?: Snippet;
	} = $props();

	const PAUSE_LABELS: Record<(typeof PAUSE_REASONS)[number], string> = {
		waiting_counterparty: 'Ждём ответа контрагента',
		waiting_internal: 'Ждём коллег внутри',
		other: 'Другая причина'
	};

	let reasonDialog = $state<{ action: 'return' | 'skip'; toStageId: string; name: string } | null>(
		null
	);
	let pauseOpen = $state(false);

	const can = (action: string) => summary.canDo.actions.includes(action as 'pause');
</script>

<div class="grid gap-4 lg:grid-cols-4">
	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Что происходит</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			{#if summary.happening.stage === null}
				<p class="text-sm text-muted-foreground">Взаимодействие не стоит ни на одной стадии.</p>
			{:else}
				<p class="text-sm font-medium">{summary.happening.stage.name}</p>
				<div class="flex flex-wrap items-center gap-2">
					{#if summary.happening.isPaused}
						<StatusBadge tone="neutral" dot>На паузе</StatusBadge>
					{:else if summary.happening.dueAt}
						<SlaChip deadline={summary.happening.dueAt} />
					{/if}
				</div>
				{#if summary.happening.pause !== null}
					<p class="text-xs text-muted-foreground">
						{PAUSE_LABELS[summary.happening.pause.reason]}: {summary.happening.pause.note}
					</p>
					<p class="text-xs text-faint">
						с {formatDateTime(summary.happening.pause.startedAt)}
					</p>
				{/if}
				{#if summary.happening.nextAction}
					<p class="text-xs text-muted-foreground">
						Следующий шаг: {summary.happening.nextAction}
					</p>
				{/if}
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Что мешает</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			{#if summary.blocking.blockers.length === 0 && summary.blocking.openChecklist.length === 0}
				<p class="text-sm text-muted-foreground">Ничего не мешает.</p>
			{/if}
			{#each summary.blocking.blockers as blocker (blocker.id)}
				<p class="text-sm">
					<StatusBadge tone={blocker.blocksTransition ? 'danger' : 'warning'} dot>
						{blocker.reasonCode}
					</StatusBadge>
					<span class="ml-1">{blocker.description}</span>
				</p>
			{/each}
			{#if summary.blocking.openChecklist.length > 0}
				<ul class="list-inside list-disc text-xs text-muted-foreground">
					{#each summary.blocking.openChecklist as item (item.key)}
						<li>{item.label}{item.required ? ' — обязательный' : ''}</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Кто должен действовать</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			{#if summary.whoActs.waitingParty !== null}
				<p class="text-sm font-medium">{summary.whoActs.waitingParty.organizationName}</p>
				<p class="text-xs text-muted-foreground">Ход за участником: часы стадии остановлены.</p>
			{:else if summary.whoActs.responsibleUser !== null}
				<p class="text-sm font-medium">{summary.whoActs.responsibleUser.name}</p>
				<p class="text-xs text-muted-foreground">Ответственный за текущую стадию.</p>
			{:else}
				<p class="text-sm text-muted-foreground">Ответственный не назначен.</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Что могу сейчас</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			{#each summary.canDo.transitions as option (option.transition.id)}
				{@const label =
					option.transition.kind === 'forward'
						? `Перейти: ${option.toStage.name}`
						: option.transition.kind === 'return'
							? `Вернуть: ${option.toStage.name}`
							: `Пропустить до: ${option.toStage.name}`}
				<div
					class="flex flex-col gap-1"
					title={option.allowed ? undefined : option.reasons.join('; ')}
				>
					{#if option.transition.kind === 'forward'}
						<form method="POST" action="?/advance" use:enhance={actionEnhance()}>
							<input type="hidden" name="fromStageId" value={currentStageId} />
							<input type="hidden" name="toStageId" value={option.toStage.id} />
							<Button
								type="submit"
								size="sm"
								class="w-full min-w-0"
								title={label}
								disabled={!option.allowed}
							>
								<ArrowRightIcon aria-hidden="true" />
								<span class="truncate">{label}</span>
							</Button>
						</form>
					{:else}
						<Button
							type="button"
							size="sm"
							variant="outline"
							class="w-full min-w-0"
							title={label}
							disabled={!option.allowed}
							onclick={() =>
								(reasonDialog = {
									action: option.transition.kind === 'return' ? 'return' : 'skip',
									toStageId: option.toStage.id,
									name: option.toStage.name
								})}
						>
							{#if option.transition.kind === 'return'}
								<CornerUpLeftIcon aria-hidden="true" />
							{:else}
								<SkipForwardIcon aria-hidden="true" />
							{/if}
							<span class="truncate">{label}</span>
						</Button>
					{/if}
					{#if !option.allowed}
						<p class="text-xs text-muted-foreground">{option.reasons[0]}</p>
					{/if}
				</div>
			{/each}

			{#if can('pause')}
				<Button type="button" size="sm" variant="outline" onclick={() => (pauseOpen = true)}>
					<PauseIcon aria-hidden="true" />
					Поставить на паузу
				</Button>
			{/if}

			{#if can('resume')}
				<form method="POST" action="?/resume" use:enhance={actionEnhance()}>
					<input type="hidden" name="fromStageId" value={currentStageId} />
					<Button type="submit" size="sm" variant="outline" class="w-full">
						<PlayIcon aria-hidden="true" />
						Снять паузу
					</Button>
				</form>
			{/if}

			{@render closing?.()}
		</Card.Content>
	</Card.Root>
</div>

<Dialog.Root
	open={reasonDialog !== null}
	onOpenChange={(open) => {
		if (!open) reasonDialog = null;
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>
				{reasonDialog?.action === 'return' ? 'Вернуть на стадию' : 'Пропустить стадии'}
			</Dialog.Title>
			<Dialog.Description>
				{reasonDialog === null ? '' : `Стадия: ${reasonDialog.name}.`} Причина попадёт в историю взаимодействия.
			</Dialog.Description>
		</Dialog.Header>

		<form
			method="POST"
			action={reasonDialog?.action === 'return' ? '?/return' : '?/skip'}
			use:enhance={actionEnhance({ onsuccess: () => (reasonDialog = null) })}
			class="flex flex-col gap-4"
		>
			<input type="hidden" name="fromStageId" value={currentStageId} />
			<input type="hidden" name="toStageId" value={reasonDialog?.toStageId ?? ''} />

			<label class="flex flex-col gap-1.5 text-sm">
				<span>Причина</span>
				<Textarea name="reason" rows={3} required placeholder="Что именно пошло не так" />
			</label>

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (reasonDialog = null)}>Отмена</Button
				>
				<Button type="submit">Подтвердить</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={pauseOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Поставить стадию на паузу</Dialog.Title>
			<Dialog.Description>
				Часы норматива остановятся: ждать ответа и не успеть — разные вещи.
			</Dialog.Description>
		</Dialog.Header>

		<form
			method="POST"
			action="?/pause"
			use:enhance={actionEnhance({ onsuccess: () => (pauseOpen = false) })}
			class="flex flex-col gap-4"
		>
			<input type="hidden" name="fromStageId" value={currentStageId} />

			<label class="flex flex-col gap-1.5 text-sm">
				<span>Причина</span>
				<select
					name="reason"
					class="h-control rounded-md border border-input bg-background px-2 text-sm focus-ring"
				>
					{#each PAUSE_REASONS as reason (reason)}
						<option value={reason}>{PAUSE_LABELS[reason]}</option>
					{/each}
				</select>
			</label>

			<label class="flex flex-col gap-1.5 text-sm">
				<span>Чего ждём</span>
				<Textarea name="note" rows={2} required placeholder="Например: подписи ректора" />
			</label>

			<label class="flex flex-col gap-1.5 text-sm">
				<span>Следующий шаг</span>
				<Textarea name="nextAction" rows={2} placeholder="Что сделаем, когда дождёмся" />
			</label>

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (pauseOpen = false)}>Отмена</Button>
				<Button type="submit">Поставить на паузу</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
