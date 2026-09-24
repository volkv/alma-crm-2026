<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="card-action"
	class={cn(
		'flex flex-wrap items-center gap-2 self-start max-sm:mt-1 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:justify-self-end',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
