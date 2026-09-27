<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import type { LayoutProps } from './$types';

	/**
	 * Оболочка раздела настроек: заголовок с хлебными крошками, под ним — сам
	 * подраздел. Заголовок принадлежит этому слою, поэтому подразделы рисуют
	 * только своё содержимое и не заводят второй `<h1>`.
	 *
	 * Своей навигации у слоя нет: каждый подраздел стоит отдельным пунктом
	 * главного меню (`$lib/nav`), и полоса вкладок повторяла бы его — второй
	 * список тех же шести ссылок на той же странице.
	 */
	let { data, children }: LayoutProps = $props();

	// Раздел владеет своим адресом и всем, что ниже: страница одного процесса —
	// это по-прежнему «Процесс», и подсветка в меню обязана это показывать.
	const current = $derived(
		data.sections.find(
			(section) =>
				section.href === page.url.pathname || page.url.pathname.startsWith(`${section.href}/`)
		)
	);

	/**
	 * Как называется то, что открыто внутри раздела: имя процесса, а не слово
	 * «Настройки». Заголовок принадлежит этому слою, а что именно открыто,
	 * знает только сама страница, — она и кладёт название в данные.
	 */
	const inner = $derived(
		typeof page.data.settingsTitle === 'string' ? page.data.settingsTitle : null
	);
	const description = $derived(
		typeof page.data.settingsDescription === 'string'
			? page.data.settingsDescription
			: current?.description
	);
</script>

<Header title={inner ?? current?.label ?? 'Настройки'} {description} />

<Breadcrumbs
	items={[
		{ label: 'Настройки' },
		...(inner !== null && current !== undefined
			? [{ label: current.label, href: resolve(current.href) }]
			: []),
		{ label: inner ?? current?.label ?? 'Настройки' }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<div class="flex min-w-0 flex-col gap-4">
		{@render children()}
	</div>
</div>
