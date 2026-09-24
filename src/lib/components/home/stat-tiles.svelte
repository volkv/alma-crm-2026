<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import { formatNumber } from '$lib/format';
	import type { OverviewCounters } from '$lib/server/interactions/overview';
	import { cn } from '$lib/utils';
	import { interactionsHref } from './links';

	/**
	 * Портфель в шести числах: сколько в работе, сколько горит и сколько уже
	 * позади. Плитка, у которой есть такой же набор в списке, — ссылка: число
	 * без возможности увидеть, из чего оно сложилось, заставляет верить на слово.
	 *
	 * Считает числа сервер (`getWorkOverview`), компонент только показывает их.
	 */
	let { counters }: { counters: OverviewCounters } = $props();

	type Tile = {
		label: string;
		value: number;
		/** Чем число является: подпись объясняет, что именно посчитано. */
		hint: string;
		tone: 'neutral' | 'danger' | 'warning' | 'success';
		/** Список с тем же набором; `null` — такого фильтра в списке нет. */
		href: ResolvedPathname | null;
	};

	const tiles = $derived<Tile[]>([
		{
			label: 'В работе',
			value: counters.active,
			hint: 'активных взаимодействий',
			tone: 'neutral',
			href: interactionsHref({ status: 'active' })
		},
		{
			label: 'Просроченные',
			value: counters.overdue,
			hint: 'срок стадии прошёл',
			tone: 'danger',
			href: interactionsHref({ status: 'active', overdue: true })
		},
		{
			label: 'На паузе',
			value: counters.paused,
			hint: 'часы стадии остановлены',
			tone: 'neutral',
			href: null
		},
		{
			label: 'С помехами',
			value: counters.blocked,
			hint: 'есть открытая помеха',
			tone: 'warning',
			href: null
		},
		{
			label: 'Тишина',
			value: counters.stale,
			hint: 'событий нет дольше нормы',
			tone: 'neutral',
			href: null
		},
		{
			label: 'Завершённые',
			value: counters.completedRecently,
			hint: 'за последние 30 дней',
			tone: 'success',
			href: interactionsHref({ status: 'completed' })
		}
	]);

	const valueTone: Record<Tile['tone'], string> = {
		neutral: 'text-foreground',
		danger: 'text-danger',
		warning: 'text-warning-soft-foreground',
		success: 'text-success-soft-foreground'
	};

	/** Ноль ничем не грозит, поэтому и цветом не кричит. */
	function toneClass(tile: Tile): string {
		return tile.value === 0 ? 'text-faint' : valueTone[tile.tone];
	}
</script>

{#snippet body(tile: Tile)}
	<span class="truncate text-xs text-muted-foreground">{tile.label}</span>
	<span class={cn('mt-1 text-xl leading-none font-semibold tabular-nums', toneClass(tile))}>
		{formatNumber(tile.value)}
	</span>
	<span class="mt-1 truncate text-xs text-faint" title={tile.hint}>{tile.hint}</span>
{/snippet}

<!-- Плитки — ячейки одной панели, а не шесть отдельных карточек: рядом со
	«Моим днём» они вторичны и не должны спорить с ним рамками. -->
<div
	class="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-3 xl:grid-cols-2"
	data-slot="stat-tiles"
>
	{#each tiles as tile (tile.label)}
		{#if tile.href === null}
			<div class="flex min-w-0 flex-col bg-surface px-4 py-2.5">
				{@render body(tile)}
			</div>
		{:else}
			<a
				href={tile.href}
				class="flex min-w-0 flex-col bg-surface px-4 py-2.5 focus-ring-inset transition-colors hover:bg-surface-muted"
				aria-label="{tile.label}: {tile.value}. Открыть список"
			>
				{@render body(tile)}
			</a>
		{/if}
	{/each}
</div>
