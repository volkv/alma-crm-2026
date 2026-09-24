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

<!-- Действия (`Card.Action`) на телефоне — отдельной строкой под заголовком и
	пояснением: правая колонка `auto` там съедала ширину заголовка, и он
	ломался по слову в строке. С `sm` они снова справа. -->
<div
	bind:this={ref}
	data-slot="card-header"
	class={cn(
		'group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-description]:grid-rows-[auto_auto] sm:has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto] [.border-b]:pb-(--card-spacing)',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
