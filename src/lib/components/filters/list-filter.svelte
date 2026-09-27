<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import type { FilterOption } from './filter-strip.svelte';
	import FilterCount from './filter-count.svelte';

	/**
	 * Фильтр списка в виде дропдауна: у взаимодействий — статус, стадия, вуз,
	 * направление, программа, продукт; у организаций — тип и уровень. Тот же приём, что у отчёта
	 * (`components/reports/multi-filter.svelte`) — несколько пунктов работают
	 * как «или», меню не закрывается после выбора, — но сама ссылка не входит в
	 * компонент: адрес списка у каждого экрана свой, и собирает её
	 * вызывающий (`+page.svelte`) через `ontoggle`.
	 *
	 * Подпись стоит внутри кнопки, а не рядом с ней, как в трекерах задач:
	 * иначе строка фильтров не помещается в одну линию. Сколько значений
	 * выбрано — круглый счётчик справа от подписи, какие именно — подсказка.
	 * Кнопка с выбранными значениями — в цвете выбранного, как включённый
	 * переключатель «Просроченные» рядом.
	 *
	 * `single` — фильтр с одним значением (статус, стадия): меню закрывается
	 * после выбора, а что поставить вместо прежнего, решает вызывающий.
	 */
	let {
		label,
		options,
		selected,
		single = false,
		testId,
		ontoggle
	}: {
		label: string;
		options: readonly FilterOption[];
		selected: readonly string[];
		single?: boolean;
		testId?: string;
		ontoggle: (value: string) => void;
	} = $props();

	const hint = $derived(
		options
			.filter((option) => selected.includes(option.value))
			.map((option) => option.label)
			.join(', ')
	);
</script>

{#if options.length > 0}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant={selected.length > 0 ? 'selected' : 'outline'}
					data-testid={testId}
					data-active={selected.length > 0 ? 'true' : undefined}
					title={hint === '' ? undefined : `${label}: ${hint}`}
				>
					{label}
					<FilterCount count={selected.length} />
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
						onCheckedChange={() => ontoggle(option.value)}
						closeOnSelect={single}
					>
						{option.label}
					</DropdownMenu.CheckboxItem>
				{/each}
			</DropdownMenu.Group>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
