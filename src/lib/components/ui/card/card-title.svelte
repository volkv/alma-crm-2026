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
	data-slot="card-title"
	class={cn(
		'section-title group-data-[size=sm]/card:text-sm group-data-[size=sm]/card:leading-5',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
