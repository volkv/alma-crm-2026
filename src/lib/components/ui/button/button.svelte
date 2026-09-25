<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

	/**
	 * Область нажатия на телефоне. Основной контрол — 36px (`h-control`), ниже
	 * 44px, которых ждёт палец. Растить саму кнопку нельзя: она стоит в строках
	 * таблиц и фильтров рядом с полями той же высоты. Поэтому растёт невидимый
	 * `::after` — ровно до 44px по каждой оси и только там, где кнопка меньше:
	 * `min(0px, 50% - 22px)` у широкой кнопки даёт ноль, у квадратной в 36px —
	 * по 4px с каждой стороны. Раскладка не двигается, соседи при зазоре от 8px
	 * не перекрываются. Плотные размеры (`sm`, `xs`) область не растят: они для
	 * строк таблицы, где соседние цели стоят вплотную.
	 */
	const TOUCH_TARGET =
		'max-sm:after:absolute max-sm:after:inset-x-[min(0px,calc(50%-1.375rem))] max-sm:after:inset-y-[min(0px,calc(50%-1.375rem))]';

	export const buttonVariants = tv({
		base: "relative focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive rounded-lg border border-transparent bg-clip-padding text-sm font-medium active:not-aria-[haspopup]:translate-y-px [&_svg:not([class*='size-'])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors outline-none select-none cursor-pointer disabled:pointer-events-none disabled:text-faint aria-disabled:cursor-not-allowed aria-disabled:text-faint [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				/*
				 * Главное действие: белая подпись на оранжевом держит контраст
				 * полужирным начертанием (WCAG 2 — 3.93:1 при пороге 3:1 для
				 * полужирного, APCA — Lc 71), поэтому вес выше, чем у остальных.
				 */
				default:
					'bg-primary font-semibold text-primary-foreground hover:bg-primary-hover active:bg-primary-active disabled:bg-surface-muted aria-disabled:bg-surface-muted',
				outline:
					'border-input bg-surface hover:bg-surface-muted hover:text-foreground active:bg-surface-pressed aria-expanded:bg-surface-muted aria-expanded:text-foreground disabled:border-border disabled:bg-surface-muted',
				secondary:
					'bg-secondary text-secondary-foreground hover:bg-surface-pressed active:bg-surface-pressed aria-expanded:bg-surface-pressed aria-expanded:text-secondary-foreground',
				ghost:
					'hover:bg-surface-muted hover:text-foreground active:bg-surface-pressed aria-expanded:bg-surface-muted aria-expanded:text-foreground',
				destructive:
					'bg-destructive/10 hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 text-destructive disabled:bg-surface-muted',
				/*
				 * Нажатое состояние переключателя или фильтра: «Таблица» из
				 * «Таблица/Доска», включённый фильтр «Мои». Оранжевый здесь запрещён —
				 * он только у главного действия; выбранное — светлая фиолетовая
				 * подложка. Состояние потребитель объявляет сам: `aria-pressed` у
				 * кнопки-фильтра, `aria-current` у ссылки на вид. Группу взаимоисключающих
				 * вариантов собирают `SegmentedControl`.
				 */
				selected:
					'border-selection-border bg-selection text-selection-foreground hover:bg-selection active:bg-selection disabled:border-border disabled:bg-surface-muted disabled:text-faint',
				link: 'text-link underline-offset-4 hover:text-link-hover hover:underline'
			},
			size: {
				default: [
					'h-control gap-1.5 px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
					TOUCH_TARGET
				],
				xs: "h-7 gap-1 rounded-md px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
				sm: 'h-8 gap-1 px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
				lg: [
					'h-10 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
					TOUCH_TARGET
				],
				icon: ['size-control', TOUCH_TARGET],
				'icon-xs':
					"size-7 rounded-md in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3.5",
				'icon-sm': 'size-8 in-data-[slot=button-group]:rounded-md',
				'icon-lg': ['size-10', TOUCH_TARGET]
			}
		},
		defaultVariants: {
			variant: 'default',
			size: 'default'
		}
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = 'default',
		size = 'default',
		ref = $bindable(null),
		href = undefined,
		type = 'button',
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? 'link' : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
