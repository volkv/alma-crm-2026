<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
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

	/**
	 * Значение пункта «фильтра нет». Пустая строка тут не годится: для списка
	 * она означает «ничего не выбрано», и пункт стал бы неотличим от пустоты, —
	 * а в адрес всё равно уходит пустая строка, то есть параметр удаляется.
	 */
	const ANY = '__any';

	const id = $derived(`filter-${param}`);
	const value = $derived(page.url.searchParams.get(param) ?? ANY);
	const selected = $derived(options.find((option) => option.value === value)?.label ?? allLabel);

	function select(next: string) {
		return goto(filterHref(page.url, param, next === ANY ? '' : next), {
			keepFocus: true,
			noScroll: true
		});
	}
</script>

<div class="flex items-center gap-2">
	<Label for={id} class="font-normal whitespace-nowrap text-muted-foreground">{label}</Label>
	<Select.Root type="single" {value} onValueChange={select}>
		<Select.Trigger {id}>{selected}</Select.Trigger>
		<Select.Content>
			<Select.Item value={ANY} label={allLabel} />
			{#each options as option (option.value)}
				<Select.Item value={option.value} label={option.label} />
			{/each}
		</Select.Content>
	</Select.Root>
</div>
