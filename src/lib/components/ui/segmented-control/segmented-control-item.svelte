<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ToggleGroup as ToggleGroupPrimitive } from 'bits-ui';
	import { cn, type WithoutChildrenOrChild } from '$lib/utils.js';
	import { buttonVariants } from '../button/index.js';
	import { getSegmentSize } from './context';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithoutChildrenOrChild<ToggleGroupPrimitive.ItemProps> & { children: Snippet } = $props();

	const size = getSegmentSize();
</script>

<ToggleGroupPrimitive.Item bind:ref {...restProps}>
	{#snippet child({ props, pressed })}
		<button
			{...props}
			type="button"
			data-slot="segmented-control-item"
			class={cn(
				buttonVariants({ variant: pressed ? 'selected' : 'outline', size: size() }),
				className
			)}
		>
			{@render children()}
		</button>
	{/snippet}
</ToggleGroupPrimitive.Item>
