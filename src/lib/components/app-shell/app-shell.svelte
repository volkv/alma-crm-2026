<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import SearchIcon from '@lucide/svelte/icons/search';
	import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
	import PanelLeftOpenIcon from '@lucide/svelte/icons/panel-left-open';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import { visibleSections, type NavWorkspace } from '$lib/nav';
	import { theme } from '$lib/theme.svelte';
	import type { SessionUser } from '$lib/server/auth/types';
	import AppDock from './app-dock.svelte';
	import AppNav from './app-nav.svelte';
	import CommandPalette from './command-palette.svelte';
	import UserMenu from './user-menu.svelte';
	import { createNavCollapse } from './nav-collapse.svelte';
	import { navLinks } from './nav-links';
	import { search } from './search.svelte';

	/**
	 * The frame every page of the application sits in: sections and the account
	 * on the left, the page itself filling the rest. A page renders its own
	 * content and its own header — the shell owns navigation, search and the
	 * toast outlet, so none of that is repeated per route.
	 *
	 * Своей верхней полосы у оболочки нет: заголовок страницы стоял в ней
	 * вторым, мелким шрифтом, над тем же заголовком этажом ниже. Шапка теперь
	 * одна и принадлежит странице (`$lib/components/header.svelte`) вместе со
	 * справкой и темой; поиск переехал в меню разделов. На телефоне, где меню
	 * нет, всё это держит нижняя панель (`app-dock.svelte`).
	 */
	let {
		user,
		workspaces = [],
		demoMode = false,
		demoResetHour = null,
		children
	}: {
		/** `null` until the session lands; the shell then shows no account menu. */
		user: SessionUser | null;
		/**
		 * Пространства из базы: каждое даёт свою секцию в панели. Пустой список —
		 * до входа: меню тогда не рисуется вовсе.
		 */
		workspaces?: readonly NavWorkspace[];
		/** Public demo: say so on every page, the data behind it is invented. */
		demoMode?: boolean;
		/**
		 * Час ежедневного сброса стенда по часам сервера; `null` — расписание
		 * выключено. Стенд общий, и наработанное на нём живёт до этого часа —
		 * сказать об этом надо там же, где сказано про выдуманные данные.
		 */
		demoResetHour?: number | null;
		children: Snippet;
	} = $props();

	const nav = createNavCollapse();

	// Час приходит числом по часам сервера — на экране он обязан выглядеть
	// временем: «в 3» читается как «в три чего-то».
	const resetTime = $derived(
		demoResetHour === null ? null : `${`${demoResetHour}`.padStart(2, '0')}:00`
	);
	// Раздел, на который у человека нет права, в меню не показывается: ссылка,
	// отвечающая 403, — это не навигация.
	const links = $derived(
		user === null ? [] : visibleSections(navLinks(workspaces), user.permissions)
	);

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			search.show();
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="flex min-h-screen bg-canvas">
	<!-- Первое, до чего доходит Tab: от начала страницы до таблицы иначе больше
		десяти нажатий через всё меню, и так на каждой странице. Ссылка не
		видна, пока не получит фокус, — тогда она встаёт в левом верхнем углу. -->
	<a
		href="#page-content"
		class="sr-only rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-md ring-1 focus-ring ring-border focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
	>
		К содержимому
	</a>

	<!-- Меню липкое и ростом в экран: на длинной странице — «Сводке», отчётах —
		уехавшая вверх навигация пропадала ровно там, где до неё дальше всего.
		Список разделов внутри прокручивается сам, поэтому меню длиннее экрана
		не обрезается. -->
	<!-- `data-tour` — метка для подсказок: по ней тур находит то, о чём говорит
		(`$lib/onboarding/screens`). -->
	<aside
		data-tour="nav"
		class="sticky top-0 z-30 hidden h-dvh shrink-0 flex-col self-start border-r border-border bg-surface transition-[width] duration-150 md:flex {nav.collapsed
			? 'w-14'
			: 'w-60'}"
	>
		<!-- Шапка меню: знак системы слева, кнопка сворачивания справа от него.
			Свёрнутое меню шириной в один значок, и двое рядом туда не встанут —
			но выгонять оттуда надо кнопку, а не знак: знак и есть то, по чему
			меню узнают, и он остаётся на месте в обоих состояниях. Кнопка у
			свёрнутого меню выходит за его правый край и встаёт в отступ
			страницы — места там ровно на неё, и с содержимым она не спорит. -->
		<div
			class="relative flex h-14 shrink-0 items-center border-b border-border {nav.collapsed
				? 'justify-center px-2'
				: 'gap-1 px-3'}"
		>
			<a
				href={resolve('/')}
				class="flex min-w-0 items-center gap-2 rounded-md focus-ring {nav.collapsed
					? ''
					: 'flex-1'}"
			>
				<span
					class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary px-1 text-xs font-semibold text-primary-foreground"
					aria-hidden="true">CRM</span
				>
				{#if !nav.collapsed}
					<span class="truncate text-sm font-semibold tracking-tight">LCT CRM</span>
				{/if}
			</a>
			<!-- Слой кнопки задан меню целиком: `position: sticky` заводит свой
				слой, и `z-index` изнутри против липкой шапки страницы не работает —
				меню стоит на `z-30`, шапка на `z-20`.

				Вынесенная кнопка стоит поверх страницы и потому приглушена: в
				полную силу она спорила с заголовком, рядом с которым висит. Под
				курсором и под фокусом с клавиатуры она возвращается целиком.

				По высоте её ставит `top`, а не сдвиг: нажатие у кнопок сдвигает их
				на пиксель вниз своим `translate`, и центрирование сдвигом оно
				стирало — кнопка при нажатии прыгала на пол-роста вниз. -->
			<Button
				variant="ghost"
				size="icon-sm"
				class="shrink-0 text-muted-foreground {nav.collapsed
					? 'absolute top-3.5 left-full ml-0.5 bg-surface opacity-30 transition-opacity hover:opacity-100 focus-visible:opacity-100'
					: ''}"
				aria-label={nav.collapsed ? 'Развернуть навигацию' : 'Свернуть навигацию'}
				onclick={() => nav.toggle()}
			>
				{#if nav.collapsed}
					<PanelLeftOpenIcon aria-hidden="true" />
				{:else}
					<PanelLeftCloseIcon aria-hidden="true" />
				{/if}
			</Button>
		</div>

		<!-- Поиск — первой строкой меню, а не в его подвале: это вход в систему
			наравне с разделами, им находят запись, когда не знают, в каком она
			разделе. У свёрнутого меню остаётся один значок, подпись и Ctrl+K
			уходят в название кнопки для читалки. -->
		<div class="shrink-0 border-b border-border p-2">
			<Button
				variant="outline"
				size="sm"
				data-tour="search"
				aria-label="Поиск по системе, Ctrl+K"
				class="w-full gap-2 text-muted-foreground {nav.collapsed
					? 'justify-center px-0'
					: 'justify-start'}"
				onclick={() => search.show()}
			>
				<SearchIcon aria-hidden="true" />
				{#if !nav.collapsed}
					<span>Поиск</span>
					<kbd
						class="ml-auto rounded border border-border bg-surface-muted px-1 font-sans text-[10px]"
					>
						Ctrl+K
					</kbd>
				{/if}
			</Button>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto">
			<AppNav {links} collapsed={nav.collapsed} />
		</div>

		<!-- Учётная запись стоит в подвале меню, а не в шапке страницы: кто
			вошёл и что ему открыто — один и тот же вопрос, и ответ на него читается в одном
			столбце. Шапка при этом остаётся про текущую страницу. -->
		{#if user}
			<div class="border-t border-border">
				<UserMenu {user} collapsed={nav.collapsed} side="right" />
			</div>
		{/if}
	</aside>

	<div class="flex min-w-0 flex-1 flex-col">
		<!-- `tabindex="-1"`: по ссылке «к содержимому» фокус обязан переехать сюда,
			а не остаться в начале страницы.

			Колонка, а не блок, ради порядка ниже: полоса демо-режима стоит в
			разметке первой, а на экране — третьей.

			Отступ снизу — под нижнюю панель телефона: она висит над страницей, и
			без отступа последняя строка списка остаётся под ней. -->
		<main
			id="page-content"
			tabindex="-1"
			class="flex min-w-0 flex-1 flex-col pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-0"
		>
			<!-- Полоса демо-режима стоит под шапкой и крошками страницы, а не над
				ними: сверху она сдвигала шапку вниз относительно шапки бокового меню,
				и две полосы, которые обязаны читаться одной строкой, расходились.

				Порядком её ставит на место `order`: шапка и крошки приходят внутри
				`children`, и разметкой полосу между ними не вписать. Шапка объявляет
				себя первой, крошки — вторыми, всё остальное идёт следом в порядке
				разметки (`$lib/components/header.svelte`). У страницы на старой
				шапке порядка нет — полоса остаётся над ней, как была. -->
			{#if demoMode}
				<div class="shrink-0" data-demo-banner>
					<p
						class="bg-warning-soft px-3 py-1 text-center text-xs text-warning-soft-foreground sm:px-4"
					>
						Демо-режим: вузы и продукты названы настоящие, люди, договоры и цифры — вымышленные{#if demoResetHour !== null}.
							Стенд общий, данные сбрасываются ежедневно в {resetTime}{/if}
					</p>
				</div>
			{/if}

			{@render children()}
		</main>
	</div>
</div>

<AppDock {links} {user} />

<CommandPalette bind:open={search.open} {links} />
<!-- Тост рисует свой слой со своими переменными: тему ему говорят отдельно,
	иначе он остаётся светлым посреди тёмной страницы. -->
<Toaster position="bottom-right" closeButton theme={theme.resolved} />
