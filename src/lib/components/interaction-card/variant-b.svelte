<script lang="ts">
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDate } from '$lib/format';
	import ContextPanels from './context-panels.svelte';
	import EventFeed from './event-feed.svelte';
	import type { CardModel, CardSource } from './model';
	import PrimaryAction from './primary-action.svelte';
	import QuietNote from './quiet-note.svelte';
	import StageList from './stage-list.svelte';
	import TimingBadge from './timing-badge.svelte';

	/**
	 * Вариант B — «рабочее место»: экран поделён на «что делаю» и «что знаю».
	 * Слева процесс столбиком, и главное действие стоит прямо под текущей
	 * стадией — работа видна там, где она находится в процессе; пройденные
	 * стадии свёрнуты в строку, предстоящие перечислены. Справа — контекст
	 * стороны и лента событий. Ключевые факты — полосой под заголовком.
	 */
	let { model, source }: { model: CardModel; source: CardSource } = $props();
</script>

<Header title={model.title}>
	{#snippet actions()}
		{#if model.status !== 'active'}
			<StatusBadge tone={model.status === 'completed' ? 'success' : 'neutral'}>
				{model.status === 'completed' ? 'Завершено' : 'Отменено'}
			</StatusBadge>
		{/if}
	{/snippet}
</Header>

<div class="flex flex-col" data-variant="b">
	<dl
		class="grid grid-cols-2 gap-px border-b border-border bg-border md:grid-cols-4"
		aria-label="Ключевые факты"
	>
		<div class="min-w-0 bg-surface px-4 py-2.5 sm:px-6">
			<dt class="text-xs text-muted-foreground">Контрагент</dt>
			<dd class="text-sm font-medium break-words">{model.counterparty.name}</dd>
			{#if model.counterparty.kindLabel}
				<dd class="text-xs text-faint">{model.counterparty.kindLabel}</dd>
			{/if}
		</div>
		<div class="min-w-0 bg-surface px-4 py-2.5 sm:px-6">
			<dt class="text-xs text-muted-foreground">Стадия</dt>
			<dd class="mt-0.5 flex flex-col gap-1">
				{#if model.stage !== null}
					<span class="text-sm font-medium tabular-nums">
						{model.stage.position} из {model.stage.total}
					</span>
				{/if}
				{#if model.timing !== null}
					<TimingBadge timing={model.timing} />
				{/if}
			</dd>
		</div>
		<div class="min-w-0 bg-surface px-4 py-2.5 sm:px-6">
			<dt class="text-xs text-muted-foreground">Ответственный</dt>
			<dd class="text-sm font-medium">{model.responsible ?? 'не назначен'}</dd>
			{#if model.waitingFor !== null}
				<dd class="text-xs text-muted-foreground">ход за стороной: {model.waitingFor}</dd>
			{/if}
		</div>
		<div class="min-w-0 bg-surface px-4 py-2.5 sm:px-6">
			<dt class="text-xs text-muted-foreground">Договор</dt>
			{#if model.contract !== null}
				<dd class="text-sm font-medium tabular-nums">№ {model.contract.number}</dd>
				<dd class="text-xs text-muted-foreground">
					{model.contract.status}{model.contract.validUntil
						? `, до ${formatDate(model.contract.validUntil)}`
						: ''}
				</dd>
			{:else}
				<dd class="text-sm text-faint">не выбран</dd>
			{/if}
		</div>
	</dl>

	<div
		class="grid items-start gap-4 p-4 sm:px-9 sm:py-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]"
	>
		<section
			class="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4"
			aria-labelledby="b-process-title"
		>
			<h2 id="b-process-title" class="text-base font-semibold">Процесс</h2>

			{#if model.quiet !== null}
				<QuietNote quiet={model.quiet} compact />
			{/if}

			<StageList stages={model.stages} collapseDone>
				{#snippet current()}
					<div class="mt-1 rounded-lg border border-primary-soft-border bg-surface p-3 shadow-xs">
						<PrimaryAction action={model.action} secondary={model.secondary} id="b-action" />
					</div>
				{/snippet}
			</StageList>

			{#if model.action.kind === 'closed'}
				<PrimaryAction action={model.action} secondary={model.secondary} id="b-action-closed" />
			{/if}
		</section>

		<div class="flex min-w-0 flex-col gap-4">
			<aside class="rounded-xl border border-border bg-surface p-4" aria-label="Контекст">
				<ContextPanels {source} shape={model.shape} id="b-context" />
			</aside>
			<div class="rounded-xl border border-border bg-surface p-4">
				<EventFeed events={model.events} id="b-feed" initial={6} />
			</div>
		</div>
	</div>
</div>
