<script lang="ts">
	import HourglassIcon from '@lucide/svelte/icons/hourglass';
	import { daysUntil, formatDate, pluralize, type DateInput } from '$lib/format';
	import EmptyState from '$lib/components/empty-state.svelte';
	import type { OverviewWaiting } from '$lib/server/interactions/overview';
	import { interactionHref } from './links';

	/**
	 * Кого мы ждём: взаимодействия с остановленными часами стадии. Это не список
	 * дел — это список поводов напомнить о себе, поэтому у каждой строки видно,
	 * чего именно ждут и сколько уже ждут.
	 */
	let {
		items,
		now
	}: {
		items: readonly OverviewWaiting[];
		now: DateInput;
	} = $props();

	/** Сколько дней уже длится ожидание: пауза началась в прошлом. */
	function waitingFor(since: Date): string {
		const days = -daysUntil(since, now);

		return days <= 0 ? 'с сегодняшнего дня' : `${pluralize(days, ['день', 'дня', 'дней'])}`;
	}
</script>

{#if items.length === 0}
	<EmptyState
		icon={HourglassIcon}
		title="Никого не ждём"
		description="Ни на одном взаимодействии часы стадии не остановлены."
	/>
{:else}
	<ul class="divide-y divide-border">
		{#each items as item (item.interactionId)}
			<li class="flex flex-col gap-1 px-4 py-3">
				<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
					<a
						href={interactionHref(item.interactionId)}
						class="min-w-0 rounded-sm text-sm font-medium focus-ring hover:underline"
					>
						{item.title}
					</a>
					<span class="text-xs text-faint" title="Пауза с {formatDate(item.since)}">
						ждём {waitingFor(item.since)}
					</span>
				</div>
				<p class="text-xs text-muted-foreground">
					<span class="font-medium text-foreground">{item.party ?? 'Сторона не указана'}</span>
					— {item.nextAction ?? item.note}
				</p>
			</li>
		{/each}
	</ul>
{/if}
