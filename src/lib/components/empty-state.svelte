<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LucideIcon } from '@lucide/svelte';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import { cn } from '$lib/utils';

	/**
	 * What a section shows when it has nothing to show: why it is empty and the
	 * one thing the user can do about it. Use it for "nothing here yet" and for
	 * "the filter matched nothing" — never for a failure, which is `ErrorState`.
	 */
	let {
		icon = InboxIcon,
		title,
		description,
		action,
		class: className
	}: {
		icon?: LucideIcon;
		title: string;
		description?: string;
		/** The single action that fills the emptiness — usually one button. */
		action?: Snippet;
		class?: string;
	} = $props();

	const Icon = $derived(icon);
</script>

<div
	class={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}
	data-slot="empty-state"
>
	<span
		class="flex size-10 items-center justify-center rounded-full bg-surface-muted text-muted-foreground"
	>
		<Icon class="size-5" aria-hidden="true" />
	</span>
	<div class="space-y-1">
		<p class="text-sm font-medium">{title}</p>
		{#if description}
			<p class="mx-auto max-w-md text-sm text-muted-foreground">{description}</p>
		{/if}
	</div>
	{#if action}
		<div class="mt-1">{@render action()}</div>
	{/if}
</div>
