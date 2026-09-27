<script lang="ts">
	import { resolve } from '$app/paths';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import { moduleSectionUi } from '$lib/platform/sections-registry';
	import type { PageProps } from './$types';

	/**
	 * Страница модуля. Шапка и крошки — те же, что у соседних страниц
	 * пространства; тело рисует компонент раздела из `sections.ts` модуля.
	 * Загрузчик уже проверил, что раздел есть, поэтому компонент есть тоже:
	 * реестр не пускает в сборку раздел без компонента.
	 */
	let { data }: PageProps = $props();

	const ui = $derived(moduleSectionUi(data.module, data.section));
	const Section = $derived(ui?.component);
</script>

<svelte:head>
	<title>{data.title} — Альма CRM</title>
</svelte:head>

<Header title={data.title} description={ui?.description} />

<Breadcrumbs
	items={[
		{
			label: data.workspace.name,
			href: resolve('/(app)/w/[workspace]/interactions', { workspace: data.workspace.key })
		},
		{ label: data.title }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	{#if Section}
		<Section data={data.sectionData} workspace={data.workspace} />
	{/if}
</div>
