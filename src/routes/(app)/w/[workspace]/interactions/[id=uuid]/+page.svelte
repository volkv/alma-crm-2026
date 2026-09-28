<script lang="ts">
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { tick, untrack } from 'svelte';
	import { afterNavigate, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import AccessPeople from '$lib/components/interaction-card/access-people.svelte';
	import { withoutParam } from '$lib/components/directory/query';
	import CardFacts from '$lib/components/interaction-card/card-facts.svelte';
	import {
		COMPOSITION_SECTIONS,
		setCardCommands,
		type CompositionSection
	} from '$lib/components/interaction-card/commands.svelte';
	import CompositionDialog from '$lib/components/interaction-card/composition-dialog.svelte';
	import ContactDialog from '$lib/components/interaction-card/contact-dialog.svelte';
	import ContextPanels from '$lib/components/interaction-card/context-panels.svelte';
	import DocumentDialogs from '$lib/components/interaction-card/document-dialogs.svelte';
	import EventFeed from '$lib/components/interaction-card/event-feed.svelte';
	import LearningDialogs from '$lib/components/interaction-card/learning-dialogs.svelte';
	import { LiveCard } from '$lib/components/interaction-card/live.svelte';
	import { buildCard, type CardSource } from '$lib/components/interaction-card/model';
	import Presence from '$lib/components/interaction-card/presence.svelte';
	import PrimaryAction from '$lib/components/interaction-card/primary-action.svelte';
	import PackageSendDialog from '$lib/components/interaction-card/package-send-dialog.svelte';
	import ProgramOfferDialog from '$lib/components/interaction-card/program-offer-dialog.svelte';
	import QuietNote from '$lib/components/interaction-card/quiet-note.svelte';
	import RecordDialogs from '$lib/components/interaction-card/record-dialogs.svelte';
	import StageDialogs from '$lib/components/interaction-card/stage-dialogs.svelte';
	import {
		siteProgramUnrecognized,
		SITE_PROGRAM_UNRECOGNIZED_NOTICE
	} from '$lib/contracts/exchange';
	import type { InteractionAction } from '$lib/contracts/interactions';
	import { formatDateTime } from '$lib/format';
	import { cardDialogs } from '$lib/platform/card-ui-registry';
	import { offeredTemplates } from '$lib/platform/registry';
	import { packageTemplates } from '$lib/contracts/documents';
	import { INTERACTION_STATUS_LABELS } from '../filters';
	import type { PageProps } from './$types';

	/**
	 * Карточка взаимодействия — одной колонкой, сверху вниз: факты и процесс,
	 * единственное главное действие с тем, что ему мешает, и лента всего, что
	 * случилось. Контекст (сторона и панели, которые объявил процесс) стоит
	 * колонкой около 40 % сбоку на широком экране, а уже — между действием и
	 * лентой, свёрнутым.
	 *
	 * Приговор по каждой команде выносит сервер; карточка только раскладывает
	 * его так, чтобы каждый факт был назван в одном месте.
	 */
	let { data }: PageProps = $props();

	const commands = setCardCommands();

	/**
	 * Живая карточка: поток на эту вкладку, пока она открыта. Изменение дела
	 * у коллеги перечитывает карточку; если открыт диалог — только полоса
	 * «Карточка изменилась», чтобы не сбить начатое.
	 */
	let live = $state<LiveCard | null>(null);

	// Строки, а не `data`: перечитанная карточка приходит новым объектом, и
	// поток по ней переоткрывался бы на каждое обновление. Производное от
	// строки с тем же значением эффект не будит.
	const interactionId = $derived(data.interaction.id);
	const liveUrl = $derived(
		resolve('/(app)/w/[workspace]/interactions/[id=uuid]/live', {
			workspace: data.workspace.key,
			id: data.interaction.id
		})
	);

	$effect(() => {
		const card = new LiveCard(liveUrl, interactionId, () => commands.busy);

		live = card;
		card.start();

		return () => card.stop();
	});

	// Карточка перечитана — своим действием или по событию: полоса «изменилась»
	// о том, что уже на экране, больше не нужна. Без этого собственный переход
	// из диалога оставлял её висеть: событие о нём приходит, пока диалог ещё
	// открыт.
	$effect(() => {
		void data.interaction;
		untrack(() => live?.settle());
	});

	/**
	 * `?compose=parties` — открыть диалог состава этого раздела: так ведут
	 * сюда отказ пакета документов и ссылки из подсказок. Параметр снимается
	 * с адреса сразу, иначе «назад» и перезагрузка открывали бы диалог снова.
	 *
	 * Момент — `afterNavigate`, а не эффект: по ссылке страница приходит
	 * обычной загрузкой, и `replaceState` посреди гидратации падает внутри
	 * маршрутизатора (тот же приём, что у `directory/flash.svelte`).
	 */
	afterNavigate(async () => {
		const requested = page.url.searchParams.get('compose');

		if (requested === null) return;

		const cleaned = withoutParam(page.url, 'compose');

		if (
			data.composition !== null &&
			(COMPOSITION_SECTIONS as readonly string[]).includes(requested)
		) {
			commands.openComposition(requested as CompositionSection);
		}

		await tick();
		replaceState(cleaned, page.state);
	});

	const source = $derived<CardSource>({
		interaction: data.interaction,
		status: data.status,
		summary: data.summary,
		closing: data.closing,
		comments: data.comments,
		changes: data.changes,
		counterparty: data.counterparty,
		exchange: data.exchange,
		paymentFact: data.paymentFact,
		card: data.card,
		modules: data.modules
	});
	const model = $derived(buildCard(source, new Date()));
	// Кого можно упомянуть: те, у кого доступ к делу, кроме самого себя. Список
	// собирает сервер тем же правилом, что открывает карточку; при сохранении
	// он всё равно проверяет каждого адресата сам.
	const mentionable = $derived(
		(live?.people ?? [])
			.filter((person) => person.relation !== null && !person.you)
			.map((person) => ({ userId: person.userId, name: person.name }))
	);

	const listHref = $derived(
		resolve('/(app)/w/[workspace]/interactions', { workspace: data.workspace.key })
	);

	const can = (action: InteractionAction) => data.summary.canDo.actions.includes(action);

	/**
	 * На телефоне контекст свёрнут: первым делом нужно понять, что делать, а
	 * реквизиты — по запросу. Разметка у панелей одна на обе ширины — от
	 * ширины зависит только, спрятаны ли они, — поэтому формы и их диалоги не
	 * рендерятся дважды.
	 */
	let contextOpen = $state(false);

	/** Основная сторона: её контактное лицо правит диалог контакта. */
	const primaryParty = $derived(data.interaction.parties.find((party) => party.isPrimary) ?? null);
</script>

<svelte:head>
	<title>{data.interaction.title} — Альма CRM</title>
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

<!-- Путь на телефоне — одна ссылка назад: название дела уже стоит в
	заголовке, и повтор его в крошках отодвигал «Следующий шаг» под док.
	Обёртка `contents` оставляет крошки прямым потомком оболочки, где их
	ставит на место `-order-1`. -->
<div class="contents max-sm:hidden">
	<Breadcrumbs
		items={[{ label: data.workspace.name, href: listHref }, { label: data.interaction.title }]}
	/>
</div>
<div class="-order-1 border-b border-border bg-surface px-4 py-1.5 sm:hidden">
	<a
		href={listHref}
		class="inline-flex items-center gap-1 rounded-sm text-xs text-link focus-ring hover:text-link-hover hover:underline"
	>
		<ArrowLeftIcon class="size-3.5" aria-hidden="true" />
		Назад к списку
	</a>
</div>

<div class="flex min-w-0 flex-col gap-4 p-4 sm:px-9 sm:py-6">
	{#if data.status.migratedFrom !== null}
		<!-- Уведомление живёт, пока запись открыта: закрылась — дальше человек
			шёл сам, и объяснять больше нечего. -->
		<InlineHint tone="warning">
			Стадия перенесена при изменении процесса: раньше запись стояла на стадии «{data.status
				.migratedFrom.stageName}», перенос выполнен {formatDateTime(data.status.migratedFrom.at)}.
		</InlineHint>
	{/if}

	{#if siteProgramUnrecognized(data.interaction)}
		<!-- Приём заявки ставит программу только по опознанному коду: дело с
			сайта без программы — код не опознан или не прислан. Пометка уходит,
			как только программу выберут. -->
		<InlineHint tone="warning">
			<span class="flex flex-1 flex-wrap items-center justify-between gap-2">
				{SITE_PROGRAM_UNRECOGNIZED_NOTICE}
				{#if data.composition !== null}
					<Button size="sm" variant="outline" onclick={() => commands.openComposition('offering')}>
						Выбрать программу
					</Button>
				{/if}
			</span>
		</InlineHint>
	{/if}

	{#if live !== null && live.stale}
		<InlineHint tone="info">
			<span class="flex flex-1 flex-wrap items-center justify-between gap-2">
				Карточка изменилась, пока вы работали в диалоге.
				<Button size="sm" variant="outline" onclick={() => live?.refresh()}
					>Обновить карточку</Button
				>
			</span>
		</InlineHint>
	{/if}

	{#if live !== null && live.people.length > 0}
		<div
			class="flex flex-wrap items-center justify-between gap-2"
			role="group"
			aria-label="Кто работает с делом"
		>
			<Presence people={live.people} />
			<AccessPeople people={live.people} />
		</div>
	{/if}

	<CardFacts
		{model}
		siteApplication={data.siteApplication}
		moduleData={data.moduleData}
		counterpartyId={data.counterparty === null
			? null
			: (data.interaction.parties.find((party) => party.isPrimary)?.organizationId ?? null)}
	/>

	<!-- Контекст — около 40 % ширины, но не уже 400 и не шире 480 px: в нём
		правят состав, договор и документы, и 320 px не хватало ни на кнопки
		разделов, ни на бейджи. Уже этой ширины колонка одна.
		Три блока — действие, контекст, лента — стоят в разметке в том порядке,
		в каком их читают на телефоне. На рабочем экране контекст уходит в правую
		колонку на всю высоту, а лишняя высота достаётся последней строке, чтобы
		между действием и лентой не появлялся зазор. -->
	<div
		class="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_clamp(25rem,40%,30rem)] xl:grid-rows-[auto_1fr]"
	>
		<div
			class="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-xs xl:col-start-1 xl:row-start-1"
		>
			<PrimaryAction
				action={model.action}
				primary={model.primary}
				secondary={model.secondary}
				canCheck={can('set_checklist')}
				canResolve={can('resolve_blocker')}
			/>
		</div>

		{#if model.quiet !== null}
			<!-- Телефонное место «тишины»: на широком экране она в фактах
				(`CardFacts`), здесь — сразу под действием, которое она советует. -->
			<div class="min-w-0 sm:hidden">
				<QuietNote quiet={model.quiet} />
			</div>
		{/if}

		<aside
			class="min-w-0 rounded-xl border border-border bg-surface xl:col-start-2 xl:row-span-2 xl:row-start-1"
			aria-label="Контекст"
			data-tour="interaction-context"
		>
			<button
				type="button"
				class="flex w-full items-center justify-between gap-2 rounded-xl p-4 text-left text-sm font-medium focus-ring xl:hidden"
				aria-expanded={contextOpen}
				aria-controls="card-context"
				onclick={() => (contextOpen = !contextOpen)}
			>
				Контрагент и условия
				<ChevronRightIcon
					class="size-4 shrink-0 text-muted-foreground transition-transform {contextOpen
						? 'rotate-90'
						: ''}"
					aria-hidden="true"
				/>
			</button>
			<div
				id="card-context"
				class="border-t border-border p-4 xl:border-t-0 {contextOpen ? '' : 'max-xl:hidden'}"
			>
				<ContextPanels
					{source}
					{model}
					supersessions={data.supersessions}
					moduleData={data.moduleData}
					can={{
						edit: can('edit'),
						upload: can('upload_document'),
						generate: can('generate_document'),
						compose: data.composition !== null
					}}
				/>
			</div>
		</aside>

		<div
			class="min-w-0 rounded-xl border border-border bg-surface p-4 xl:col-start-1 xl:row-start-2"
		>
			<EventFeed
				events={model.events}
				canComment={can('comment')}
				{mentionable}
				typers={live?.typers ?? []}
			/>
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
<RecordDialogs
	interaction={data.interaction}
	users={data.users}
	contracts={data.contracts}
	shape={model.shape}
/>
{#if data.composition !== null}
	<CompositionDialog
		interaction={data.interaction}
		catalog={data.composition.catalog}
		operator={data.composition.operator}
		groups={model.modules.includes('learning') ? data.exchange.groups : []}
		shape={model.shape}
	/>
{/if}
{#if primaryParty !== null && can('edit')}
	<ContactDialog interaction={data.interaction} party={primaryParty} shape={model.shape} />
	<ProgramOfferDialog interaction={data.interaction} canCompose={data.composition !== null} />
{/if}
<DocumentDialogs interaction={data.interaction} supersessions={data.supersessions} />
{#if can('edit')}
	<PackageSendDialog
		interaction={data.interaction}
		templates={packageTemplates(
			offeredTemplates(data.card.templates, model.modules),
			data.card.counterpartyKind
		)}
		counterpartyKind={data.card.counterpartyKind}
		canGenerate={can('generate_document')}
	/>
{/if}
<LearningDialogs
	exchange={data.exchange}
	interaction={data.interaction}
	counterpartyKind={data.card.counterpartyKind}
/>
<!-- Диалоги действующих модулей: каждый узнаёт свою команду сам. -->
{#each cardDialogs(model.modules) as dialog (dialog.module)}
	<dialog.component
		{source}
		{model}
		data={data.moduleData?.[dialog.module]}
		workspaceKey={data.workspace.key}
	/>
{/each}
