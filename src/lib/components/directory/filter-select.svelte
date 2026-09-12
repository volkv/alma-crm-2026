<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { FieldOption } from '$lib/components/form/field-select.svelte';
	import { filterHref } from './query';

	/**
	 * Фильтр списка, который живёт в адресе.
	 *
	 * Список — это ссылка: отфильтрованный вид должен переживать «назад» и
	 * отправку коллеге, поэтому выбор не хранится в памяти компонента, а
	 * переписывает строку запроса — там же, где живут страница, сортировка и
	 * поиск `DataTable`.
	 */
	let {
		param,
		label,
		options,
		allLabel = 'Все'
	}: {
		/** Имя параметра в адресе. */
		param: string;
		label: string;
		options: readonly FieldOption[];
		allLabel?: string;
	} = $props();

	const value = $derived(page.url.searchParams.get(param) ?? '');

	function select(event: Event & { currentTarget: HTMLSelectElement }) {
		return goto(filterHref(page.url, param, event.currentTarget.value), {
			keepFocus: true,
			noScroll: true
		});
	}
</script>

<label class="flex items-center gap-2 text-sm text-muted-foreground">
	<span class="whitespace-nowrap">{label}</span>
	<select
		class="h-control rounded-md border border-input bg-background px-2 text-sm focus-ring"
		{value}
		onchange={select}
	>
		<option value="">{allLabel}</option>
		{#each options as option (option.value)}
			<option value={option.value}>{option.label}</option>
		{/each}
	</select>
</label>
