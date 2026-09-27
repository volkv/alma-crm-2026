<script lang="ts">
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import { packageTemplates, type DocumentSupersession } from '$lib/contracts/documents';
	import { PARTY_ROLE_LABELS } from '$lib/contracts/interactions';
	import { cardPanelComponent } from '$lib/platform/card-ui-registry';
	import { offeredTemplates, panelOwner } from '$lib/platform/registry';
	import { getCardCommands } from './commands.svelte';
	import ContactLine from './contact-line.svelte';
	import ContextSection from './context-section.svelte';
	import PartyName from './party-name.svelte';
	import DocumentsPanel from './documents-panel.svelte';
	import InstitutionPanel from './institution-panel.svelte';
	import LearnerPanel from './learner-panel.svelte';
	import type { CardModel, CardSource } from './model';
	import TermsPanel from './terms-panel.svelte';

	/**
	 * Контекст карточки. Сторона и её условия стоят всегда, и их вид задаёт
	 * контрагент: вуз, физическое или юридическое лицо. Остальные панели
	 * объявляет процесс записи, и стоят они в порядке каталога: так рабочее
	 * место коммерческого обучения — своё, а не вузовская карточка с другими
	 * стадиями.
	 *
	 * Сроки и документы — панели ядра, остальные приносят модули
	 * (`$lib/platform/card-ui-registry`), и видны они, только пока модуль
	 * действует в пространстве. Что панель модуля показывает и когда
	 * прячется, решает сама панель. Так же и шаблоны: сублицензию и акт
	 * передачи панель документов предлагает, только пока действует их модуль.
	 */
	let {
		source,
		model,
		supersessions,
		can,
		moduleData = {}
	}: {
		source: CardSource;
		model: CardModel;
		supersessions: readonly DocumentSupersession[];
		/**
		 * Что человеку можно в этой записи; недоступные кнопки панели не рисуют.
		 * `compose` — на странице есть диалог состава (каталог для него прочитан).
		 */
		can: { edit: boolean; upload: boolean; generate: boolean; compose: boolean };
		/** Данные, которые модули загрузили для карточки сами, по ключу модуля. */
		moduleData?: Readonly<Record<string, unknown>>;
	} = $props();

	const commands = getCardCommands();
	const shape = $derived(model.shape);
	const has = (panel: CardModel['panels'][number]) => model.panels.includes(panel);

	/**
	 * Потоки и оплату сторона называет, только пока их модуль действует:
	 * выключенный модуль не оставляет следов и в панели лица.
	 */
	const groups = $derived(model.modules.includes('learning') ? source.exchange.groups : []);
	const paidStreamNumber = $derived(
		model.modules.includes('payment') ? (source.paymentFact?.streamNumber ?? null) : null
	);

	/**
	 * Стороны, которых панель контрагента не называет: у вуза это всё, кроме
	 * самого вуза и заказчика подготовки, у лица — всё, кроме него самого.
	 */
	const otherParties = $derived(
		source.interaction.parties.filter((party) =>
			shape === 'institution'
				? party.partyRole !== 'educational_institution' && party.partyRole !== 'customer'
				: !party.isPrimary
		)
	);

	const editPlan = $derived(can.edit ? () => commands.open({ kind: 'plan' }) : null);
	/**
	 * «Изменить состав» на нужном разделе — из того блока, о котором речь.
	 * Диалог стоит на странице, только когда правка разрешена, поэтому и
	 * кнопки — только тогда.
	 */
	const compose = $derived(
		can.edit && can.compose
			? (section: 'parties' | 'offering') => commands.openComposition(section)
			: null
	);
	/**
	 * Оператор — сама школа — сторона пакета документов: его отсутствие в деле
	 * стоит назвать, а не оставить догадкой до первого отказа пакета.
	 */
	const operatorMissing = $derived(
		!source.interaction.parties.some((party) => party.partyRole === 'operator')
	);
	/**
	 * Правка плана живёт у сроков; процесс без панели сроков ставит её к
	 * стороне — название записи правят в любом процессе.
	 */
	const partyEditPlan = $derived(has('terms') ? null : editPlan);

	const moduleDataOf = (panel: string) => {
		const owner = panelOwner(panel);

		return owner === null || owner === undefined ? undefined : moduleData[owner];
	};
</script>

<div class="flex min-w-0 flex-col gap-5" data-slot="context-panels">
	{#if shape === 'institution'}
		<InstitutionPanel
			interaction={source.interaction}
			organization={source.counterparty}
			onEditPlan={partyEditPlan}
			onCompose={compose}
		/>
	{:else}
		<LearnerPanel
			interaction={source.interaction}
			organization={source.counterparty}
			{shape}
			{groups}
			{paidStreamNumber}
			onEditPlan={partyEditPlan}
			onCompose={compose}
		/>
	{/if}

	{#if otherParties.length > 0 || compose !== null}
		<ContextSection title="Другие стороны">
			{#snippet action()}
				{#if compose !== null}
					<Button size="xs" variant="outline" onclick={() => compose('parties')}>
						{#if otherParties.length === 0}
							<PlusIcon aria-hidden="true" />
							Добавить
						{:else}
							Изменить
						{/if}
					</Button>
				{/if}
			{/snippet}
			<ul class="flex flex-col gap-2">
				{#each otherParties as party (party.id)}
					<li class="flex min-w-0 flex-col gap-0.5">
						<p class="text-xs text-muted-foreground">{PARTY_ROLE_LABELS[party.partyRole]}</p>
						<PartyName organizationId={party.organizationId} name={party.organizationName} />
						{#if party.contact !== null}
							<ContactLine {party} />
						{/if}
					</li>
				{/each}
			</ul>
			{#if operatorMissing}
				<p class="text-xs text-muted-foreground">
					Оператор (сама школа) не указан: без него не собрать пакет документов.
				</p>
			{/if}
		</ContextSection>
	{/if}

	{#each model.panels as panel (panel)}
		{#if panel === 'terms'}
			<TermsPanel interaction={source.interaction} {shape} onEditPlan={editPlan} />
		{:else if panel === 'documents'}
			<DocumentsPanel
				documents={source.interaction.documents}
				{supersessions}
				templates={packageTemplates(
					offeredTemplates(source.card.templates, model.modules),
					source.card.counterpartyKind
				)}
				counterpartyKind={source.card.counterpartyKind}
				canUpload={can.upload}
				canGenerate={can.generate}
			/>
		{:else}
			{@const Panel = cardPanelComponent(panel)}
			{#if Panel !== null}
				<Panel {source} {model} {can} {supersessions} data={moduleDataOf(panel)} />
			{/if}
		{/if}
	{/each}
</div>
