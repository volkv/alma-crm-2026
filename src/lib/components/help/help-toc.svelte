<script lang="ts">
	import { resolve } from '$app/paths';
	import type { HelpPageLink, HelpSection } from '$lib/help';
	import { cn } from '$lib/utils';

	/**
	 * Оглавление раздела слева от статьи: где читатель находится и что идёт
	 * рядом. Список приходит пропом — компонент ничего не загружает.
	 */
	let {
		section,
		pages,
		current
	}: {
		section: HelpSection;
		pages: readonly HelpPageLink[];
		/** Адрес открытой статьи; `null` — оглавление показывают без статьи. */
		current?: string | null;
	} = $props();
</script>

<nav aria-label={section.title} class="flex flex-col gap-1">
	<p class="px-2.5 pb-1 text-xs font-medium text-muted-foreground">{section.title}</p>
	{#each pages as page (page.slug)}
		{@const active = page.slug === current}
		<a
			href={resolve('/(app)/help/[section]/[page]', { section: page.section, page: page.slug })}
			aria-current={active ? 'page' : undefined}
			class={cn(
				'rounded-md px-2.5 py-1.5 text-sm focus-ring transition-colors',
				active
					? 'bg-selection font-medium text-selection-foreground'
					: 'text-muted-foreground hover:bg-surface-muted hover:text-foreground'
			)}
		>
			{page.title}
		</a>
	{/each}
</nav>
