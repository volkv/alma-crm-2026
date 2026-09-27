<script lang="ts">
	import { page } from '$app/state';
	import { clearedFiltersHref } from '$lib/components/directory/query';
	import FilterBar, {
		searchParam,
		singleParamFilter
	} from '$lib/components/filters/filter-bar.svelte';
	import {
		EXCHANGE_DIRECTIONS,
		EXCHANGE_DIRECTION_LABELS,
		EXCHANGE_MESSAGE_STATES,
		EXCHANGE_STATE_LABELS,
		EXCHANGE_SYSTEMS
	} from '$lib/contracts/exchange';

	/**
	 * Фильтры журнала обмена — тот же ряд отборов, что над остальными списками
	 * (`filters/filter-bar.svelte`): выбор сразу переписывает адрес, а выборку из
	 * журнала кладут в задачу и отправляют коллеге, поэтому фильтр обязан жить в
	 * строке запроса. Поиск по ключу объекта или события — первым в ряду, как
	 * везде, и уходит в адрес с паузой после ввода.
	 */
	const DIRECTION_OPTIONS = EXCHANGE_DIRECTIONS.map((direction) => ({
		value: direction,
		label: EXCHANGE_DIRECTION_LABELS[direction]
	}));

	const SYSTEM_OPTIONS = EXCHANGE_SYSTEMS.map((system) => ({ value: system, label: system }));

	const STATE_OPTIONS = EXCHANGE_MESSAGE_STATES.map((state) => ({
		value: state,
		label: EXCHANGE_STATE_LABELS[state]
	}));

	const FILTER_PARAMS = ['direction', 'system', 'state'] as const;

	const filters = $derived([
		singleParamFilter(page.url, {
			param: 'direction',
			label: 'Направление',
			options: DIRECTION_OPTIONS,
			testId: 'exchange-filter-direction'
		}),
		singleParamFilter(page.url, {
			param: 'system',
			label: 'Система',
			options: SYSTEM_OPTIONS,
			testId: 'exchange-filter-system'
		}),
		singleParamFilter(page.url, {
			param: 'state',
			label: 'Состояние',
			options: STATE_OPTIONS,
			testId: 'exchange-filter-state'
		})
	]);

	const filtered = $derived(
		[...FILTER_PARAMS, 'q'].some((param) => page.url.searchParams.has(param))
	);
</script>

<!-- `data-tour` — метка подсказок по экрану «Внешние системы»
	(`$lib/onboarding/screens`). -->
<FilterBar
	data-tour="exchange-filters"
	testId="exchange"
	search={searchParam(page.url, 'Ключ объекта или события')}
	{filters}
	clearHref={filtered ? clearedFiltersHref(page.url, FILTER_PARAMS) : null}
/>
