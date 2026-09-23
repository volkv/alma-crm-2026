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
		action,
		children
	}: {
		title: string;
		/** Команда раздела справа от заголовка: «Заявить поток», «Загрузить». */
		action?: Snippet;
		children: Snippet;
	} = $props();
</script>

<section class="flex min-w-0 flex-col gap-2" data-slot="context-section">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h3 class="text-xs font-semibold tracking-wide text-faint uppercase">{title}</h3>
		{@render action?.()}
	</div>
	{@render children()}
</section>
