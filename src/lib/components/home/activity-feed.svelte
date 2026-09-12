<script lang="ts">
	import HistoryIcon from '@lucide/svelte/icons/history';
	import type { AuditEventType } from '$lib/contracts/audit';
	import { formatDateTime } from '$lib/format';
	import EmptyState from '$lib/components/empty-state.svelte';
	import type { OverviewActivity } from '$lib/server/interactions/overview';
	import { interactionHref } from './links';

	/**
	 * Что происходило вокруг: последние события по взаимодействиям области
	 * доступа. Лента отвечает на вопрос «пока меня не было», поэтому у каждой
	 * строки есть и кто сделал, и над чем, и когда.
	 */
	let {
		items,
		labels
	}: {
		items: readonly OverviewActivity[];
		/** Названия событий — те же, что в журнале действий. */
		labels: Record<AuditEventType, string>;
	} = $props();
</script>

{#if items.length === 0}
	<EmptyState
		icon={HistoryIcon}
		title="Событий пока нет"
		description="Как только по взаимодействиям что-нибудь произойдёт, это появится здесь."
	/>
{:else}
	<ul class="divide-y divide-border">
		{#each items as item (item.id)}
			<li class="flex flex-col gap-0.5 px-4 py-3">
				<div class="flex flex-wrap items-baseline justify-between gap-x-3">
					<span class="text-sm font-medium">{labels[item.eventType]}</span>
					<span class="text-xs text-faint">{formatDateTime(item.occurredAt)}</span>
				</div>
				<a
					href={interactionHref(item.interactionId)}
					class="min-w-0 truncate rounded-sm text-xs text-muted-foreground focus-ring hover:text-foreground hover:underline"
				>
					{item.interactionTitle}
				</a>
				<span class="text-xs text-faint">{item.actorLabel}</span>
			</li>
		{/each}
	</ul>
{/if}
