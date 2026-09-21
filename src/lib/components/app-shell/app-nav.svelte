<script lang="ts">
	import { page } from '$app/state';
	import { groupedSections } from '$lib/nav';
	import { cn } from '$lib/utils';
	import type { NavLink } from './nav-links';

	/**
	 * The list of sections under their group headings. Shared by the desktop
	 * sidebar and the sheet on a phone, so a section is described once and looks
	 * the same in both.
	 */
	let {
		links,
		collapsed = false,
		onnavigate
	}: {
		/** Sections this user may open; the shell filters them by permission. */
		links: readonly NavLink[];
		/** Icons only; the label moves into the tooltip, the headings into rules. */
		collapsed?: boolean;
		/** Called on every link click — the sheet uses it to close itself. */
		onnavigate?: () => void;
	} = $props();

	// Заголовок группы подписывает её список через `aria-labelledby`, а меню
	// стоит на странице дважды — в боковой панели и в выдвижной на телефоне, —
	// поэтому идентификатор у каждого экземпляра свой.
	const uid = $props.id();

	const groups = $derived(groupedSections(links));
</script>

<nav class="flex flex-col p-2" aria-label="Разделы">
	{#each groups as group, index (group.id)}
		{@const headingId = `${uid}-${group.id}`}
		<!-- В свёрнутом меню подписи негде стоять: группы делит тонкая линия, а
			название группы остаётся только для читалки. Первая группа идёт сразу
			под шапкой — линия над ней удвоила бы границу шапки. -->
		{#if index > 0}
			<div
				class={cn('my-2 border-t border-border', collapsed ? 'mx-2' : 'mx-2.5')}
				aria-hidden="true"
			></div>
		{/if}
		<div role="group" aria-labelledby={headingId} class="flex flex-col gap-0.5">
			<p
				id={headingId}
				class={collapsed
					? 'sr-only'
					: 'px-2.5 pt-1 pb-1.5 text-xs font-medium text-muted-foreground'}
			>
				{group.label}
			</p>
			{#each group.sections as link (link.href)}
				{@const Icon = link.icon}
				{@const active =
					page.url.pathname === link.href || page.url.pathname.startsWith(`${link.href}/`)}
				<a
					href={link.href}
					title={collapsed ? link.label : undefined}
					aria-current={active ? 'page' : undefined}
					onclick={onnavigate}
					class={cn(
						'flex h-control items-center gap-2.5 rounded-md px-2.5 text-sm focus-ring transition-colors',
						collapsed && 'justify-center px-0',
						active
							? 'bg-primary-soft font-medium text-primary'
							: 'text-muted-foreground hover:bg-surface-muted hover:text-foreground'
					)}
				>
					<Icon class="size-4 shrink-0" aria-hidden="true" />
					{#if !collapsed}
						<span class="truncate">{link.label}</span>
					{/if}
				</a>
			{/each}
		</div>
	{/each}
</nav>
