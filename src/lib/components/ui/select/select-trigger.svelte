<script lang="ts">
	import { Select as SelectPrimitive } from 'bits-ui';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { cn, type WithoutChild } from '$lib/utils.js';
	import { getSelectPopup } from './select.svelte';

	let {
		ref = $bindable(null),
		class: className,
		children,
		size = 'default',
		...restProps
	}: WithoutChild<SelectPrimitive.TriggerProps> & {
		size?: 'sm' | 'default';
	} = $props();

	/**
	 * Триггер — кнопка, открывающая список, и роль у неё `combobox`: так эту
	 * пару описывает ARIA, так её называют вспомогательные технологии и так её
	 * ищут проверки (`getByRole('combobox')`). Сам bits-ui роли не ставит —
	 * оставляет `aria-haspopup="listbox"` на кнопке, — поэтому семантику
	 * дописываем здесь, один раз на весь продукт.
	 *
	 * `aria-controls` появляется только у открытого списка: разметки списка в
	 * закрытом состоянии в документе нет, и ссылка на несуществующий
	 * идентификатор была бы хуже её отсутствия.
	 */
	const popup = getSelectPopup();
</script>

<SelectPrimitive.Trigger
	bind:ref
	data-slot="select-trigger"
	data-size={size}
	role="combobox"
	aria-controls={popup.open ? popup.id : undefined}
	class={cn(
		"flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-muted disabled:text-faint aria-invalid:border-destructive data-placeholder:text-muted-foreground data-[size=default]:h-control data-[size=sm]:h-7 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<ChevronDownIcon class="pointer-events-none size-4 text-muted-foreground" />
</SelectPrimitive.Trigger>
