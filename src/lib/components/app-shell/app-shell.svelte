<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import MenuIcon from '@lucide/svelte/icons/menu';
	import SearchIcon from '@lucide/svelte/icons/search';
	import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
	import PanelLeftOpenIcon from '@lucide/svelte/icons/panel-left-open';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import { visibleSections } from '$lib/nav';
	import type { SessionUser } from '$lib/server/auth/types';
	import AppNav from './app-nav.svelte';
	import CommandPalette from './command-palette.svelte';
	import UserMenu from './user-menu.svelte';
	import { createNavCollapse } from './nav-collapse.svelte';
	import { navLinks, sectionFor } from './nav-links';

	/**
	 * The frame every page of the application sits in: sections on the left, the
	 * current section and the account on top, the page itself in the middle. A
	 * page renders only its own content — the shell owns navigation, search and
	 * the toast outlet, so none of that is repeated per route.
	 */
	let {
		user,
		demoMode = false,
		demoResetHour = null,
		children
	}: {
		/** `null` until the session lands; the shell then shows no account menu. */
		user: SessionUser | null;
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

	let mobileNavOpen = $state(false);
	let searchOpen = $state(false);

	const sectionTitle = $derived(sectionFor(page.url.pathname)?.label ?? 'LCT CRM');
	// Час приходит числом по часам сервера — на экране он обязан выглядеть
	// временем: «в 3» читается как «в три чего-то».
	const resetTime = $derived(
		demoResetHour === null ? null : `${`${demoResetHour}`.padStart(2, '0')}:00`
	);
	// Раздел, на который у человека нет права, в меню не показывается: ссылка,
	// отвечающая 403, — это не навигация.
	const links = $derived(user === null ? [] : visibleSections(navLinks, user.permissions));

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			searchOpen = true;
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="flex min-h-screen bg-canvas">
	<!-- Меню липкое и ростом в экран: на длинной странице — «Сводке», отчётах —
		уехавшая вверх навигация пропадала ровно там, где до неё дальше всего.
		Список разделов внутри прокручивается сам, поэтому меню длиннее экрана
		не обрезается. -->
	<aside
		class="sticky top-0 hidden h-dvh shrink-0 flex-col self-start border-r border-border bg-surface transition-[width] duration-150 md:flex {nav.collapsed
			? 'w-14'
			: 'w-60'}"
	>
		<a
			href={resolve('/')}
			class="flex h-14 shrink-0 items-center border-b border-border px-3 focus-ring {nav.collapsed
				? 'justify-center'
				: 'gap-2'}"
		>
			<span
				class="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
				aria-hidden="true">CRM</span
			>
			{#if !nav.collapsed}
				<span class="truncate text-sm font-semibold tracking-tight">LCT CRM</span>
			{:else}
				<span class="sr-only">LCT CRM — сводка</span>
			{/if}
		</a>

		<div class="min-h-0 flex-1 overflow-y-auto">
			<AppNav {links} collapsed={nav.collapsed} />
		</div>

		<div class="border-t border-border p-2">
			<Button
				variant="ghost"
				size="icon-sm"
				class="text-muted-foreground {nav.collapsed ? 'mx-auto' : ''}"
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
	</aside>

	<div class="flex min-w-0 flex-1 flex-col">
		{#if demoMode}
			<p
				class="shrink-0 bg-warning-soft px-3 py-1 text-center text-xs text-warning-soft-foreground sm:px-4"
			>
				Демо-режим: вузы и продукты названы настоящие, люди, договоры и цифры — вымышленные{#if demoResetHour !== null}.
					Стенд общий, данные сбрасываются ежедневно в {resetTime}{/if}
			</p>
		{/if}

		<header
			class="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 sm:px-4"
		>
			<Sheet.Root bind:open={mobileNavOpen}>
				<Sheet.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-sm"
							class="md:hidden"
							aria-label="Разделы"
						>
							<MenuIcon aria-hidden="true" />
						</Button>
					{/snippet}
				</Sheet.Trigger>
				<Sheet.Content side="left" class="w-64 p-0">
					<Sheet.Header class="h-14 justify-center border-b border-border px-4">
						<Sheet.Title class="text-sm font-semibold">LCT CRM</Sheet.Title>
						<Sheet.Description class="sr-only">Разделы системы</Sheet.Description>
					</Sheet.Header>
					<AppNav {links} onnavigate={() => (mobileNavOpen = false)} />
				</Sheet.Content>
			</Sheet.Root>

			<h2 class="min-w-0 truncate text-sm font-medium">{sectionTitle}</h2>

			<div class="ml-auto flex items-center gap-1.5">
				<Button
					variant="outline"
					size="sm"
					class="gap-2 text-muted-foreground"
					onclick={() => (searchOpen = true)}
				>
					<SearchIcon aria-hidden="true" />
					<span class="hidden sm:inline">Поиск</span>
					<kbd
						class="hidden rounded border border-border bg-surface-muted px-1 font-sans text-[10px] sm:inline"
						>Ctrl+K</kbd
					>
				</Button>
				{#if user}
					<UserMenu {user} />
				{/if}
			</div>
		</header>

		<main class="min-w-0 flex-1">
			{@render children()}
		</main>
	</div>
</div>

<CommandPalette bind:open={searchOpen} {links} />
<Toaster position="bottom-right" closeButton />
