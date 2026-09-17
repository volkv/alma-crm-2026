<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { Button } from '$lib/components/ui/button/index.js';
	import HelpArticle from '$lib/components/help/help-article.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/**
	 * Оглавление собирается из тех же данных, что и текст: отдельный список
	 * разошёлся бы с ним на первой же новой статье.
	 */
	const contents = $derived(
		data.sections.map((section) => ({
			key: section.key,
			title: section.title,
			articles: section.articles.map((article) => ({
				id: `${article.section}-${article.slug}`,
				title: article.title
			}))
		}))
	);
</script>

<svelte:head>
	<title>Справка целиком — LCT CRM</title>
</svelte:head>

<div class="mx-auto flex max-w-3xl flex-col gap-8 p-4 sm:p-6" data-help-print>
	<div class="flex flex-col gap-3">
		<div class="no-print">
			<Button variant="outline" href={resolve('/(app)/help')}>
				<ArrowLeftIcon aria-hidden="true" />
				К оглавлению
			</Button>
		</div>
		<h1 class="text-xl font-semibold tracking-tight">
			Система контроля взаимодействия с учебными заведениями
		</h1>
		<p class="text-sm text-muted-foreground">
			Руководство пользователя и руководство администратора одним документом.
		</p>
	</div>

	<nav aria-label="Содержание" class="flex flex-col gap-3">
		<h2 class="text-base font-semibold">Содержание</h2>
		{#each contents as section (section.key)}
			<div class="flex flex-col gap-1">
				<p class="text-sm font-medium">{section.title}</p>
				<ol class="list-decimal pl-6 text-sm text-muted-foreground">
					{#each section.articles as article (article.id)}
						<li>
							<a class="underline underline-offset-2" href="#{article.id}">{article.title}</a>
						</li>
					{/each}
				</ol>
			</div>
		{/each}
	</nav>

	{#each data.sections as section (section.key)}
		<section class="flex break-before-page flex-col gap-6">
			<h2 class="border-b border-border pb-2 text-lg font-semibold">{section.title}</h2>
			{#each section.articles as article (article.slug)}
				<article id="{article.section}-{article.slug}" class="flex flex-col gap-3">
					<h3 class="text-base font-semibold">{article.title}</h3>
					<HelpArticle html={article.html} />
				</article>
			{/each}
		</section>
	{/each}
</div>

<style>
	@media print {
		/* Оболочка приложения в документ не идёт: боковая навигация, верхняя
		   панель, полоса демо-режима и всплывающие слои — это экран, а не
		   руководство. Печатная страница — единственная, где такое правило
		   уместно, поэтому оно живёт здесь, а не в общих стилях.
		
		   Соседи `main` внутри колонки оболочки, а не перечень классов: полосу
		   демо-режима и шапку рисует `AppShell`, и список её классов здесь
		   разошёлся бы с ней на первой же правке. */
		:global(aside),
		:global(div:has(> main) > *:not(main)),
		:global([data-sonner-toaster]) {
			display: none !important;
		}

		:global(body) {
			background: white;
		}

		.no-print {
			display: none;
		}

		[data-help-print] {
			max-width: none;
			padding: 0;
		}

		/* Каждый раздел — с новой страницы; заголовок раздела не остаётся
		   висеть последней строкой предыдущей. */
		section {
			break-before: page;
		}

		section:first-of-type {
			break-before: auto;
		}

		h2,
		h3 {
			break-after: avoid;
		}

		article {
			break-inside: auto;
		}
	}
</style>
