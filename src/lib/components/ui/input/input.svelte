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
		'h-control w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-muted disabled:text-faint aria-invalid:border-destructive md:text-sm',
		className
	)}
	{type}
	bind:value
	{...restProps}
/>
