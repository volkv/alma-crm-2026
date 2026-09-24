<script lang="ts">
	import type { Snippet } from 'svelte';
	import HelpMenu from '$lib/components/onboarding/help-menu.svelte';
	import ThemeToggle from '$lib/components/app-shell/theme-toggle.svelte';
	import MentionBell from '$lib/components/app-shell/mention-bell.svelte';

	/**
	 * Шапка страницы: что открыто, что с этим можно сделать и справка с темой
	 * с краю.
	 *
	 * Единственная шапка в приложении — верхней полосы у оболочки нет. Поэтому
	 * заголовок здесь полного роста (`<h1>`, 22px), а не повторяется мелким
	 * шрифтом этажом выше.
	 *
	 * Шапка владеет `<h1>` страницы: второй заголовок этого уровня страница
	 * заводить не должна.
	 */
	let {
		title,
		description,
		sticky = true,
		actions
	}: {
		title: string;
		description?: string;
		/**
		 * Остаётся ли шапка на виду при прокрутке — на широком экране. На телефоне
		 * она не липнет никогда: там она вместе с крошками занимает пятую часть
		 * экрана, и оставлять её на виду означает читать список в щель.
		 *
		 * По умолчанию да: заголовок и кнопки страницы нужны и на середине
		 * длинного списка. Выключают там, где шапка часть документа, — на
		 * печатной версии справки, например.
		 */
		sticky?: boolean;
		/** Кнопки страницы целиком, справа от заголовка. */
		actions?: Snippet;
	} = $props();

	let scrollY = $state(0);

	/**
	 * Прокрученная липкая шапка отдаёт пояснение обратно странице: заголовок с
	 * пояснением и рядом кнопок — это около восьмидесяти пикселей, и держать их
	 * над списком всю дорогу вниз незачем. Пояснение читают один раз, в начале, —
	 * дальше от шапки нужны только название и кнопки.
	 */
	const condensed = $derived(sticky && scrollY > 8);
</script>

<svelte:window bind:scrollY />

<!-- `order-first`: полоса демо-режима приходит от оболочки первой в разметке
	и обязана встать под шапкой и крошками (`app-shell/app-shell.svelte`).

	`data-tour="page-header"` — метка вступления подсказок: рамка вокруг
	заголовка говорит «речь об этом экране» (`$lib/onboarding/screens`). -->
<header
	data-tour="page-header"
	class="order-first border-b border-border bg-surface px-4 py-3 sm:px-9 {sticky
		? 'md:sticky md:top-0 md:z-20'
		: ''}"
>
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<h1 class="truncate text-xl font-semibold tracking-tight">{title}</h1>
			{#if description}
				<!-- Сетка в одну строку вместо высоты: `grid-rows-[0fr]` схлопывает
					пояснение любой длины без числа в стилях, а переход остаётся
					плавным — по `max-height` наугад он либо рвётся, либо ползёт.
					Схлопывается только там, где шапка липкая: на телефоне она уезжает
					вместе со страницей, и прятать в ней нечего. -->
				<div
					class="grid grid-rows-[1fr] opacity-100 transition-[grid-template-rows,opacity] duration-150 {condensed
						? 'md:grid-rows-[0fr] md:opacity-0'
						: ''}"
				>
					<p class="overflow-hidden text-sm text-muted-foreground">
						<span class="mt-1 block">{description}</span>
					</p>
				</div>
			{/if}
		</div>
		<!-- Ряд стоит по центру высоты шапки: значки справки и темы — квадраты в
			32 пикселя, и прижатые к верхней строке они висели выше заголовка, к
			которому не относятся.

			Без `shrink-0` намеренно. С ним ряд держит свою ширину в одну строку и
			после переноса под заголовок, и карточка с тремя кнопками растаскивала
			страницу вбок на телефоне. Сжиматься ему можно: ниже самой широкой
			кнопки он не станет — это его собственный минимальный размер, — а
			остальные переедут на следующие строки.

			Без кнопок страницы на телефоне ряда нет вовсе: пустой, он всё равно
			переносился на свою строку и добавлял под заголовок пустую полосу. -->
		<div class="flex-wrap items-center gap-2 self-center {actions ? 'flex' : 'hidden md:flex'}">
			{#if actions}
				{@render actions()}
			{/if}
			<!-- Справка и тема — не про эту страницу, а про систему вокруг неё, но
				стоят они здесь: до них должно быть одно нажатие с любого экрана, а
				единственная полоса, которая есть на каждом экране, теперь эта. На
				телефоне их держит нижняя панель (`app-shell/app-dock.svelte`). -->
			<div class="hidden items-center gap-1.5 md:flex">
				{#if actions}
					<span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
				{/if}
				<!-- Колокольчик упоминаний — первым: это единственный значок ряда,
					который говорит о чём-то новом для человека, а не о системе. -->
				<MentionBell />
				<HelpMenu />
				<!-- Обёртка несёт метку тура: рамка обводит кнопку целиком. -->
				<div data-tour="theme-toggle" class="flex shrink-0 items-center">
					<ThemeToggle />
				</div>
			</div>
		</div>
	</div>
</header>
