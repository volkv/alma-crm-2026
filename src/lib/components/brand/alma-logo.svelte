<script lang="ts">
	import AlmaMark, { type MarkVariant } from './alma-mark.svelte';

	/**
	 * Словесный логотип: знак и название словом. Слово набрано шрифтом
	 * интерфейса, а не нарисовано: так оно остаётся текстом, который находят
	 * поиском и читает экранный диктор, и само следует теме.
	 */
	let {
		/** Сторона знака в пикселях; кегль слова задаётся `wordClass`. */
		size = 32,
		wordClass = 'text-base',
		variant,
		class: className
	}: {
		size?: number;
		wordClass?: string;
		variant?: MarkVariant;
		class?: string;
	} = $props();
</script>

<span class="flex min-w-0 items-center gap-2.5 {className}">
	<AlmaMark {size} {variant} />
	<span class="truncate font-semibold tracking-tight {wordClass}">Альма CRM</span>
</span>
