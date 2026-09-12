<script lang="ts">
	import { formatNumber } from '$lib/format';
	import { STAT_FIELD_LABELS, type RankingComponent } from '$lib/contracts/stats';
	import { measureText } from './labels';

	/**
	 * Почему у программы такое место.
	 *
	 * Порядок без объяснения — это не ответ, а требование поверить на слово.
	 * Здесь показано каждое слагаемое: сколько взяли, с каким весом и сколько
	 * это дало; сумма вкладов равна самому баллу (`explainScore` в контрактах).
	 */
	let { explanation }: { explanation: readonly RankingComponent[] } = $props();
</script>

<ul class="flex flex-col gap-0.5 text-xs" data-slot="score-breakdown">
	{#each explanation as part (part.component)}
		<li class="flex flex-wrap items-baseline gap-1">
			<span class="text-muted-foreground">{STAT_FIELD_LABELS[part.component]}:</span>
			<span>{measureText(part.value)}</span>
			<span class="text-muted-foreground">× {part.weight} =</span>
			<span class="font-medium">{formatNumber(part.contribution)}</span>
		</li>
	{/each}
</ul>
