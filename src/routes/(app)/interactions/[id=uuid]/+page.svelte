<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { filterHref } from '$lib/components/directory/query';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StageTimeline from '$lib/components/stage-timeline.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import BlockersPanel from '$lib/components/interactions/blockers-panel.svelte';
	import CommentsPanel from '$lib/components/interactions/comments-panel.svelte';
	import DocumentsPanel from '$lib/components/interactions/documents-panel.svelte';
	import HistoryPanel from '$lib/components/interactions/history-panel.svelte';
	import PlanPanel from '$lib/components/interactions/plan-panel.svelte';
	import StageWork from '$lib/components/interactions/stage-work.svelte';
	import SummaryPanel from '$lib/components/interactions/summary-panel.svelte';
	import { toTimelineStages } from '$lib/components/interactions/timeline';
	import { formatDateTime } from '$lib/format';
	import ClosingActions from './closing-actions.svelte';
	import { INTERACTION_STATUS_LABELS } from '../filters';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const parties = $derived(
		data.interaction.parties.map((party) => party.organizationName).join(' · ')
	);
	const entries = $derived(
		data.status.current === null
			? data.status.history
			: [data.status.current, ...data.status.history]
	);
	const can = (action: string) => data.summary.canDo.actions.includes(action as 'pause');
	// Итог закрытого взаимодействия лежит там же, где исход любой стадии, — в
	// последней записи истории: закрытие и есть выход с последней стадии.
	const closed = $derived(
		data.interaction.status === 'active' ? null : (data.status.history[0] ?? null)
	);

	/**
	 * Вкладка живёт в адресе: на неё ссылаются («смотри историю»), к ней
	 * возвращает кнопка «назад», и после действия страница открывается там же,
	 * где человек работал. Значение из адреса — ввод человека: непонятное
	 * `tab=xyz` не ошибка, а просто вкладка по умолчанию.
	 */
	const TABS = ['work', 'documents', 'blockers', 'plan', 'history', 'comments'] as const;

	type CardTab = (typeof TABS)[number];

	const tab = $derived.by<CardTab>(() => {
		const asked = page.url.searchParams.get('tab');

		return TABS.includes(asked as CardTab) ? (asked as CardTab) : 'work';
	});

	let panels = $state<HTMLElement | null>(null);

	function openTab(next: string) {
		// Первая вкладка — это адрес карточки без параметра: два адреса одного и
		// того же экрана разошлись бы в ссылках и в истории браузера.
		void goto(filterHref(page.url, 'tab', next === 'work' ? '' : next), {
			keepFocus: true,
			noScroll: true
		});

		// На ноутбуке полоса вкладок стоит у нижней границы окна, и панель
		// открывается ниже сгиба: без прокрутки нажатие выглядит как «ничего не
		// произошло». Полоса подводится под липкую шапку (56 px вместе с полосой
		// демо-режима, которая липкая заодно с ней), и панель оказывается на
		// экране целиком, с какого бы места её ни переключали.
		if (panels !== null) {
			const top = panels.getBoundingClientRect().top + window.scrollY - 96;

			window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
		}
	}
</script>

<svelte:head>
	<title>{data.interaction.title} — LCT CRM</title>
</svelte:head>

<Header title={data.interaction.title} description={parties}>
	{#snippet actions()}
		{#if data.interaction.status !== 'active'}
			<StatusBadge tone={data.interaction.status === 'completed' ? 'success' : 'neutral'}>
				{INTERACTION_STATUS_LABELS[data.interaction.status]}
			</StatusBadge>
		{/if}
		{#if data.status.isStale}
			<StatusBadge tone="warning" dot title="Давно не было событий">Тишина</StatusBadge>
		{/if}
	{/snippet}
</Header>

<Breadcrumbs
	items={[
		{ label: 'Взаимодействия', href: resolve('/interactions') },
		{ label: data.interaction.title }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<div class="rounded-lg border border-border bg-surface p-4" data-tour="interaction-timeline">
		<StageTimeline
			stages={toTimelineStages(data.status.progress, {
				assignee: data.summary.whoActs.responsibleUser?.name ?? null
			})}
		/>
	</div>

	{#if data.status.migratedFrom !== null}
		<!-- Уведомление живёт, пока запись открыта: закрылась — дальше человек
			шёл сам, и объяснять больше нечего. -->
		<InlineHint tone="warning">
			Стадия перенесена при изменении процесса: раньше запись стояла на стадии «{data.status
				.migratedFrom.stageName}», перенос выполнен {formatDateTime(data.status.migratedFrom.at)}.
		</InlineHint>
	{/if}

	{#if closed !== null}
		<div class="rounded-lg border border-border bg-surface p-4">
			<p class="text-sm font-medium">
				{INTERACTION_STATUS_LABELS[data.interaction.status]} — {closed.snapshot.position}. {closed
					.snapshot.name}
			</p>
			<p class="text-xs text-muted-foreground">
				{closed.leftAt ? formatDateTime(closed.leftAt) : ''}
			</p>
			{#if closed.outcomeReason}
				<p class="mt-2 text-sm">Итог: {closed.outcomeReason}</p>
			{/if}
		</div>
	{/if}

	<SummaryPanel
		summary={data.summary}
		currentStageId={data.status.current?.stageId ?? null}
		revision={data.status.revision}
		canAttach={can('upload_document')}
	>
		{#snippet closing()}
			{#if data.interaction.status === 'active'}
				<ClosingActions closing={data.closing} revision={data.status.revision} />
			{/if}
		{/snippet}
	</SummaryPanel>

	<Tabs.Root bind:value={() => tab, (next) => openTab(next)} bind:ref={panels} class="min-w-0">
		<!-- Шесть вкладок в строку шире телефона: на узком экране список
			прокручивается сам, а не уносит вправо весь документ. -->
		<Tabs.List class="max-w-full overflow-x-auto" data-tour="interaction-tabs">
			<Tabs.Trigger value="work">Стадия</Tabs.Trigger>
			<Tabs.Trigger value="documents">Документы</Tabs.Trigger>
			<Tabs.Trigger value="blockers">Помехи</Tabs.Trigger>
			<Tabs.Trigger value="plan">План</Tabs.Trigger>
			<Tabs.Trigger value="history">История</Tabs.Trigger>
			<Tabs.Trigger value="comments">Комментарии</Tabs.Trigger>
		</Tabs.List>

		<Tabs.Content value="work" class="pt-4">
			<StageWork
				entry={data.status.current}
				documents={data.interaction.documents}
				canWork={can('set_result')}
			/>
		</Tabs.Content>

		<Tabs.Content value="documents" class="pt-4">
			<DocumentsPanel
				interaction={data.interaction}
				documents={data.interaction.documents}
				supersessions={data.supersessions}
				canUpload={can('upload_document')}
				canGenerate={can('generate_document')}
			/>
		</Tabs.Content>

		<Tabs.Content value="blockers" class="pt-4">
			<BlockersPanel blockers={data.status.blockers} canWrite={can('raise_blocker')} />
		</Tabs.Content>

		<Tabs.Content value="plan" class="pt-4">
			<PlanPanel
				interaction={data.interaction}
				users={data.users}
				contracts={data.contracts}
				canWrite={can('edit')}
			/>
		</Tabs.Content>

		<Tabs.Content value="history" class="pt-4">
			<HistoryPanel {entries} changes={data.changes} />
		</Tabs.Content>

		<Tabs.Content value="comments" class="pt-4">
			<CommentsPanel comments={data.comments} canWrite={can('comment')} />
		</Tabs.Content>
	</Tabs.Root>
</div>
