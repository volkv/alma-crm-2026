<script lang="ts">
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { MediaQuery } from 'svelte/reactivity';
	import { copyText } from '$lib/clipboard';
	import { cn } from '$lib/utils.js';

	/**
	 * Значение, которое можно скопировать. С мышью справа от текста по
	 * наведению появляется кнопка «Копировать»; на сенсорном экране наведения
	 * нет, поэтому копирует касание самого текста. Пустое значение — прочерк
	 * без копирования.
	 */
	let {
		value,
		label,
		floating = false,
		class: className
	}: {
		value: string | null;
		/** Что копируется — для подписи кнопки и уведомления: «ИНН». */
		label: string;
		/** Кнопка всплывает поверх соседнего текста и не занимает места — для значения посреди строки. */
		floating?: boolean;
		class?: string;
	} = $props();

	const canHover = new MediaQuery('(hover: hover) and (pointer: fine)', true);

	function copy() {
		if (value !== null) void copyText(value, `Скопировано: ${label}`);
	}
</script>

{#if value === null}
	<span class={className}>—</span>
{:else if canHover.current}
	<span
		class={cn(
			'group/copy inline-flex max-w-full items-start gap-1',
			floating && 'relative',
			className
		)}
	>
		<span class="min-w-0 break-words">{value}</span>
		<button
			type="button"
			class={cn(
				'-my-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/copy:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring',
				floating &&
					'absolute top-1/2 left-full my-0 ml-0.5 -translate-y-1/2 bg-popover shadow-sm ring-1 ring-foreground/10'
			)}
			aria-label="Копировать: {label}"
			title="Копировать"
			onclick={copy}
		>
			<CopyIcon class="size-3.5" />
		</button>
	</span>
{:else}
	<button
		type="button"
		class={cn('max-w-full text-left break-words active:opacity-60', className)}
		aria-label="{label}: {value}. Нажмите, чтобы скопировать"
		onclick={copy}
	>
		{value}
	</button>
{/if}
