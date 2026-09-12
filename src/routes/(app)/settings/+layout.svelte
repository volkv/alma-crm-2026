<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import PageHeader from '$lib/components/page-header.svelte';
	import { cn } from '$lib/utils';
	import type { LayoutProps } from './$types';

	/**
	 * Оболочка раздела настроек: слева список подразделов, справа — сам раздел.
	 * Заголовок страницы принадлежит этому слою, поэтому подразделы рисуют
	 * только своё содержимое и не заводят второй `<h1>`.
	 */
	let { data, children }: LayoutProps = $props();

	const current = $derived(data.sections.find((section) => section.href === page.url.pathname));
</script>

<PageHeader
	title={current?.label ?? 'Настройки'}
	description={current?.description}
	breadcrumbs={[{ label: 'Главная', href: resolve('/') }, { label: 'Настройки' }]}
/>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<!-- Подразделы горизонтально, а не колонкой сбоку: списки пользователей и
		ключей широкие, и боковое меню отнимало бы у них колонку на обычном
		ноутбуке. -->
	<nav class="flex flex-row flex-wrap gap-1 border-b border-border pb-2" aria-label="Настройки">
		{#each data.sections as section (section.href)}
			{@const active = page.url.pathname === section.href}
			<a
				href={resolve(section.href)}
				aria-current={active ? 'page' : undefined}
				class={cn(
					'flex h-control items-center rounded-md px-2.5 text-sm focus-ring transition-colors',
					active
						? 'bg-primary-soft font-medium text-primary'
						: 'text-muted-foreground hover:bg-surface-muted hover:text-foreground'
				)}
			>
				{section.label}
			</a>
		{/each}
	</nav>

	<div class="flex min-w-0 flex-col gap-4">
		{@render children()}
	</div>
</div>
