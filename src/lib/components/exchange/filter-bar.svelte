<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import FilterSelect from '$lib/components/directory/filter-select.svelte';
	import {
		EXCHANGE_DIRECTIONS,
		EXCHANGE_DIRECTION_LABELS,
		EXCHANGE_MESSAGE_STATES,
		EXCHANGE_STATE_LABELS,
		EXCHANGE_SYSTEMS,
		type ExchangeQuery
	} from '$lib/contracts/exchange';

	/**
	 * Фильтры журнала обмена.
	 *
	 * Списки — те же `FilterSelect`, что над журналом доставок и списками
	 * справочника: выбор сразу переписывает адрес, а выборку из журнала кладут в
	 * задачу и отправляют коллеге, поэтому фильтр обязан жить в строке запроса.
	 * Нативных `<select>` здесь нет по общему правилу продукта — «один контрол на
	 * задачу», `docs/development.md`.
	 *
	 * Поиск по ключу остался обычной GET-формой с кнопкой: набранное отправляют,
	 * когда дописали, а не на каждую букву. Выбранные списками значения она несёт
	 * скрытыми полями — форма уходит со всей строкой запроса сразу, и без них
	 * отправка стёрла бы фильтры из адреса.
	 */
	let { filter }: { filter: ExchangeQuery } = $props();

	const DIRECTION_OPTIONS = EXCHANGE_DIRECTIONS.map((direction) => ({
		value: direction,
		label: EXCHANGE_DIRECTION_LABELS[direction]
	}));

	const SYSTEM_OPTIONS = EXCHANGE_SYSTEMS.map((system) => ({ value: system, label: system }));

	const STATE_OPTIONS = EXCHANGE_MESSAGE_STATES.map((state) => ({
		value: state,
		label: EXCHANGE_STATE_LABELS[state]
	}));
</script>

<div class="flex flex-wrap items-end gap-3">
	<FilterSelect
		param="direction"
		label="Направление"
		options={DIRECTION_OPTIONS}
		allLabel="Любое"
	/>
	<FilterSelect param="system" label="Система" options={SYSTEM_OPTIONS} allLabel="Любая" />
	<FilterSelect param="state" label="Состояние" options={STATE_OPTIONS} allLabel="Любое" />

	<form method="GET" class="flex flex-wrap items-end gap-2">
		<input type="hidden" name="direction" value={filter.direction ?? ''} />
		<input type="hidden" name="system" value={filter.system ?? ''} />
		<input type="hidden" name="state" value={filter.state ?? ''} />

		<div class="flex flex-col gap-1.5">
			<Label for="q">Ключ объекта или события</Label>
			<Input id="q" name="q" value={filter.q ?? ''} placeholder="site-2026-000123" />
		</div>

		<Button type="submit">Показать</Button>
		<!-- Сброс — ссылка на тот же раздел без параметров: адрес без параметра и
			есть «без фильтра», и двух способов сказать это в ссылке быть не должно. -->
		<Button variant="outline" href={resolve('/exchange')}>Сбросить</Button>
	</form>
</div>
