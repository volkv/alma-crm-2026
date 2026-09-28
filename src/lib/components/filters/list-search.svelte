<script lang="ts">
	import SearchIcon from '@lucide/svelte/icons/search';
	import { Input } from '$lib/components/ui/input/index.js';

	/**
	 * Строка поиска списка — первая в ряду отборов (`filter-bar.svelte`):
	 * сужает набор по параметру адреса `q`, тому же, что читает `DataTable`, так
	 * что у взаимодействий при смене вида запрос сохраняется. Своя строка поиска
	 * таблицы на таких экранах выключена — двух полей для одного запроса не
	 * нужно. Горячая клавиша `/` — та же, что у строки поиска таблицы.
	 *
	 * На телефоне поле делит первую строку ряда с тем, что стоит рядом
	 * (аватарки ответственных у взаимодействий), и забирает всю оставшуюся
	 * ширину; с `sm` ширина постоянная — поуже до `xl`, чтобы на ноутбуке в ряду
	 * оставалось место фильтрам.
	 *
	 * Адрес собирает вызывающий через `onsearch` — так же, как у остальных
	 * отборов. Ввод отправляется с паузой, чтобы не перегружать доску на каждую
	 * букву.
	 */
	let {
		value,
		placeholder,
		testId,
		onsearch
	}: {
		value: string;
		placeholder: string;
		testId?: string;
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

<div class="relative min-w-0 flex-1 sm:w-48 sm:flex-none xl:w-64" data-tour="filters-search">
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
		class="pl-8 max-sm:min-h-11"
		data-testid={testId}
		oninput={onInput}
	/>
</div>
