<script lang="ts">
	import type { DocumentSupersession } from '$lib/contracts/documents';
	import { PARTY_ROLE_LABELS } from '$lib/contracts/interactions';
	import { getCardCommands } from './commands.svelte';
	import ContactLine from './contact-line.svelte';
	import ContextSection from './context-section.svelte';
	import ContractPanel from './contract-panel.svelte';
	import DocumentsPanel from './documents-panel.svelte';
	import InstitutionPanel from './institution-panel.svelte';
	import LearnerPanel from './learner-panel.svelte';
	import LearnersPanel from './learners-panel.svelte';
	import LearningPanel from './learning-panel.svelte';
	import type { CardModel, CardSource } from './model';
	import PaymentPanel from './payment-panel.svelte';
	import TermsPanel from './terms-panel.svelte';
	import TrainingDocumentPanel from './training-document-panel.svelte';

	/**
	 * Контекст карточки. Сторона и её условия стоят всегда, и их вид задаёт
	 * контрагент: вуз, физическое или юридическое лицо. Остальные панели
	 * объявляет процесс записи (`CARD_PANELS`), и стоят они в порядке каталога:
	 * так рабочее место коммерческого обучения — своё, а не вузовская карточка
	 * с другими стадиями.
	 *
	 * Поток показывается там, где он уже есть или где его требует стадия: на
	 * поиске контактов пустая панель «Система обучения» только отвлекала бы.
	 */
	let {
		source,
		model,
		supersessions,
		can
	}: {
		source: CardSource;
		model: CardModel;
		supersessions: readonly DocumentSupersession[];
		/** Что человеку можно в этой записи; недоступные кнопки панели не рисуют. */
		can: { edit: boolean; upload: boolean; generate: boolean };
	} = $props();

	const commands = getCardCommands();
	const active = $derived(source.interaction.status === 'active');
	const shape = $derived(model.shape);
	const has = (panel: CardModel['panels'][number]) => model.panels.includes(panel);

	const showLearning = $derived(
		has('learning') &&
			(source.exchange.groups.length > 0 ||
				source.status.current?.snapshot.requiresLmsData === true)
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
	const editContract = $derived(can.edit ? () => commands.open({ kind: 'contract' }) : null);
	/**
	 * Правка плана живёт у сроков; процесс без панели сроков ставит её к
	 * стороне — название записи правят в любом процессе.
	 */
	const partyEditPlan = $derived(has('terms') ? null : editPlan);
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
			groups={source.exchange.groups}
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

	{#if has('terms')}
		<TermsPanel interaction={source.interaction} {shape} onEditPlan={editPlan} />
	{/if}

	{#if has('contract')}
		<ContractPanel contract={source.interaction.contract} onEdit={editContract} />
	{/if}

	{#if has('payment')}
		<PaymentPanel payment={model.payment} />
	{/if}

	{#if has('learners')}
		<LearnersPanel groups={source.exchange.groups} />
	{/if}

	{#if showLearning}
		<LearningPanel
			groups={source.exchange.groups}
			issue={source.exchange.issue}
			canSend={source.exchange.canSend}
			canComplete={source.exchange.canComplete && active}
		/>
	{/if}

	{#if has('training_document')}
		<TrainingDocumentPanel documents={source.interaction.documents} canUpload={can.upload} />
	{/if}

	{#if has('documents')}
		<DocumentsPanel
			documents={source.interaction.documents}
			{supersessions}
			templates={source.card.templates}
			canUpload={can.upload}
			canGenerate={can.generate}
		/>
	{/if}
</div>
