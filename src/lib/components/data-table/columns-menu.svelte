<script lang="ts" generics="TData extends RowData">
	import type { RowData, SvelteTable } from '@tanstack/svelte-table';
	import Columns3Icon from '@lucide/svelte/icons/columns-3';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { cn } from '$lib/utils';
	import type { DataTableFeatures } from './features';

	/**
	 * Меню «Колонки» списка. Обычно стоит в панели самого `DataTable`; экран,
	 * у которого над списком своя строка контролов, выключает встроенное
	 * (`columnsMenu={false}`) и ставит это меню к себе, передав таблицу из
	 * `ontable`. Состояние видимости одно — у таблицы, меню его только
	 * переключает.
	 *
	 * Пока таблица не передана (сервер, первые мгновения до гидратации:
	 * `ontable` зовётся, когда список уже нарисован), кнопка стоит на месте
	 * в том же виде, а меню пустое — строка не прыгает, когда таблица приходит.
	 *
	 * `labelClass` прячет подпись на части ширин (`max-2xl:sr-only`): остаётся
	 * значок, а подпись — читалке и подсказке `title`.
	 */
	let {
		table,
		labelClass,
		title,
		class: className
	}: {
		table: SvelteTable<DataTableFeatures, TData> | null;
		labelClass?: string;
		title?: string;
		class?: string;
	} = $props();

	const hideable = $derived(
		table === null ? [] : table.getAllLeafColumns().filter((column) => column.getCanHide())
	);

	function columnTitle(column: { id: string; columnDef: { header?: unknown; meta?: unknown } }) {
		const meta = column.columnDef.meta as { title?: string } | undefined;
		if (meta?.title) return meta.title;

		return typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id;
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" class={cn('max-sm:min-h-11', className)} {title}>
				<Columns3Icon aria-hidden="true" />
				<span class={labelClass}>Колонки</span>
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-52">
		<!-- Заголовок обязан стоять внутри группы: без неё bits-ui не находит
			контекст и всё содержимое меню не отрисовывается вовсе. -->
		<DropdownMenu.Group>
			<DropdownMenu.GroupHeading>Показывать колонки</DropdownMenu.GroupHeading>
			<DropdownMenu.Separator />
			{#each hideable as column (column.id)}
				<DropdownMenu.CheckboxItem
					checked={column.getIsVisible()}
					onCheckedChange={(checked) => column.toggleVisibility(checked)}
					closeOnSelect={false}
				>
					{columnTitle(column)}
				</DropdownMenu.CheckboxItem>
			{/each}
		</DropdownMenu.Group>
	</DropdownMenu.Content>
</DropdownMenu.Root>
