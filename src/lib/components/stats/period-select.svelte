<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ListFilter from '$lib/components/filters/list-filter.svelte';
	import { filterHref } from '$lib/components/directory/query';
	import { statPeriodKey, STAT_PERIOD_KIND_LABELS, type StatPeriod } from '$lib/contracts/stats';
	import { formatDate } from '$lib/format';

	/**
	 * Выбор отчётного периода там, где «все периоды» — недопустимый ответ.
	 *
	 * Пересекающиеся периоды не складываются: одни и те же обучающиеся
	 * посчитались бы дважды. Поэтому у списка нет пункта «все» — в отличие от
	 * фильтров списков, — а выбранный период
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

	function select(next: string) {
		// Выбор обязателен: повторное нажатие на текущий период ничего не снимает.
		if (next === value) return;

		return goto(filterHref(page.url, 'period', next), { keepFocus: true, noScroll: true });
	}
</script>

<!-- Та же кнопка, что у фильтров списков (`filters/list-filter.svelte`), но с
	выбранным значением на ней: «все периоды» здесь — недопустимый ответ. -->
<ListFilter
	label="Период"
	{options}
	selected={options.some((option) => option.value === value) ? [value] : []}
	single
	showValue
	testId="stat-period"
	ontoggle={(next) => void select(next)}
/>
