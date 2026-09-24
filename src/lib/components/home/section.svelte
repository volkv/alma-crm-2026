<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils';

	/**
	 * Блок сводки: заголовок, пояснение к нему и содержимое в панели. Главная
	 * собрана из нескольких таких блоков, и общая рамка нужна ровно затем, чтобы
	 * они читались как один экран, а не как несколько разных страниц подряд.
	 *
	 * Заголовок блока — `<h2>`: `<h1>` на странице один и принадлежит шапке
	 * (`$lib/components/header.svelte`).
	 */
	let {
		title,
		description,
		action,
		class: className,
		children,
		...rest
	}: {
		title: string;
		description?: string;
		/** Одна ссылка или кнопка справа от заголовка. */
		action?: Snippet;
		class?: string;
		children: Snippet;
		/**
		 * Остальное уезжает на сам блок. Нужно это метке `data-tour`: подсказки
		 * показывают пальцем на конкретный блок страницы, а какой это блок,
		 * знает только тот, кто его ставит.
		 */
	} & HTMLAttributes<HTMLElement> = $props();
</script>

<section
	class={cn('flex min-w-0 flex-col rounded-xl border border-border bg-surface', className)}
	data-slot="home-section"
	{...rest}
>
	<header
		class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3"
	>
		<div class="min-w-0">
			<h2 class="section-title">{title}</h2>
			{#if description}
				<p class="mt-0.5 text-xs text-muted-foreground">{description}</p>
			{/if}
		</div>
		{#if action}
			<div class="shrink-0">{@render action()}</div>
		{/if}
	</header>

	{@render children()}
</section>
