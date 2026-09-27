<script lang="ts" module>
	import type { ResolvedPathname } from '$app/types';

	/** Срез, на который список открыт ссылкой: подпись и адрес без него. */
	export type ActiveSlice = {
		key: string;
		label: string;
		removeHref: ResolvedPathname;
	};
</script>

<script lang="ts">
	import XIcon from '@lucide/svelte/icons/x';

	/**
	 * Метки срезов над списком. На список ведут числа главной («Мой день»,
	 * плитки портфеля), и фильтр такого перехода часто уезжает в «Ещё фильтры»:
	 * без метки человек видит урезанный список и не понимает, чем он урезан.
	 * Крестик снимает один срез, остальной отбор остаётся.
	 */
	let { slices, testId }: { slices: readonly ActiveSlice[]; testId: string } = $props();
</script>

{#if slices.length > 0}
	<ul class="flex flex-wrap items-center gap-2" aria-label="Открытый срез" data-testid={testId}>
		{#each slices as slice (slice.key)}
			<li
				class="inline-flex h-7 items-center gap-1 rounded-full border border-selection-border bg-selection pr-1 pl-3 text-sm font-medium text-selection-foreground"
				data-testid="{testId}-{slice.key}"
			>
				<span>{slice.label}</span>
				<a
					href={slice.removeHref}
					class="inline-flex size-5 items-center justify-center rounded-full hover:bg-surface-pressed focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
					aria-label="Снять: {slice.label}"
					title="Снять"
				>
					<XIcon class="size-3.5" aria-hidden="true" />
				</a>
			</li>
		{/each}
	</ul>
{/if}
