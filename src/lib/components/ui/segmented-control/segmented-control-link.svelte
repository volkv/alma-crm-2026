<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Button, type ButtonProps } from '../button/index.js';
	import { getSegmentSize } from './context';

	let {
		href,
		current,
		class: className,
		children,
		...restProps
	}: Omit<ButtonProps, 'children' | 'href' | 'variant' | 'size' | 'aria-current'> & {
		href: string;
		/** Открыт ли этот вариант сейчас. */
		current: boolean;
		children: Snippet;
	} = $props();

	const size = getSegmentSize();
</script>

<Button
	{href}
	variant={current ? 'selected' : 'outline'}
	size={size()}
	aria-current={current ? 'page' : undefined}
	data-slot="segmented-control-link"
	class={className}
	{...restProps}
>
	{@render children()}
</Button>
