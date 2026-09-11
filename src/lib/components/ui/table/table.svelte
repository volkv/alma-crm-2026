<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLTableAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		containerClass,
		children,
		...restProps
	}: WithElementRef<HTMLTableAttributes> & {
		/**
		 * Classes for the scroll container around the table. A sticky header
		 * sticks to the nearest scroll container, so anything that bounds the
		 * table's height has to go here rather than on a wrapper of its own.
		 */
		containerClass?: string;
	} = $props();
</script>

<div data-slot="table-container" class={cn('relative w-full overflow-auto', containerClass)}>
	<table
		bind:this={ref}
		data-slot="table"
		class={cn('w-full caption-bottom text-sm', className)}
		{...restProps}
	>
		{@render children?.()}
	</table>
</div>
