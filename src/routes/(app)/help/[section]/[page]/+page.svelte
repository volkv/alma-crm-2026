<script lang="ts">
	import { resolve } from '$app/paths';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { Button } from '$lib/components/ui/button/index.js';
	import HelpArticle from '$lib/components/help/help-article.svelte';
	import HelpToc from '$lib/components/help/help-toc.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.article.title} — Справка — LCT CRM</title>
</svelte:head>

<Header title={data.article.title} description={data.article.summary} />

<Breadcrumbs
	items={[
		{ label: 'Главная', href: resolve('/') },
		{ label: 'Справка', href: resolve('/(app)/help') },
		{ label: data.article.title }
	]}
/>

<!-- Оглавление слева отдельной колонкой, а на телефоне — над статьёй: читать
	руководство по одной странице, не видя соседних, всё равно что читать
	оглавление вместо книги. -->
<div class="flex flex-col gap-6 p-4 sm:px-9 sm:py-6 lg:flex-row lg:gap-8">
	<div class="lg:w-56 lg:shrink-0">
		<HelpToc section={data.section} pages={data.pages} current={data.article.slug} />
	</div>

	<div class="flex min-w-0 flex-1 flex-col gap-6">
		<HelpArticle html={data.article.html} />

		<nav
			class="flex flex-wrap justify-between gap-2 border-t border-border pt-4"
			aria-label="По разделу"
		>
			{#if data.previous}
				<Button
					variant="outline"
					href={resolve('/(app)/help/[section]/[page]', {
						section: data.previous.section,
						page: data.previous.slug
					})}
				>
					<ChevronLeftIcon aria-hidden="true" />
					{data.previous.title}
				</Button>
			{:else}
				<span></span>
			{/if}

			{#if data.next}
				<Button
					variant="outline"
					href={resolve('/(app)/help/[section]/[page]', {
						section: data.next.section,
						page: data.next.slug
					})}
				>
					{data.next.title}
					<ChevronRightIcon aria-hidden="true" />
				</Button>
			{/if}
		</nav>
	</div>
</div>
