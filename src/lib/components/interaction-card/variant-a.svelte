<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDate } from '$lib/format';
	import ContextPanels from './context-panels.svelte';
	import EventFeed from './event-feed.svelte';
	import type { CardModel, CardSource } from './model';
	import PrimaryAction from './primary-action.svelte';
	import QuietNote from './quiet-note.svelte';
	import StageList from './stage-list.svelte';
	import StageStrip from './stage-strip.svelte';
	import TimingBadge from './timing-badge.svelte';

	/**
	 * Вариант A — «документ»: карточка читается сверху вниз одной колонкой.
	 * Сначала четыре факта и процесс полосой, под ними — единственное главное
	 * действие с тем, что ему мешает, дальше лента событий. Контекст (сторона,
	 * договор, обучение, документы) стоит узкой колонкой сбоку на рабочем
	 * экране и сворачивается в раскрывающийся блок на телефоне.
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

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6" data-variant="a">
	<section
		class="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4"
		aria-label="Ключевые факты"
	>
		<dl class="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
			<div class="min-w-0">
				<dt class="text-xs text-muted-foreground">Контрагент</dt>
				<dd class="mt-0.5 text-sm font-medium break-words">
					{model.counterparty.name}
					{#if model.counterparty.kindLabel}
						<span class="block text-xs font-normal text-faint">{model.counterparty.kindLabel}</span>
					{/if}
				</dd>
			</div>
			<div class="min-w-0">
				<dt class="text-xs text-muted-foreground">Стадия</dt>
				<dd class="mt-0.5 flex flex-col gap-1 text-sm">
					{#if model.stage !== null}
						<span class="font-medium break-words">
							<span class="tabular-nums">{model.stage.position} из {model.stage.total}</span> · {model
								.stage.name}
						</span>
					{:else}
						<span class="text-faint">—</span>
					{/if}
					{#if model.timing !== null}
						<TimingBadge timing={model.timing} />
					{/if}
				</dd>
			</div>
			<div class="min-w-0">
				<dt class="text-xs text-muted-foreground">Ответственный</dt>
				<dd class="mt-0.5 text-sm font-medium">
					{model.responsible ?? 'не назначен'}
					{#if model.waitingFor !== null}
						<span class="block text-xs font-normal text-muted-foreground">
							ход за стороной: {model.waitingFor}
						</span>
					{/if}
				</dd>
			</div>
			<div class="min-w-0">
				<dt class="text-xs text-muted-foreground">Договор</dt>
				<dd class="mt-0.5 text-sm">
					{#if model.contract !== null}
						<span class="font-medium tabular-nums">№ {model.contract.number}</span>
						<span class="block text-xs text-muted-foreground">
							{model.contract.status}{model.contract.validUntil
								? `, до ${formatDate(model.contract.validUntil)}`
								: ''}
						</span>
					{:else}
						<span class="text-faint">не выбран</span>
					{/if}
				</dd>
			</div>
		</dl>

		<div class="flex flex-col gap-1">
			<StageStrip stages={model.stages} />
			<details class="group">
				<summary
					class="flex w-fit list-none items-center gap-1 rounded-sm text-xs text-primary focus-ring hover:underline [&::-webkit-details-marker]:hidden"
				>
					<ChevronRightIcon
						class="size-3.5 transition-transform group-open:rotate-90"
						aria-hidden="true"
					/>
					Все стадии процесса
				</summary>
				<div class="mt-2 sm:columns-2">
					<StageList stages={model.stages} />
				</div>
			</details>
		</div>

		{#if model.quiet !== null}
			<QuietNote quiet={model.quiet} />
		{/if}
	</section>

	<div
		class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_20rem]"
	>
		<div class="flex min-w-0 flex-col gap-4">
			<div class="rounded-xl border border-border bg-surface p-4 shadow-xs">
				<PrimaryAction action={model.action} secondary={model.secondary} id="a-action" />
			</div>

			<!-- На телефоне контекст стоит между действием и лентой и свёрнут:
				первым делом нужно понять, что делать, а реквизиты — по запросу. -->
			<details class="group rounded-xl border border-border bg-surface lg:hidden">
				<summary
					class="flex list-none items-center justify-between gap-2 rounded-xl p-4 text-sm font-medium focus-ring [&::-webkit-details-marker]:hidden"
				>
					Контрагент, договор, документы
					<ChevronRightIcon
						class="size-4 text-muted-foreground transition-transform group-open:rotate-90"
						aria-hidden="true"
					/>
				</summary>
				<div class="border-t border-border p-4">
					<ContextPanels {source} shape={model.shape} id="a-context-narrow" />
				</div>
			</details>

			<div class="rounded-xl border border-border bg-surface p-4">
				<EventFeed events={model.events} id="a-feed" />
			</div>
		</div>

		<aside
			class="hidden rounded-xl border border-border bg-surface p-4 lg:sticky lg:top-24 lg:block"
			aria-label="Контекст"
		>
			<ContextPanels {source} shape={model.shape} id="a-context" />
		</aside>
	</div>
</div>
