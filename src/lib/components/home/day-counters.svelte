<script lang="ts">
	import { MY_DAY_KINDS, MY_DAY_SECTIONS, type MyDaySection } from '$lib/contracts/my-day';
	import { formatNumber } from '$lib/format';
	import { cn } from '$lib/utils';
	import { MY_DAY_KIND_VIEW, myDayAnchor, type MyDayTone } from './my-day-kinds';

	/**
	 * «Мой день» одной строкой: сколько дел в каждом разделе. Это первое, что
	 * видит сотрудник после входа, поэтому здесь все восемь разделов, включая
	 * пустые: ноль тоже ответ — «здесь спокойно».
	 *
	 * Непустой счётчик — ссылка на карточку раздела ниже, обычный якорь:
	 * работает с клавиатуры, с «назад» и без скрипта. Пустой — просто подпись,
	 * вести в нём некуда.
	 */
	let { sections }: { sections: readonly MyDaySection[] } = $props();

	const totals = $derived(new Map(sections.map((section) => [section.kind, section.total])));

	const numberTone: Record<MyDayTone, string> = {
		danger: 'text-danger',
		warning: 'text-warning-soft-foreground',
		info: 'text-info-soft-foreground',
		neutral: 'text-foreground'
	};

	/** Полоса слева: тревожный цвет виден и тому, кто не различает оттенки чисел. */
	const barTone: Record<MyDayTone, string> = {
		danger: 'bg-danger',
		warning: 'bg-warning',
		info: 'bg-info',
		neutral: 'bg-border-strong'
	};
</script>

<ul
	class="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-8"
	aria-label="Мой день по разделам"
	data-slot="day-counters"
>
	{#each MY_DAY_KINDS as kind (kind)}
		{@const view = MY_DAY_KIND_VIEW[kind]}
		{@const total = totals.get(kind) ?? 0}
		<!-- Пустой раздел на телефоне прячется: там ряд из восьми плиток — полэкрана,
			а ноль ничего не просит. На ноутбуке он остаётся, чтобы было видно, что
			разделов восемь и остальные спокойны. -->
		<li class={cn('min-w-0', total === 0 && 'max-sm:hidden')}>
			{#if total === 0}
				<div
					class="flex h-full flex-col gap-1 rounded-lg border border-border bg-surface px-2 py-2 sm:px-3"
					title={MY_DAY_SECTIONS[kind].title}
				>
					<span class="truncate text-xs text-faint">{view.short}</span>
					<span class="text-xl leading-none font-semibold text-faint tabular-nums">0</span>
				</div>
			{:else}
				<a
					href="#{myDayAnchor(kind)}"
					class="relative flex h-full flex-col gap-1 overflow-hidden rounded-lg border border-border bg-surface py-2 pr-2 pl-3 focus-ring transition-colors hover:border-border-strong hover:bg-surface-muted sm:pr-3 sm:pl-4"
					title={MY_DAY_SECTIONS[kind].title}
					aria-label="{MY_DAY_SECTIONS[kind].title}: {total}. Перейти к разделу"
				>
					<span class={cn('absolute inset-y-0 left-0 w-1', barTone[view.tone])} aria-hidden="true"
					></span>
					<span class="truncate text-xs text-muted-foreground">{view.short}</span>
					<span
						class={cn('text-xl leading-none font-semibold tabular-nums', numberTone[view.tone])}
					>
						{formatNumber(total)}
					</span>
				</a>
			{/if}
		</li>
	{/each}
</ul>
