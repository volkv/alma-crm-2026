<script lang="ts">
	import type { LearningGroupView } from '$lib/contracts/exchange';
	import { formatNumber } from '$lib/format';
	import ContextSection from './context-section.svelte';

	/**
	 * Слушатели по данным потоков: сколько мест заявлено и что пришло из
	 * системы обучения. Своего списка слушателей у записи нет — люди живут в
	 * системе обучения, и сюда приходят их числа, а не фамилии.
	 */
	let { groups }: { groups: readonly LearningGroupView[] } = $props();

	/** Сумма по потокам; `null` — ни один поток этого числа не прислал. */
	function total(pick: (group: LearningGroupView) => number | null): number | null {
		const values = groups.map(pick).filter((value): value is number => value !== null);

		return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
	}

	const rows = $derived([
		{ label: 'Заявлено мест', value: total((group) => group.plannedSeats) },
		{ label: 'Зачислено', value: total((group) => group.enrolled) },
		{ label: 'Окончили', value: total((group) => group.completed) },
		{ label: 'Отчислены', value: total((group) => group.expelled) }
	]);
</script>

<ContextSection title="Слушатели">
	{#if groups.length === 0}
		<p class="text-sm text-muted-foreground">
			Потока ещё нет: числа слушателей приходят из системы обучения вместе с его результатами.
		</p>
	{:else}
		<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
			{#each rows as row (row.label)}
				<dt class="text-muted-foreground">{row.label}</dt>
				<dd class="tabular-nums">
					{#if row.value === null}
						<span class="text-faint">нет данных</span>
					{:else}
						{formatNumber(row.value)}
					{/if}
				</dd>
			{/each}
		</dl>
	{/if}
</ContextSection>
