<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import MenuIcon from '@lucide/svelte/icons/menu';
	import SearchIcon from '@lucide/svelte/icons/search';
	import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
	import PanelLeftOpenIcon from '@lucide/svelte/icons/panel-left-open';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import type { SessionUser } from '$lib/server/auth/types';
	import AppNav from './app-nav.svelte';
	import CommandPalette from './command-palette.svelte';
	import UserMenu from './user-menu.svelte';
	import { createNavCollapse } from './nav-collapse.svelte';
	import { sectionFor } from './nav-links';

	/**
	 * The frame every page of the application sits in: sections on the left, the
	 * current section and the account on top, the page itself in the middle. A
	 * page renders only its own content — the shell owns navigation, search and
	 * the toast outlet, so none of that is repeated per route.
	 */
	let {
		user,
		children
	}: {
		/** `null` until the session lands; the shell then shows no account menu. */
		user: SessionUser | null;
		children: Snippet;
	} = $props();

	const nav = createNavCollapse();

	let mobileNavOpen = $state(false);
	let searchOpen = $state(false);

	const sectionTitle = $derived(sectionFor(page.url.pathname)?.label ?? 'LCT CRM');

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			searchOpen = true;
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="flex min-h-screen bg-canvas">
	<aside
		class="hidden shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150 md:flex {nav.collapsed
			? 'w-14'
			: 'w-60'}"
	>
		<div
			class="flex h-14 shrink-0 items-center border-b border-border px-3 {nav.collapsed
				? 'justify-center'
				: 'gap-2'}"
		>
			<span
				class="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
				aria-hidden="true">CRM</span
			>
			{#if !nav.collapsed}
				<span class="truncate text-sm font-semibold tracking-tight">LCT CRM</span>
			{/if}
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto">
			<AppNav collapsed={nav.collapsed} />
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
					<AppNav onnavigate={() => (mobileNavOpen = false)} />
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

<CommandPalette bind:open={searchOpen} />
<Toaster position="bottom-right" closeButton />
