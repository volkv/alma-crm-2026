<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { ToggleGroup as ToggleGroupPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils.js';
	import { setSegmentSize, type SegmentedControlSize } from './context';

	/**
	 * Группа взаимоисключающих вариантов на месте: «Срез / Движение», фильтр
	 * ленты по виду события. Выбран всегда ровно один — повторное нажатие на
	 * выбранный вариант его не снимает.
	 *
	 * Семантика — `radiogroup` из радио-кнопок: в группу входят одним Tab, на
	 * выбранный вариант; стрелки (и Home/End) переводят и фокус, и выбор, как у
	 * обычной группы переключателей. Выбранный вариант — `variant="selected"`
	 * кнопки, остальные — контурные.
	 *
	 * Для вариантов-ссылок (вид списка в адресе: «Таблица / Доска») —
	 * `SegmentedControl.LinkGroup` и `SegmentedControl.Link`.
	 */
	let {
		ref = $bindable(null),
		value = $bindable(),
		onValueChange,
		size = 'default',
		disabled = false,
		class: className,
		children,
		...restProps
	}: Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
		ref?: HTMLElement | null;
		value: string;
		onValueChange?: (value: string) => void;
		size?: SegmentedControlSize;
		disabled?: boolean;
		/** Имя группы для скринридера — обязательно: у группы нет видимой подписи. */
		'aria-label': string;
		children: Snippet;
	} = $props();

	setSegmentSize(() => size);

	function select(next: string) {
		// bits-ui снимает выбор повторным нажатием и присылает пустую строку;
		// у группы «ровно один» такого состояния нет.
		if (next === '' || next === value) return;
		value = next;
		onValueChange?.(next);
	}

	const MOVE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

	/**
	 * bits-ui двигает стрелками только фокус. У радиогруппы стрелка выбирает:
	 * после его обработчика на варианте (событие всплывает сюда позже)
	 * выбираем тот, на котором оказался фокус.
	 */
	function onkeydown(event: KeyboardEvent) {
		if (!MOVE_KEYS.has(event.key)) return;
		const focused = document.activeElement;
		if (
			focused instanceof HTMLElement &&
			ref?.contains(focused) &&
			focused.dataset.value !== undefined &&
			!focused.hasAttribute('disabled')
		) {
			select(focused.dataset.value);
		}
	}
</script>

<ToggleGroupPrimitive.Root type="single" bind:ref bind:value={() => value, select} {disabled}>
	{#snippet child({ props })}
		<div
			{...props}
			{...restProps}
			role="radiogroup"
			data-slot="segmented-control"
			class={cn('inline-flex flex-wrap items-center gap-1', className)}
			{onkeydown}
		>
			{@render children()}
		</div>
	{/snippet}
</ToggleGroupPrimitive.Root>
