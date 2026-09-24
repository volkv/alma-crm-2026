<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		size = 'default',
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & { size?: 'default' | 'sm' } = $props();
</script>

<!-- Панель — одна поверхность на весь продукт: край `border`, фон `surface`,
	радиус 12px, без тени и без полупрозрачного кольца. Тень — признак того,
	что висит над страницей (меню, диалог, тост), и у панели на холсте её нет. -->
<div
	bind:this={ref}
	data-slot="card"
	data-size={size}
	class={cn(
		'group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl border border-border bg-surface py-(--card-spacing) text-sm text-foreground [--card-spacing:--spacing(6)] has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(4)] *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
