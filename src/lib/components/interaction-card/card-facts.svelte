<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { formatDate } from '$lib/format';
	import type { CardModel } from './model';
	import QuietNote from './quiet-note.svelte';
	import StageList from './stage-list.svelte';
	import StageStrip from './stage-strip.svelte';
	import TimingBadge from './timing-badge.svelte';

	/**
	 * Верх карточки: четыре факта — с кем работаем, где стоим и сколько
	 * осталось, кто отвечает, по какому договору, — и процесс полосой. Названия
	 * стадий раскрываются столбиком по требованию, пройденные в нём свёрнуты в
	 * строку. Если по записи давно тихо, это сказано здесь же словами.
	 */
	let { model }: { model: CardModel } = $props();
</script>

<!-- `data-tour` — метка подсказок: по ней тур находит факты и процесс. -->
<section
	class="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-4"
	aria-label="Ключевые факты"
	data-tour="interaction-timeline"
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
			<dd class="mt-0.5 text-sm font-medium break-words">
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

	{#if model.stages.length > 0}
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
				<div class="mt-2">
					<StageList stages={model.stages} />
				</div>
			</details>
		</div>
	{/if}

	{#if model.quiet !== null}
		<QuietNote quiet={model.quiet} />
	{/if}
</section>
