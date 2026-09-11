<script lang="ts">
	import { page } from '$app/state';
	import { cn } from '$lib/utils';
	import { navLinks } from './nav-links';

	/**
	 * The list of sections. Shared by the desktop sidebar and the sheet on a
	 * phone, so a section is described once and looks the same in both.
	 */
	let {
		collapsed = false,
		onnavigate
	}: {
		/** Icons only; the label moves into the tooltip. */
		collapsed?: boolean;
		/** Called on every link click — the sheet uses it to close itself. */
		onnavigate?: () => void;
	} = $props();
</script>

<nav class="flex flex-col gap-0.5 p-2" aria-label="Разделы">
	{#each navLinks as link (link.href)}
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
</nav>
