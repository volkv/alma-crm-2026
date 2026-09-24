<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import EmptyState from '$lib/components/empty-state.svelte';
	import DayCard from './day-card.svelte';
	import type { MyDaySection } from '$lib/contracts/my-day';

	/**
	 * «Мой день»: что требует внимания сегодня, карточкой на раздел. Порядок
	 * разделов и строк считает сервер (`getMyDay`), и тот же список уходит
	 * утренней сводкой: письмо и экран обязаны говорить одно и то же.
	 *
	 * Сетка в две колонки, а не лента: на ноутбуке четыре раздела с первыми
	 * строками помещаются на один экран, и ни один не уезжает вниз за
	 * соседний. Пустые разделы карточек не получают — их ноль уже виден в
	 * счётчиках наверху (`day-counters.svelte`).
	 */
	let { sections }: { sections: readonly MyDaySection[] } = $props();
</script>

{#if sections.length === 0}
	<div class="rounded-lg border border-border bg-surface">
		<EmptyState
			icon={CircleCheckIcon}
			title="Всё в порядке"
			description="Ни просрочки, ни сроков на сегодня и завтра, ни помех, ни долгого ожидания, ни новых заявок, ни лицензий к продлению."
		/>
	</div>
{:else}
	<div class="grid items-start gap-4 lg:grid-cols-2" data-slot="my-day">
		{#each sections as section (section.kind)}
			<DayCard {section} />
		{/each}
	</div>
{/if}
