<script lang="ts">
	import SearchIcon from '@lucide/svelte/icons/search';
	import { Input } from '$lib/components/ui/input/index.js';

	/**
	 * Строка поиска доски взаимодействий. У таблицы строка поиска своя, в её
	 * панели (`DataTable`), а у доски такой панели нет — поиск стоит среди
	 * отборов и сужает тот же набор по тому же параметру адреса `q`. Горячая
	 * клавиша `/` — та же, что у строки поиска таблицы.
	 *
	 * Адрес собирает вызывающий через `onsearch` — так же, как у остальных
	 * отборов. Ввод отправляется с паузой, чтобы не перегружать доску на каждую
	 * букву.
	 */
	let {
		value,
		placeholder,
		onsearch
	}: {
		value: string;
		placeholder: string;
		onsearch: (value: string) => void;
	} = $props();

	let input = $state<HTMLElement | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;

	// Отложенный поиск не должен уводить со страницы, которой уже нет.
	$effect(() => () => clearTimeout(timer));

	function onInput(event: Event & { currentTarget: HTMLInputElement }) {
		const next = event.currentTarget.value.trim();

		clearTimeout(timer);
		timer = setTimeout(() => onsearch(next), 250);
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key !== '/' || input === null) return;

		const target = event.target;
		const typing =
			target instanceof HTMLElement &&
			(target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
		if (typing) return;

		event.preventDefault();
		input.focus();
		if (input instanceof HTMLInputElement) input.select();
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="relative w-full sm:w-64">
	<SearchIcon
		class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
		aria-hidden="true"
	/>
	<Input
		bind:ref={input}
		type="search"
		{value}
		{placeholder}
		aria-label={placeholder}
		class="pl-8"
		data-testid="interactions-search"
		oninput={onInput}
	/>
</div>
