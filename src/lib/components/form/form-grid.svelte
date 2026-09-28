<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	/**
	 * Поля формы в ряд: на телефоне столбиком, с `sm` — по две или три колонки.
	 * Расстояние между полями то же `gap-form`, что и в `FormStack`, — в обе
	 * стороны, иначе ряды слипаются по вертикали.
	 */
	let {
		cols = 2,
		class: className,
		children
	}: {
		cols?: 2 | 3;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<div
	class={cn('grid min-w-0 gap-form', cols === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2', className)}
	data-slot="form-grid"
>
	{@render children()}
</div>
