<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import type { FilterOption, ReportParam } from '$lib/contracts/reports';
	import { selectedValues, toggledHref } from './query';

	/**
	 * Многозначный фильтр отчёта. Значения живут в адресе через запятую и
	 * работают как «или» внутри параметра: взаимодействие с двумя продуктами
	 * попадает и в отчёт по первому, и в отчёт по второму.
	 *
	 * Пункты не закрывают меню: выбирают обычно несколько подряд, и закрытие
	 * после каждого превращает выбор трёх вузов в три открытия списка.
	 */
	let {
		param,
		label,
		options
	}: {
		param: ReportParam;
		label: string;
		options: readonly FilterOption[];
	} = $props();

	const selected = $derived(selectedValues(page.url, param));

	const caption = $derived(selected.length === 0 ? label : `${label}: ${selected.length}`);

	function toggle(value: string) {
		return goto(toggledHref(page.url, param, value), { keepFocus: true, noScroll: true });
	}
</script>

{#if options.length > 0}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="outline"
					size="sm"
					data-testid="report-filter-{param}"
					data-active={selected.length > 0 ? 'true' : undefined}
				>
					{caption}
					<ChevronDownIcon aria-hidden="true" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" class="max-h-96 w-72 overflow-y-auto">
			<DropdownMenu.Group>
				<DropdownMenu.GroupHeading>{label}</DropdownMenu.GroupHeading>
				{#each options as option (option.value)}
					<DropdownMenu.CheckboxItem
						checked={selected.includes(option.value)}
						onCheckedChange={() => void toggle(option.value)}
						closeOnSelect={false}
					>
						{option.label}
					</DropdownMenu.CheckboxItem>
				{/each}
			</DropdownMenu.Group>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
