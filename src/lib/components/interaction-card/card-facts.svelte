<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDate } from '$lib/format';
	import { isCurrentState } from './stage-look';
	import type { CardModel } from './model';
	import QuietNote from './quiet-note.svelte';
	import StageList from './stage-list.svelte';
	import StageStrip from './stage-strip.svelte';
	import TimingBadge from './timing-badge.svelte';

	/**
	 * Верх карточки: три факта — с кем работаем, кто отвечает и на каких
	 * условиях, — и под ними процесс: где стоим, сколько осталось и куда дальше,
	 * названиями и полосой. Условия зависят от контрагента: вуз и юридическое
	 * лицо работают по договору, физическое лицо — по оплате. Все стадии
	 * раскрываются столбиком по требованию, пройденные в нём свёрнуты в строку.
	 * Если по записи давно тихо, это сказано здесь же словами.
	 */
	let { model }: { model: CardModel } = $props();

	/**
	 * Следующая стадия — по порядку процесса, как её показывает полоса:
	 * первая из тех, что впереди текущей. Нет такой — дальше завершение.
	 */
	const next = $derived.by(() => {
		const here = model.stages.findIndex((stage) => isCurrentState(stage.state));

		if (here === -1) return null;

		return {
			stage: model.stages.slice(here + 1).find((stage) => stage.state === 'pending') ?? null
		};
	});
</script>

<!-- `data-tour` — метка подсказок: по ней тур находит факты и процесс. -->
<section
	class="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-4"
	aria-label="Ключевые факты"
	data-tour="interaction-timeline"
>
	<dl class="grid gap-x-6 gap-y-3 sm:grid-cols-3">
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
		{#if model.shape === 'person'}
			<div class="min-w-0">
				<dt class="text-xs text-muted-foreground">Оплата</dt>
				<dd class="mt-0.5 text-sm">
					<StatusBadge tone={model.payment.tone} dot>{model.payment.text}</StatusBadge>
				</dd>
			</div>
		{:else}
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
		{/if}
	</dl>

	{#if model.stages.length > 0}
		<div class="flex flex-col gap-2 border-t border-border pt-4" data-slot="card-process">
			{#if model.stage !== null}
				<dl class="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
					<div class="min-w-0">
						<dt class="text-xs text-muted-foreground">
							Стадия <span class="tabular-nums">{model.stage.position} из {model.stage.total}</span>
						</dt>
						<dd class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
							<span class="font-medium break-words">{model.stage.name}</span>
							{#if model.timing !== null}
								<TimingBadge timing={model.timing} />
							{/if}
						</dd>
					</div>
					{#if next !== null}
						<div class="min-w-0 sm:text-right">
							<dt class="text-xs text-muted-foreground">Дальше</dt>
							<dd class="mt-0.5 text-sm break-words">
								{#if next.stage !== null}
									<span class="tabular-nums">{next.stage.position}.</span>
									{next.stage.name}
								{:else}
									Завершение взаимодействия
								{/if}
							</dd>
						</div>
					{/if}
				</dl>
			{/if}
			<StageStrip stages={model.stages} />
			<details class="group">
				<summary
					class="flex w-fit list-none items-center gap-1 rounded-sm text-xs text-link focus-ring hover:text-link-hover hover:underline [&::-webkit-details-marker]:hidden"
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
