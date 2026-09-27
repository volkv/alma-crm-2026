<script lang="ts">
	import { page } from '$app/state';
	import { clearedFiltersHref } from '$lib/components/directory/query';
	import FilterBar, { singleParamFilter } from '$lib/components/filters/filter-bar.svelte';
	import {
		NOTIFICATION_CHANNELS,
		NOTIFICATION_CHANNEL_LABELS,
		NOTIFICATION_DELIVERY_STATUSES,
		NOTIFICATION_STATUS_LABELS
	} from '$lib/contracts/notifications';

	/**
	 * Фильтры журнала доставок — тот же ряд отборов, что над остальными
	 * списками продукта (`filters/filter-bar.svelte`): выбор переписывает строку
	 * запроса, и отфильтрованный вид переживает «назад» и отправку коллеге.
	 * Поиска у журнала нет.
	 */
	const STATUS_OPTIONS = NOTIFICATION_DELIVERY_STATUSES.map((status) => ({
		value: status,
		label: NOTIFICATION_STATUS_LABELS[status]
	}));

	const CHANNEL_OPTIONS = NOTIFICATION_CHANNELS.map((channel) => ({
		value: channel,
		label: NOTIFICATION_CHANNEL_LABELS[channel]
	}));

	const FILTER_PARAMS = ['status', 'channel'] as const;

	const filters = $derived([
		singleParamFilter(page.url, {
			param: 'status',
			label: 'Состояние',
			options: STATUS_OPTIONS,
			testId: 'notifications-filter-status'
		}),
		singleParamFilter(page.url, {
			param: 'channel',
			label: 'Канал',
			options: CHANNEL_OPTIONS,
			testId: 'notifications-filter-channel'
		})
	]);

	const filtered = $derived(FILTER_PARAMS.some((param) => page.url.searchParams.has(param)));
</script>

<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
<FilterBar
	data-tour="notifications-filters"
	testId="notifications"
	{filters}
	clearHref={filtered ? clearedFiltersHref(page.url, FILTER_PARAMS) : null}
/>
