<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	/**
	 * The field–value block of a record card. Fill it with `KeyValueRow`; the
	 * labels line up in one column so a card can be read down the left edge.
	 * Two columns from `sm` up, one on a phone.
	 */
	let {
		columns = 2,
		class: className,
		children
	}: {
		/** How many field–value pairs sit side by side on a wide screen. */
		columns?: 1 | 2;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<dl
	class={cn('grid grid-cols-1 gap-x-6 gap-y-3', columns === 2 && 'sm:grid-cols-2', className)}
	data-slot="key-value"
>
	{@render children()}
</dl>
