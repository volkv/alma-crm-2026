<script lang="ts">
	import { page } from '$app/state';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import type { ReportBreakdown } from '$lib/contracts/reports';
	import { formatNumber, pluralize } from '$lib/format';
	import { toggledHref } from './query';
	import type { ReportParam } from '$lib/contracts/reports';

	/**
	 * Разрез выборки: сколько строк приходится на каждое значение признака.
	 *
	 * Взаимодействие с двумя продуктами попадает в обе строки, поэтому сумма по
	 * строкам законно больше числа строк отчёта — и разрез говорит об этом сам,
	 * числом записей, а не общей оговоркой.
	 *
	 * Каждая строка — ссылка на тот же отчёт, суженный до этого значения: путь
	 * «число → строки → карточка» начинается здесь.
	 */
	let {
		breakdown,
		param,
		rowCount
	}: {
		breakdown: ReportBreakdown;
		param: ReportParam;
		rowCount: number;
	} = $props();

	const total = $derived(breakdown.points.reduce((sum, point) => sum + point.value, 0));
</script>

<section class="rounded-lg border border-border bg-surface p-4 shadow-xs">
	<h2 class="text-sm font-semibold">{breakdown.label}</h2>

	{#if breakdown.points.length === 0}
		<p class="mt-2 text-xs text-muted-foreground">В выборке нет ни одного значения.</p>
	{:else}
		<ul class="mt-2 text-sm">
			{#each breakdown.points as point (point.key)}
				<li
					class="flex items-center justify-between gap-3 border-b border-border py-1 last:border-0"
				>
					<a
						class="min-w-0 truncate text-primary focus-ring"
						href={toggledHref(page.url, param, point.key)}
					>
						{point.label}
					</a>
					<b class="shrink-0 font-semibold tabular-nums">{formatNumber(point.value)}</b>
				</li>
			{/each}
		</ul>

		{#if breakdown.doubleCounted > 0}
			<InlineHint tone="warning" class="mt-2">
				Сумма по строкам — {formatNumber(total)} при {pluralize(rowCount, [
					'строке',
					'строках',
					'строках'
				])} отчёта: {pluralize(breakdown.doubleCounted, ['запись', 'записи', 'записей'])} учтено дважды
				и более.
			</InlineHint>
		{/if}
	{/if}
</section>
