<script lang="ts">
	import { formatNumber } from '$lib/format';
	import { cn } from '$lib/utils';
	import type { WorkspaceCount } from './links';

	/**
	 * Число сводки по пространствам: «Работа с вузами 18 · Коммерческое
	 * обучение 5». Каждая часть — ссылка в список своего пространства, где
	 * строк ровно столько, сколько написано рядом; сумма частей — число плитки.
	 *
	 * Рисуется, только когда частей больше одной: если работа в одном
	 * пространстве, ссылкой служит сама плитка.
	 */
	let {
		parts,
		label,
		class: className
	}: {
		parts: readonly WorkspaceCount[];
		/** Что за число раскладывается — для чтения с экранным диктором. */
		label: string;
		class?: string;
	} = $props();
</script>

{#if parts.length > 1}
	<ul
		class={cn('flex flex-wrap gap-x-3 gap-y-0.5 text-xs', className)}
		aria-label="{label}: по пространствам"
		data-slot="workspace-parts"
	>
		{#each parts as part (part.key)}
			<li>
				<a
					href={part.href}
					class="rounded-sm text-link focus-ring hover:text-link-hover hover:underline"
					aria-label="{label}, {part.name}: {part.count}. Открыть список"
				>
					{part.name}
					<span class="font-medium tabular-nums">{formatNumber(part.count)}</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}
