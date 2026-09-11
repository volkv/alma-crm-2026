<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const inlineHintVariants = tv({
		base: 'flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs',
		variants: {
			tone: {
				neutral: 'border-border bg-surface-muted text-muted-foreground',
				info: 'border-info-soft bg-info-soft text-info-soft-foreground',
				warning: 'border-warning-soft bg-warning-soft text-warning-soft-foreground'
			}
		},
		defaultVariants: { tone: 'neutral' }
	});

	export type InlineHintTone = NonNullable<VariantProps<typeof inlineHintVariants>['tone']>;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LucideIcon } from '@lucide/svelte';
	import InfoIcon from '@lucide/svelte/icons/info';
	import { cn } from '$lib/utils';

	/**
	 * A short explanation attached to a control or a section: what a field is
	 * for, why a list is empty, what a rule means. It is not a notification —
	 * it belongs next to the thing it explains and stays on screen. Anything the
	 * user has to acknowledge belongs in a toast or an `Alert` instead.
	 */
	let {
		tone = 'neutral',
		icon = InfoIcon,
		class: className,
		children
	}: {
		tone?: InlineHintTone;
		/** Pass `null` to drop the icon when the hint sits under a field. */
		icon?: LucideIcon | null;
		class?: string;
		children: Snippet;
	} = $props();

	const Icon = $derived(icon);
</script>

<p class={cn(inlineHintVariants({ tone }), className)} data-slot="inline-hint">
	{#if Icon}
		<Icon class="mt-px size-3.5 shrink-0" aria-hidden="true" />
	{/if}
	<span>{@render children()}</span>
</p>
