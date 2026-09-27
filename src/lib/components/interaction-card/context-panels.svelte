<script lang="ts">
	import { packageTemplates, type DocumentSupersession } from '$lib/contracts/documents';
	import { PARTY_ROLE_LABELS } from '$lib/contracts/interactions';
	import { cardPanelComponent } from '$lib/platform/card-ui-registry';
	import { panelOwner } from '$lib/platform/registry';
	import { getCardCommands } from './commands.svelte';
	import ContactLine from './contact-line.svelte';
	import ContextSection from './context-section.svelte';
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
	 * прячется, решает сама панель.
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
		/** Что человеку можно в этой записи; недоступные кнопки панели не рисуют. */
		can: { edit: boolean; upload: boolean; generate: boolean };
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
		/>
	{:else}
		<LearnerPanel
			interaction={source.interaction}
			organization={source.counterparty}
			{shape}
			{groups}
			{paidStreamNumber}
			onEditPlan={partyEditPlan}
		/>
	{/if}

	{#if otherParties.length > 0}
		<ContextSection title="Другие стороны">
			<ul class="flex flex-col gap-2">
				{#each otherParties as party (party.id)}
					<li class="flex flex-col gap-0.5">
						<p class="text-xs text-muted-foreground">{PARTY_ROLE_LABELS[party.partyRole]}</p>
						<p class="text-sm break-words">{party.organizationName}</p>
						{#if party.contact !== null}
							<ContactLine {party} />
						{/if}
					</li>
				{/each}
			</ul>
		</ContextSection>
	{/if}

	{#each model.panels as panel (panel)}
		{#if panel === 'terms'}
			<TermsPanel interaction={source.interaction} {shape} onEditPlan={editPlan} />
		{:else if panel === 'documents'}
			<DocumentsPanel
				documents={source.interaction.documents}
				{supersessions}
				templates={packageTemplates(source.card.templates, source.card.counterpartyKind)}
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
