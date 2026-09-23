<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { filterHref } from '$lib/components/directory/query';
	import { statPeriodKey, STAT_PERIOD_KIND_LABELS, type StatPeriod } from '$lib/contracts/stats';
	import { formatDate } from '$lib/format';

	/**
	 * Выбор отчётного периода там, где «все периоды» — недопустимый ответ.
	 *
	 * Пересекающиеся периоды не складываются: одни и те же обучающиеся
	 * посчитались бы дважды. Поэтому у списка нет пункта «все» — в отличие от
	 * `FilterSelect`, которым выбирают фильтр списка, — а выбранный период
	 * живёт в адресе, как и всякое состояние экрана.
	 */
	let { periods }: { periods: readonly StatPeriod[] } = $props();

	const value = $derived(page.url.searchParams.get('period') ?? '');

	const options = $derived(
		periods.map((period) => ({
			value: statPeriodKey(period),
			label: `${STAT_PERIOD_KIND_LABELS[period.kind]}: ${formatDate(period.start)} — ${formatDate(period.end)}`
		}))
	);

	const selected = $derived(
		options.find((option) => option.value === value)?.label ?? 'Выберите период'
	);

	function select(next: string) {
		return goto(filterHref(page.url, 'period', next), { keepFocus: true, noScroll: true });
	}
</script>

<div class="flex max-w-full min-w-0 items-center gap-2">
	<Label for="stat-period" class="font-normal whitespace-nowrap text-muted-foreground">
		Период
	</Label>
	<Select.Root type="single" {value} onValueChange={select}>
		<!-- На узком экране название периода длиннее экрана: контрол сжимается,
		     а не растягивает страницу вбок. -->
		<Select.Trigger id="stat-period" class="min-w-0">
			<span class="truncate">{selected}</span>
		</Select.Trigger>
		<Select.Content>
			{#each options as option (option.value)}
				<Select.Item value={option.value} label={option.label} />
			{/each}
		</Select.Content>
	</Select.Root>
</div>
