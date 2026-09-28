<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Раздел контекста карточки: короткий заголовок и содержимое. Раздел не
	 * рамка — рамку и отступы задаёт раскладка, в которой разделы стоят
	 * (боковая колонка, раскрывающийся блок), — поэтому одна и та же панель
	 * встаёт в любой вариант карточки без переделки.
	 */
	let {
		title,
		titleAside,
		action,
		children
	}: {
		title: string;
		/** Мелкие кнопки вплотную к заголовку: справка, «Копировать всё». */
		titleAside?: Snippet;
		/** Команда раздела справа от заголовка: «Заявить поток», «Загрузить». */
		action?: Snippet;
		children: Snippet;
	} = $props();
</script>

<section class="flex min-w-0 flex-col gap-2" data-slot="context-section">
	<div class="flex flex-wrap items-center justify-between gap-2">
		{#if titleAside}
			<div class="flex items-center gap-1">
				<h3 class="section-overline">{title}</h3>
				{@render titleAside()}
			</div>
		{:else}
			<h3 class="section-overline">{title}</h3>
		{/if}
		{@render action?.()}
	</div>
	{@render children()}
</section>
