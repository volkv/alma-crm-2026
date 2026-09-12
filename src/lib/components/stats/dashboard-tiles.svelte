<script lang="ts">
	import { statDashboardTiles, type StatDashboardTotals } from '$lib/contracts/stats';
	import { formatNumber } from '$lib/format';

	/**
	 * Портфель данных периода в шести числах.
	 *
	 * Прочерк и ноль здесь разные ответы: ноль — это записанный в выгрузке
	 * ноль, прочерк — незаполненная колонка, и рядом с ним так и написано.
	 * Сами числа собирает `statDashboardTiles` — та же функция, по которой
	 * строится лист «Сводка» в выгрузке.
	 */
	let { totals }: { totals: StatDashboardTotals } = $props();

	const tiles = $derived(statDashboardTiles(totals));

	function measure(value: number | null, unit: 'count' | 'percent'): string {
		if (value === null) {
			return '—';
		}

		return unit === 'percent' ? `${formatNumber(value)} %` : formatNumber(value);
	}
</script>

<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" data-slot="dashboard-tiles">
	{#each tiles as tile (tile.key)}
		<div class="flex flex-col rounded-lg border border-border bg-surface px-3 py-3">
			<span class="text-xs text-muted-foreground">{tile.label}</span>
			<span
				class="mt-1 text-2xl leading-none font-semibold {tile.value === null
					? 'text-faint'
					: 'text-foreground'}"
			>
				{measure(tile.value, tile.unit)}
			</span>
			<span class="mt-1 text-xs text-faint">
				{tile.value === null ? 'нет данных' : tile.hint}
			</span>
			{#each tile.extra as extra (extra.label)}
				<span class="mt-1 text-xs text-muted-foreground">
					{extra.label}: {extra.value === null ? '— нет данных' : formatNumber(extra.value)}
				</span>
			{/each}
		</div>
	{/each}
</div>
