<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	/**
	 * Адрес сайта — ссылкой, а не текстом: карточка организации, «Сведения с
	 * сайта» и паспорт то и дело показывают адрес, взятый из справочника или
	 * прочитанный с сайта, и до сих пор выводили его строкой без перехода.
	 *
	 * Ссылкой становится только http(s)-адрес: адрес мог прийти откуда угодно
	 * (карточка, ЕГРЮЛ, сайт вуза), и `javascript:`-строкой быть не должен —
	 * остальное показывается обычным текстом, как раньше.
	 *
	 * Текст ссылки — без схемы и без хвостового слеша (`bsuedu.ru`, а не
	 * `https://bsuedu.ru/`): так короче читать, а `href` ведёт по полному
	 * адресу. Кто хочет показать что-то своё, передаёт это `children`.
	 */
	let {
		href,
		class: className,
		children
	}: {
		href: string;
		class?: string;
		children?: Snippet;
	} = $props();

	const safe = $derived(/^https?:\/\//i.test(href));
	const label = $derived(href.replace(/^https?:\/\//i, '').replace(/\/$/, ''));
</script>

{#if safe}
	<a
		class={cn(
			'text-link underline-offset-2 focus-ring hover:text-link-hover hover:underline',
			className
		)}
		{href}
		target="_blank"
		rel="external noreferrer noopener"
	>
		{#if children}{@render children()}{:else}{label}{/if}
	</a>
{:else}
	<span class={className}>{href}</span>
{/if}
