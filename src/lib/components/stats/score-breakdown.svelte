<script lang="ts">
	import { formatNumber } from '$lib/format';
	import { RANKING_FACT_LABELS, type RankingScore } from '$lib/contracts/ranking';
	import { measureText } from './labels';

	/**
	 * Из чего сложился балл строки рейтинга.
	 *
	 * Порядок без объяснения — это не ответ, а требование поверить на слово.
	 * Здесь показано каждое слагаемое: сколько взяли, с каким весом и сколько
	 * это дало; поправка за ручной приоритет стоит отдельным слагаемым, чтобы
	 * решение человека не пряталось среди фактов. Сумма равна баллу
	 * (`scoreFacts` в контрактах).
	 *
	 * Слагаемые выкладываются в строку и переносятся по месту: в узкой колонке
	 * получается столбик, в широкой карточке — одна-две строки.
	 */
	let { score }: { score: RankingScore } = $props();
</script>

<ul class="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs" data-slot="score-breakdown">
	{#each score.components as part (part.fact)}
		<li class="flex flex-wrap items-baseline gap-1">
			<span class="text-muted-foreground">{RANKING_FACT_LABELS[part.fact]}:</span>
			<span>{measureText(part.value)}</span>
			<span class="text-muted-foreground">× {part.weight} =</span>
			<span class="font-medium">{formatNumber(part.contribution)}</span>
		</li>
	{/each}
	{#if score.priorityBonus > 0}
		<li class="flex flex-wrap items-baseline gap-1">
			<span class="text-muted-foreground">Ручной приоритет {score.priority}:</span>
			<span class="font-medium">+{formatNumber(score.priorityBonus)}</span>
		</li>
	{/if}
</ul>
