<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils.js';
	import { setSegmentSize, type SegmentedControlSize } from './context';

	/**
	 * Та же группа, но варианты — ссылки: выбранный вид живёт в адресе
	 * («Таблица / Доска»), и переход между ними — навигация, а не смена
	 * состояния на месте. Поэтому ни радиогруппы, ни стрелок: ссылки проходят
	 * Tab'ом, открытая помечена `aria-current="page"`.
	 */
	let {
		size = 'default',
		class: className,
		children,
		...restProps
	}: Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
		size?: SegmentedControlSize;
		'aria-label': string;
		children: Snippet;
	} = $props();

	setSegmentSize(() => size);
</script>

<div
	role="group"
	data-slot="segmented-control"
	class={cn('inline-flex flex-wrap items-center gap-1', className)}
	{...restProps}
>
	{@render children()}
</div>
