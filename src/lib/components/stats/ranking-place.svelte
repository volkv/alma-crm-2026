<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import { Button } from '$lib/components/ui/button/index.js';
	import { statPeriodKey } from '$lib/contracts/stats';
	import { RANKING_FORMULA_NOTE, type RankingPlace } from '$lib/contracts/ranking';
	import { formatDate, formatNumber } from '$lib/format';
	import ScoreBreakdown from './score-breakdown.svelte';

	/**
	 * Место программы или направления в рейтинге за учебный год — блоком на
	 * карточке. Число без объяснения здесь так же бесполезно, как в самом
	 * рейтинге, поэтому рядом с местом стоит разложение балла и ответ «почему»,
	 * а ссылка ведёт в рейтинг того же периода, где видны соседи.
	 */
	let {
		place,
		period
	}: {
		place: RankingPlace | null;
		period: { start: string; end: string };
	} = $props();

	const rankingHref = $derived(
		`${resolve('/(app)/data/ranking')}?period=${statPeriodKey(period)}` as ResolvedPathname
	);
</script>

<section class="rounded-lg border border-border bg-surface p-4 sm:p-6" data-slot="ranking-place">
	<header class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
		<h2 class="section-title">
			Рейтинг за {formatDate(period.start)} — {formatDate(period.end)}
		</h2>
		<Button variant="outline" size="sm" href={rankingHref}>Весь рейтинг</Button>
	</header>

	{#if place === null}
		<p class="text-sm text-muted-foreground">
			За этот период в вашей области нет ни заявок с сайта, ни учебных групп — места в рейтинге нет.
		</p>
	{:else}
		<div class="flex flex-col gap-2">
			<p class="flex items-baseline gap-2">
				<span class="text-xl font-semibold">{place.entry.place}-е место</span>
				<span class="text-sm text-muted-foreground">
					из {formatNumber(place.total)}, балл {formatNumber(place.entry.score)}
				</span>
			</p>
			{#if place.entry.priorityBonus > 0 || place.entry.factPlace !== place.entry.place}
				<p class="text-sm text-muted-foreground">
					По одним фактам: {place.entry.factPlace}-е место, балл {formatNumber(
						place.entry.factScore
					)}
				</p>
			{/if}
			<ScoreBreakdown score={place.entry} />
			<p class="text-xs text-muted-foreground">{place.reason}</p>
			<p class="text-xs text-muted-foreground">
				{RANKING_FORMULA_NOTE} на экране рейтинга. Считается по фактам системы — заявкам с сайта и учебным
				группам, а не по загруженным снимкам статистики.
			</p>
		</div>
	{/if}
</section>
