<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	/*
	 * Горизонтальный ряд вкладок не шире родителя: на телефоне лишние вкладки
	 * прокручиваются внутри ряда, а не растаскивают страницу вбок. Отсюда
	 * `justify-start` — при центровке переполненный ряд обрезал бы начало, до
	 * которого не докрутить. Полосу прокрутки не рисуем: в ряду высотой 36px
	 * она съела бы половину вкладки, а обрезанная крайняя вкладка сама
	 * говорит, что ряд продолжается.
	 */
	export const tabsListVariants = tv({
		base: 'rounded-lg p-[3px] group-data-horizontal/tabs:h-9 group-data-horizontal/tabs:max-w-full group-data-horizontal/tabs:overflow-x-auto group-data-horizontal/tabs:[scrollbar-width:none] data-[variant=line]:rounded-none group/tabs-list inline-flex w-fit items-center justify-start text-muted-foreground group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col',
		variants: {
			variant: {
				default: 'bg-muted',
				line: 'gap-1 bg-transparent'
			}
		},
		defaultVariants: {
			variant: 'default'
		}
	});

	export type TabsListVariant = VariantProps<typeof tabsListVariants>['variant'];
</script>

<script lang="ts">
	import { Tabs as TabsPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		variant = 'default',
		class: className,
		...restProps
	}: TabsPrimitive.ListProps & {
		variant?: TabsListVariant;
	} = $props();
</script>

<TabsPrimitive.List
	bind:ref
	data-slot="tabs-list"
	data-variant={variant}
	class={cn(tabsListVariants({ variant }), className)}
	{...restProps}
/>
