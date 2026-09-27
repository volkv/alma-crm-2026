<script lang="ts">
	import { resolve } from '$app/paths';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { Button } from '$lib/components/ui/button/index.js';
	import AutomationMap from '$lib/components/help/automation-map.svelte';
	import HelpArticle from '$lib/components/help/help-article.svelte';
	import HelpToc from '$lib/components/help/help-toc.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.article.title} — Справка — Альма CRM</title>
</svelte:head>

<Header title={data.article.title} description={data.article.summary} />

<Breadcrumbs
	items={[
		{ label: 'Главное', href: resolve('/') },
		{ label: 'Справка', href: resolve('/(app)/help') },
		{ label: data.article.title }
	]}
/>

<!-- Оглавление слева отдельной колонкой, а на планшете — над статьёй: читать
	руководство по одной странице, не видя соседних, всё равно что читать
	оглавление вместо книги. На телефоне раскрытое оглавление занимало весь
	первый экран, и до статьи надо было листать, — там оно свёрнуто в раскрытие.
	Скрытая копия не попадает ни на экран, ни в дерево доступности. -->
<div class="flex flex-col gap-6 p-4 sm:px-9 sm:py-6 lg:flex-row lg:gap-8">
	<details class="group rounded-xl border border-border bg-surface sm:hidden">
		<summary
			class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4 text-sm font-medium focus-ring [&::-webkit-details-marker]:hidden"
		>
			Статьи раздела
			<ChevronDownIcon
				class="size-4 text-muted-foreground transition-transform group-open:rotate-180"
				aria-hidden="true"
			/>
		</summary>
		<div class="border-t border-border p-2">
			<HelpToc section={data.section} pages={data.pages} current={data.article.slug} />
		</div>
	</details>
	<div class="max-sm:hidden lg:w-56 lg:shrink-0">
		<HelpToc section={data.section} pages={data.pages} current={data.article.slug} />
	</div>

	<div class="flex min-w-0 flex-1 flex-col gap-6">
		<HelpArticle html={data.article.html} />

		{#if data.tail !== null}
			{#if data.automationMap !== null}
				<AutomationMap data={data.automationMap} />
			{:else}
				<p class="text-sm text-muted-foreground">
					Карта открывается с правом «Просмотр взаимодействий».
				</p>
			{/if}
			<HelpArticle html={data.tail} />
		{/if}

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
