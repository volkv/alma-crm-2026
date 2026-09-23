<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import EmptyState from '$lib/components/empty-state.svelte';
	import { explainPlace, type RankingEntry } from '$lib/contracts/ranking';
	import { formatNumber } from '$lib/format';
	import ScoreBreakdown from './score-breakdown.svelte';

	/**
	 * Строки рейтинга: место, название, балл, его разложение и ответ на вопрос
	 * «почему на этом месте» словами.
	 *
	 * Не таблица: разложение балла — это несколько строк, и в колонке таблицы
	 * на половине широкого экрана оно уезжало бы за край с прокруткой, о которой
	 * ничего не сообщает. Балл и объяснение — это и есть ответ рейтинга.
	 *
	 * Объяснение считается по всему рейтингу, даже когда показана только его
	 * верхушка: отрыв от соседа снизу у пятой строки — это шестая строка.
	 */
	let {
		entries,
		limit,
		hrefOf,
		emptyTitle,
		emptyDescription
	}: {
		entries: readonly RankingEntry[];
		/** Сколько строк показать; без него — все. */
		limit?: number;
		hrefOf: (id: string) => ResolvedPathname;
		emptyTitle: string;
		emptyDescription: string;
	} = $props();

	const shown = $derived(limit === undefined ? entries : entries.slice(0, limit));
</script>

{#if entries.length === 0}
	<EmptyState title={emptyTitle} description={emptyDescription} />
{:else}
	<ol class="flex flex-col divide-y divide-border" data-slot="ranking-list">
		{#each shown as entry, index (entry.id)}
			<li class="flex flex-col gap-1.5 px-4 py-3" data-code={entry.code}>
				<div class="flex items-baseline gap-2">
					<span class="w-5 shrink-0 text-right text-xs text-muted-foreground">{entry.place}</span>
					<a href={hrefOf(entry.id)} class="flex min-w-0 flex-col focus-ring">
						<span class="font-medium underline-offset-2 hover:underline">{entry.name}</span>
						<span class="text-xs text-muted-foreground">{entry.code}</span>
					</a>
					<span class="ml-auto flex shrink-0 items-baseline gap-1">
						<span class="text-xs text-muted-foreground">Балл</span>
						<span class="font-medium" data-slot="score-value">{formatNumber(entry.score)}</span>
					</span>
				</div>
				<div class="flex flex-col gap-1 pl-7">
					<ScoreBreakdown score={entry} />
					<p class="text-xs text-muted-foreground" data-slot="ranking-reason">
						{explainPlace(entries, index)}
					</p>
				</div>
			</li>
		{/each}
	</ol>
{/if}
