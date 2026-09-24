<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const statusBadgeVariants = tv({
		base: 'inline-flex h-5 w-fit shrink-0 items-center gap-1.5 rounded-4xl px-2 text-xs font-medium whitespace-nowrap',
		variants: {
			tone: {
				neutral: 'bg-surface-muted text-muted-foreground',
				accent: 'bg-selection text-selection-foreground',
				success: 'bg-success-soft text-success-soft-foreground',
				warning: 'bg-warning-soft text-warning-soft-foreground',
				danger: 'bg-danger-soft text-danger-soft-foreground',
				info: 'bg-info-soft text-info-soft-foreground'
			},
			/*
			 * Длинный статус («Партнёр, лицензии истекают») в узкой колонке: плашка
			 * переносит текст и растёт в высоту, а не вылезает за карточку. Радиус
			 * у двух строк — обычный: пилюля высотой в 36px читается как кнопка.
			 */
			wrap: {
				true: 'h-auto min-h-5 shrink rounded-lg py-0.5 leading-4 whitespace-normal',
				false: ''
			}
		},
		defaultVariants: { tone: 'neutral', wrap: false }
	});

	/** The meaning a status carries, not the colour it happens to get. */
	export type StatusTone = NonNullable<VariantProps<typeof statusBadgeVariants>['tone']>;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	/**
	 * A status as a word, coloured by what the status means. Use it wherever a
	 * record has a state the user reads at a glance — a stage, a document, an
	 * approval — and pick the tone from the meaning (`danger` for something that
	 * needs attention now), never from the colour you want.
	 *
	 * For a deadline use `SlaChip`: it derives the tone from the date itself.
	 */
	let {
		tone = 'neutral',
		dot = false,
		wrap = false,
		title,
		class: className,
		children
	}: {
		tone?: StatusTone;
		/** Adds a leading dot — useful when several badges sit in one column. */
		dot?: boolean;
		/** Переносить длинный текст на следующую строку вместо того, чтобы вылезать за край. */
		wrap?: boolean;
		/** Native tooltip, for the detail that does not fit in the badge. */
		title?: string;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<span
	class={cn(statusBadgeVariants({ tone, wrap }), className)}
	data-slot="status-badge"
	data-tone={tone}
	{title}
>
	{#if dot}
		<span class="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true"></span>
	{/if}
	{@render children()}
</span>
