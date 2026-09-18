<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from 'svelte/elements';

	/**
	 * Поле ввода.
	 *
	 * Вида `file` у него нет: надписи на нативном выборе файла рисует браузер и
	 * по-английски, поэтому файл в продукте выбирают `FileInput`
	 * (`docs/design.md`, «Файл выбирают нашей кнопкой»).
	 */
	type InputType = Exclude<HTMLInputTypeAttribute, 'file'>;

	type Props = WithElementRef<Omit<HTMLInputAttributes, 'type'> & { type?: InputType }>;

	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		class: className,
		'data-slot': dataSlot = 'input',
		...restProps
	}: Props = $props();
</script>

<input
	bind:this={ref}
	data-slot={dataSlot}
	class={cn(
		'h-control w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
		className
	)}
	{type}
	bind:value
	{...restProps}
/>
