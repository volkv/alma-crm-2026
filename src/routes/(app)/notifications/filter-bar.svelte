<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import FilterSelect from '$lib/components/directory/filter-select.svelte';
	import {
		NOTIFICATION_CHANNELS,
		NOTIFICATION_CHANNEL_LABELS,
		NOTIFICATION_DELIVERY_STATUSES,
		NOTIFICATION_STATUS_LABELS
	} from '$lib/contracts/notifications';

	/**
	 * Фильтры журнала доставок.
	 *
	 * Списки — те же `FilterSelect`, что над остальными списками продукта: выбор
	 * переписывает строку запроса, и отфильтрованный вид переживает «назад» и
	 * отправку коллеге.
	 */
	const STATUS_OPTIONS = NOTIFICATION_DELIVERY_STATUSES.map((status) => ({
		value: status,
		label: NOTIFICATION_STATUS_LABELS[status]
	}));

	const CHANNEL_OPTIONS = NOTIFICATION_CHANNELS.map((channel) => ({
		value: channel,
		label: NOTIFICATION_CHANNEL_LABELS[channel]
	}));
</script>

<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
<div data-tour="notifications-filters" class="flex flex-wrap items-center gap-3">
	<FilterSelect param="status" label="Состояние" options={STATUS_OPTIONS} allLabel="Любое" />
	<FilterSelect param="channel" label="Канал" options={CHANNEL_OPTIONS} allLabel="Любой" />
	<!-- Сброс — ссылка на тот же раздел без параметров: адрес без параметра и
		есть «без фильтра», и двух способов сказать это в ссылке быть не должно. -->
	<Button variant="outline" href={resolve('/notifications')}>Сбросить</Button>
</div>
