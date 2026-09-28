<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	/**
	 * Поля формы одно под другим на общем расстоянии `gap-form`. `gap="section"`
	 * раздвигает шире — между группами полей. Расстояния задают токены
	 * `--spacing-form*` в `app.css`; числовых `gap-*` в формах не пишем.
	 */
	let {
		gap = 'form',
		class: className,
		children
	}: {
		gap?: 'form' | 'section';
		class?: string;
		children: Snippet;
	} = $props();
</script>

<div
	class={cn(
		'flex min-w-0 flex-col',
		gap === 'section' ? 'gap-form-section' : 'gap-form',
		className
	)}
	data-slot="form-stack"
>
	{@render children()}
</div>
