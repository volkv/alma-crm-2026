<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
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
	 * Обычная форма методом GET, без перехвата: фильтр обязан оказаться в адресе
	 * — выборку из журнала кладут в задачу и отправляют коллеге. Списки нативные,
	 * потому что форма уходит без JavaScript тоже.
	 */
	let { filter }: { filter: ExchangeQuery } = $props();

	const SELECT_CLASS =
		'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs';
</script>

<form method="GET" class="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-5">
	<div class="flex flex-col gap-1.5">
		<Label for="direction">Направление</Label>
		<select id="direction" name="direction" class={SELECT_CLASS} value={filter.direction ?? ''}>
			<option value="">Любое</option>
			{#each EXCHANGE_DIRECTIONS as direction (direction)}
				<option value={direction}>{EXCHANGE_DIRECTION_LABELS[direction]}</option>
			{/each}
		</select>
	</div>

	<div class="flex flex-col gap-1.5">
		<Label for="system">Система</Label>
		<select id="system" name="system" class={SELECT_CLASS} value={filter.system ?? ''}>
			<option value="">Любая</option>
			{#each EXCHANGE_SYSTEMS as system (system)}
				<option value={system}>{system}</option>
			{/each}
		</select>
	</div>

	<div class="flex flex-col gap-1.5">
		<Label for="state">Состояние</Label>
		<select id="state" name="state" class={SELECT_CLASS} value={filter.state ?? ''}>
			<option value="">Любое</option>
			{#each EXCHANGE_MESSAGE_STATES as state (state)}
				<option value={state}>{EXCHANGE_STATE_LABELS[state]}</option>
			{/each}
		</select>
	</div>

	<div class="flex flex-col gap-1.5">
		<Label for="q">Ключ объекта или события</Label>
		<Input id="q" name="q" value={filter.q ?? ''} placeholder="site-2026-000123" />
	</div>

	<div class="flex gap-2">
		<Button type="submit">Показать</Button>
		<!-- Сброс — ссылка на тот же раздел без параметров: адрес без параметра и
			есть «без фильтра», и двух способов сказать это в ссылке быть не должно. -->
		<Button variant="outline" href={resolve('/exchange')}>Сбросить</Button>
	</div>
</form>
