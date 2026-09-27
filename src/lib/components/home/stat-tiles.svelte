<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import type { InteractionListState } from '$lib/contracts/interactions';
	import { formatNumber } from '$lib/format';
	import type { OverviewCounters } from '$lib/server/interactions/overview';
	import { cn } from '$lib/utils';
	import { singleHref, type WorkspaceCount } from './links';
	import WorkspaceParts from './workspace-parts.svelte';

	/**
	 * Портфель в шести числах: сколько в работе, сколько горит и сколько уже
	 * позади. Плитка, у которой есть такой же набор в списке, — ссылка: число
	 * без возможности увидеть, из чего оно сложилось, заставляет верить на слово.
	 * Если работа в нескольких пространствах, ссылки — у частей числа под ним
	 * (`WorkspaceParts`): список живёт в пространстве, и одной ссылкой весь
	 * набор не открыть.
	 *
	 * У каждой плитки такой отбор есть: пауза, помехи и тишина — `state`,
	 * завершённые за 30 дней — `closed` в адресе списка.
	 *
	 * Считает числа сервер (`getWorkOverview`), компонент только показывает их.
	 */
	let {
		counters,
		active,
		overdue,
		states,
		completed
	}: {
		counters: OverviewCounters;
		/** «В работе» по пространствам — теми же списками, куда ведут ссылки. */
		active: readonly WorkspaceCount[];
		/** «Просроченные» по пространствам. */
		overdue: readonly WorkspaceCount[];
		/** «На паузе», «С помехами», «Тишина» по пространствам. */
		states: Readonly<Record<InteractionListState, readonly WorkspaceCount[]>>;
		/** «Завершённые» за окно по пространствам. */
		completed: readonly WorkspaceCount[];
	} = $props();

	type Tile = {
		label: string;
		value: number;
		/** Чем число является: подпись объясняет, что именно посчитано. */
		hint: string;
		tone: 'neutral' | 'danger' | 'warning' | 'success';
		/** Список с тем же набором; `null` — частей несколько или набор пуст. */
		href: ResolvedPathname | null;
		/** Части по пространствам со ссылками; пусто — набор пуст. */
		parts: readonly WorkspaceCount[];
	};

	const tiles = $derived<Tile[]>([
		{
			label: 'В работе',
			value: counters.active,
			hint: 'активных взаимодействий',
			tone: 'neutral',
			href: singleHref(active),
			parts: active
		},
		{
			label: 'Просроченные',
			value: counters.overdue,
			hint: 'срок стадии прошёл',
			tone: 'danger',
			href: singleHref(overdue),
			parts: overdue
		},
		{
			label: 'На паузе',
			value: counters.paused,
			hint: 'часы стадии остановлены',
			tone: 'neutral',
			href: singleHref(states.paused),
			parts: states.paused
		},
		{
			label: 'С помехами',
			value: counters.blocked,
			hint: 'есть открытая помеха',
			tone: 'warning',
			href: singleHref(states.blocked),
			parts: states.blocked
		},
		{
			label: 'Тишина',
			value: counters.stale,
			hint: 'событий нет дольше нормы',
			tone: 'neutral',
			href: singleHref(states.stale),
			parts: states.stale
		},
		{
			label: 'Завершённые',
			value: counters.completedRecently,
			hint: 'за последние 30 дней',
			tone: 'success',
			href: singleHref(completed),
			parts: completed
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
	<span class="line-clamp-2 text-xs text-muted-foreground">{tile.label}</span>
	<span class={cn('mt-1 text-xl leading-none font-semibold tabular-nums', toneClass(tile))}>
		{formatNumber(tile.value)}
	</span>
	<!-- Пояснение переносится, а не обрезается: «часы стадии останов…» не
		объясняет, что посчитано. Две строки высотой у всех плиток — ряд ровный. -->
	<span class="mt-1 line-clamp-2 min-h-8 text-xs text-faint">{tile.hint}</span>
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
				<WorkspaceParts parts={tile.parts} label={tile.label} />
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
