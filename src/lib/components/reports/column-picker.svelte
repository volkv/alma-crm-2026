<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Columns3Icon from '@lucide/svelte/icons/columns-3';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import type { ReportColumnDefinition, ReportColumnKey } from '$lib/contracts/reports';
	import { reportHref } from './query';

	/**
	 * Выбор колонок. Живёт в адресе, а не в настройках пользователя: два
	 * человека с одной ссылкой обязаны получить одну таблицу и один файл.
	 *
	 * Порядок колонок задаёт каталог и выбором не меняется. Две колонки выключить
	 * нельзя: без «Взаимодействия» строка не опознаётся и вести с неё некуда, без
	 * «Вуза» отчёт перестаёт быть отчётом по вузам.
	 */
	let {
		available,
		selected
	}: {
		available: readonly ReportColumnDefinition[];
		/** Колонки, показанные сейчас, — в порядке каталога. */
		selected: readonly ReportColumnKey[];
	} = $props();

	function toggle(key: ReportColumnKey, checked: boolean) {
		const next = available
			.filter((column) =>
				column.key === key ? checked || column.required : selected.includes(column.key)
			)
			.map((column) => column.key);

		// Набор пишется в адрес целиком: пустой параметр означает «по умолчанию»,
		// и снятая по умолчанию включённая колонка вернулась бы обратно.
		return goto(reportHref(page.url, { cols: next }), { keepFocus: true, noScroll: true });
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm" data-testid="report-columns">
				<Columns3Icon aria-hidden="true" />
				Колонки: {selected.length}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="max-h-96 w-72 overflow-y-auto">
		<DropdownMenu.Group>
			<DropdownMenu.GroupHeading>Колонки отчёта</DropdownMenu.GroupHeading>
			{#each available as column (column.key)}
				<DropdownMenu.CheckboxItem
					checked={selected.includes(column.key)}
					disabled={column.required}
					onCheckedChange={(checked) => void toggle(column.key, checked === true)}
					closeOnSelect={false}
					data-testid="report-column-{column.key}"
				>
					{column.label}
					<span class="ml-auto pl-2 text-xs text-faint">
						{column.sort === 'historical' ? 'на дату' : 'сейчас'}
					</span>
				</DropdownMenu.CheckboxItem>
			{/each}
		</DropdownMenu.Group>
	</DropdownMenu.Content>
</DropdownMenu.Root>
