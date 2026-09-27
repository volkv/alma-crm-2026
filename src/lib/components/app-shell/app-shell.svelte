<script lang="ts">
	import type { Snippet } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import SearchIcon from '@lucide/svelte/icons/search';
	import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
	import PanelLeftOpenIcon from '@lucide/svelte/icons/panel-left-open';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { AlmaLogo, AlmaMark } from '$lib/components/brand';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import { visibleSections, type NavWorkspace } from '$lib/nav';
	import { SEARCH_SHORTCUTS } from '$lib/search/shortcuts';
	import { theme } from '$lib/theme.svelte';
	import type { SessionUser } from '$lib/server/auth/types';
	import AppDock from './app-dock.svelte';
	import AppNav from './app-nav.svelte';
	import CommandPalette from './command-palette.svelte';
	import UserMenu from './user-menu.svelte';
	import { createNavCollapse } from './nav-collapse.svelte';
	import { createNavGroups, setNavGroups } from './nav-groups.svelte';
	import { navLinks } from './nav-links';
	import { mentions } from './mentions.svelte';
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
	// Свёрнутые группы меню — один экземпляр на оболочку: боковая панель и
	// выдвижное меню телефона показывают один и тот же список, и расходиться в
	// том, что в нём свёрнуто, им незачем.
	setNavGroups(createNavGroups());

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
	// Страницы внутри разделов для палитры — по тому же правилу.
	const shortcuts = $derived(
		user === null ? [] : visibleSections(SEARCH_SHORTCUTS, user.permissions)
	);

	// Колокольчик перечитывается на каждом переходе, и первый раз — при
	// загрузке: `afterNavigate` срабатывает и на ней (`mentions.svelte.ts`).
	afterNavigate(({ to }) => {
		if (user !== null && to !== null) {
			void mentions.refresh(to.url.pathname);
		}
	});

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
		class="sr-only rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-md ring-1 ring-border focus-ring focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
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
				<!-- Свёрнутое меню оставляет один знак, и имя ссылки тогда несёт он. -->
				{#if nav.collapsed}
					<AlmaMark size={32} label="Альма CRM" />
				{:else}
					<AlmaLogo size={32} wordClass="text-sm" />
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
			без отступа последняя строка списка остаётся под ней.

			Страница с доской взаимодействий с `sm` ростом не больше экрана:
			колонки крутятся внутри доски, и её полоса прокрутки вбок стоит у
			нижнего края экрана, а не под документом, который сначала надо
			пролистать. Остаток высоты доске отдают сама страница и доска
			(`flex-1 min-h-0`). -->
		<main
			id="page-content"
			tabindex="-1"
			class="flex min-w-0 flex-1 flex-col pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:has-[[data-slot=interactions-board]]:max-h-dvh md:pb-0"
		>
			<!-- Полоса демо-режима стоит под шапкой и крошками страницы, а не над
				ними: сверху она сдвигала шапку вниз относительно шапки бокового меню,
				и две полосы, которые обязаны читаться одной строкой, расходились.

				Порядком её ставит на место `order`: шапка и крошки приходят внутри
				`children`, и разметкой полосу между ними не вписать. Шапка объявляет
				себя первой, крошки — вторыми, всё остальное идёт следом в порядке
				разметки (`$lib/components/header.svelte`). У страницы на старой
				шапке порядка нет — полоса остаётся над ней, как была.

				Полоса нейтральная, а не предупреждающая: демо-стенд — это факт о
				среде, а не проблема с ней. Строка короткая — что это стенд и когда
				сброс, — а объяснение про вымышленные данные раскрывается по
				`<details>`: не мешает тем, кому оно не нужно, и доступно с
				клавиатуры тем, кому нужно. -->
			{#if demoMode}
				<div class="shrink-0" data-demo-banner>
					<details class="group bg-surface-muted text-muted-foreground">
						<summary
							class="flex list-none items-center justify-center gap-1 px-3 py-1 text-center text-xs sm:px-4 [&::-webkit-details-marker]:hidden"
						>
							<span class="cursor-pointer hover:text-foreground">
								Демо-стенд{#if demoResetHour !== null}
									· данные сбрасываются в {resetTime}{/if}
							</span>
							<ChevronDownIcon
								aria-hidden="true"
								class="size-3 shrink-0 cursor-pointer transition-transform group-open:rotate-180"
							/>
						</summary>
						<p class="border-t border-border px-3 pb-1.5 text-center text-xs sm:px-4">
							Вузы и продукты названы настоящие, люди, договоры и цифры — вымышленные. Стенд общий,
							наработанное на нём живёт до сброса.
						</p>
					</details>
				</div>
			{/if}

			{@render children()}
		</main>
	</div>
</div>

<AppDock {links} {user} />

<CommandPalette bind:open={search.open} {links} {shortcuts} />
<!-- Тост рисует свой слой со своими переменными: тему ему говорят отдельно,
	иначе он остаётся светлым посреди тёмной страницы. -->
<Toaster position="bottom-right" closeButton theme={theme.resolved} />
