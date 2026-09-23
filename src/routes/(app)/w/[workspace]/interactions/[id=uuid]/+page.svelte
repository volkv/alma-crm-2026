<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { resolve } from '$app/paths';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import CardFacts from '$lib/components/interaction-card/card-facts.svelte';
	import { setCardCommands } from '$lib/components/interaction-card/commands.svelte';
	import ContextPanels from '$lib/components/interaction-card/context-panels.svelte';
	import DocumentDialogs from '$lib/components/interaction-card/document-dialogs.svelte';
	import EventFeed from '$lib/components/interaction-card/event-feed.svelte';
	import LearningDialogs from '$lib/components/interaction-card/learning-dialogs.svelte';
	import { buildCard, type CardSource } from '$lib/components/interaction-card/model';
	import PrimaryAction from '$lib/components/interaction-card/primary-action.svelte';
	import RecordDialogs from '$lib/components/interaction-card/record-dialogs.svelte';
	import StageDialogs from '$lib/components/interaction-card/stage-dialogs.svelte';
	import type { InteractionAction } from '$lib/contracts/interactions';
	import { formatDateTime } from '$lib/format';
	import { INTERACTION_STATUS_LABELS } from '../filters';
	import type { PageProps } from './$types';

	/**
	 * Карточка взаимодействия — одной колонкой, сверху вниз: факты и процесс,
	 * единственное главное действие с тем, что ему мешает, и лента всего, что
	 * случилось. Контекст (сторона, договор, обучение, документы) стоит узкой
	 * колонкой сбоку на рабочем экране, а на телефоне — между действием и
	 * лентой, свёрнутым.
	 *
	 * Приговор по каждой команде выносит сервер; карточка только раскладывает
	 * его так, чтобы каждый факт был назван в одном месте.
	 */
	let { data }: PageProps = $props();

	setCardCommands();

	const source = $derived<CardSource>({
		interaction: data.interaction,
		status: data.status,
		summary: data.summary,
		closing: data.closing,
		comments: data.comments,
		changes: data.changes,
		counterparty: data.counterparty,
		exchange: data.exchange
	});
	const model = $derived(buildCard(source, new Date()));

	const can = (action: InteractionAction) => data.summary.canDo.actions.includes(action);

	/**
	 * На телефоне контекст свёрнут: первым делом нужно понять, что делать, а
	 * реквизиты — по запросу. Разметка у панелей одна на обе ширины — от
	 * ширины зависит только, спрятаны ли они, — поэтому формы и их диалоги не
	 * рендерятся дважды.
	 */
	let contextOpen = $state(false);
</script>

<svelte:head>
	<title>{data.interaction.title} — LCT CRM</title>
</svelte:head>

<Header title={data.interaction.title}>
	{#snippet actions()}
		{#if data.interaction.status !== 'active'}
			<StatusBadge tone={data.interaction.status === 'completed' ? 'success' : 'neutral'}>
				{INTERACTION_STATUS_LABELS[data.interaction.status]}
			</StatusBadge>
		{/if}
	{/snippet}
</Header>

<Breadcrumbs
	items={[
		{
			label: data.workspace.name,
			href: resolve('/(app)/w/[workspace]/interactions', { workspace: data.workspace.key })
		},
		{ label: data.interaction.title }
	]}
/>

<div class="flex min-w-0 flex-col gap-4 p-4 sm:px-9 sm:py-6">
	{#if data.status.migratedFrom !== null}
		<!-- Уведомление живёт, пока запись открыта: закрылась — дальше человек
			шёл сам, и объяснять больше нечего. -->
		<InlineHint tone="warning">
			Стадия перенесена при изменении процесса: раньше запись стояла на стадии «{data.status
				.migratedFrom.stageName}», перенос выполнен {formatDateTime(data.status.migratedFrom.at)}.
		</InlineHint>
	{/if}

	<CardFacts {model} />

	<!-- Три блока — действие, контекст, лента — стоят в разметке в том порядке,
		в каком их читают на телефоне. На рабочем экране контекст уходит в правую
		колонку на всю высоту, а лишняя высота достаётся последней строке, чтобы
		между действием и лентой не появлялся зазор. -->
	<div
		class="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:grid-rows-[auto_1fr] xl:grid-cols-[minmax(0,1fr)_20rem]"
	>
		<div
			class="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-xs lg:col-start-1 lg:row-start-1"
		>
			<PrimaryAction
				action={model.action}
				primary={model.primary}
				secondary={model.secondary}
				currentStageId={data.status.current?.stageId ?? null}
				canCheck={can('set_checklist')}
				canResolve={can('resolve_blocker')}
			/>
		</div>

		<aside
			class="min-w-0 rounded-xl border border-border bg-surface lg:col-start-2 lg:row-span-2 lg:row-start-1"
			aria-label="Контекст"
			data-tour="interaction-context"
		>
			<button
				type="button"
				class="flex w-full items-center justify-between gap-2 rounded-xl p-4 text-left text-sm font-medium focus-ring lg:hidden"
				aria-expanded={contextOpen}
				aria-controls="card-context"
				onclick={() => (contextOpen = !contextOpen)}
			>
				Контрагент, договор, документы
				<ChevronRightIcon
					class="size-4 shrink-0 text-muted-foreground transition-transform {contextOpen
						? 'rotate-90'
						: ''}"
					aria-hidden="true"
				/>
			</button>
			<div
				id="card-context"
				class="border-t border-border p-4 lg:border-t-0 {contextOpen ? '' : 'max-lg:hidden'}"
			>
				<ContextPanels
					{source}
					shape={model.shape}
					supersessions={data.supersessions}
					can={{
						edit: can('edit'),
						upload: can('upload_document'),
						generate: can('generate_document')
					}}
				/>
			</div>
		</aside>

		<div
			class="min-w-0 rounded-xl border border-border bg-surface p-4 lg:col-start-1 lg:row-start-2"
		>
			<EventFeed events={model.events} canComment={can('comment')} />
		</div>
	</div>
</div>

<StageDialogs
	entry={data.status.current}
	revision={data.status.revision}
	documents={data.interaction.documents}
	closing={data.closing}
	canAttach={can('upload_document')}
/>
<RecordDialogs interaction={data.interaction} users={data.users} contracts={data.contracts} />
<DocumentDialogs interaction={data.interaction} supersessions={data.supersessions} />
<LearningDialogs exchange={data.exchange} />
