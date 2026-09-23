<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import type { InteractionFilterOption } from '$lib/contracts/interactions';

	/**
	 * Многозначный фильтр списка и доски: вуз, направление, программа, продукт.
	 * Тот же приём, что у отчёта (`components/reports/multi-filter.svelte`) —
	 * несколько пунктов работают как «или», меню не закрывается после выбора, —
	 * но сама ссылка не входит в компонент: адрес списка живёт в route-модуле
	 * `w/[workspace]/interactions/filters.ts`, а не в `$lib`, и собирает её
	 * вызывающий (`+page.svelte`) через `ontoggle`.
	 *
	 * Показывает только те варианты, что реально встречаются в пространстве и в
	 * области доступа того, кто список открыл (`interactions/read.ts`,
	 * `readInteractionFilterOptions`), — не весь справочник отчёта.
	 */
	let {
		label,
		options,
		selected,
		testId,
		ontoggle
	}: {
		label: string;
		options: readonly InteractionFilterOption[];
		selected: readonly string[];
		testId?: string;
		ontoggle: (value: string) => void;
	} = $props();

	const caption = $derived(selected.length === 0 ? label : `${label}: ${selected.length}`);
</script>

{#if options.length > 0}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="outline"
					size="sm"
					data-testid={testId}
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
						onCheckedChange={() => ontoggle(option.value)}
						closeOnSelect={false}
					>
						{option.label}
					</DropdownMenu.CheckboxItem>
				{/each}
			</DropdownMenu.Group>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
