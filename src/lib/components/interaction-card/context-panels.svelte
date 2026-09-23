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
	import LearningPanel from './learning-panel.svelte';
	import type { CardSource, CounterpartyShape } from './model';

	/**
	 * Контекст карточки — набор панелей по виду контрагента. Вуз: учебное
	 * заведение, заказчик и сроки соглашения; лицо: слушатель или компания,
	 * программа, оплата. Общие для обоих — договор с позициями, потоки в
	 * системе обучения и документы.
	 *
	 * Поток показывается там, где он уже есть или где его требует стадия: на
	 * поиске контактов пустая панель «Система обучения» только отвлекала бы.
	 */
	let {
		source,
		shape,
		supersessions,
		can
	}: {
		source: CardSource;
		shape: CounterpartyShape;
		supersessions: readonly DocumentSupersession[];
		/** Что человеку можно в этой записи; недоступные кнопки панели не рисуют. */
		can: { edit: boolean; upload: boolean; generate: boolean };
	} = $props();

	const commands = getCardCommands();
	const active = $derived(source.interaction.status === 'active');

	const entries = $derived(
		source.status.current === null
			? source.status.history
			: [source.status.current, ...source.status.history]
	);
	const showLearning = $derived(
		source.exchange.groups.length > 0 || source.status.current?.snapshot.requiresLmsData === true
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
</script>

<div class="flex min-w-0 flex-col gap-5" data-slot="context-panels">
	{#if shape === 'institution'}
		<InstitutionPanel
			interaction={source.interaction}
			organization={source.counterparty}
			onEditPlan={editPlan}
		/>
	{:else}
		<LearnerPanel
			interaction={source.interaction}
			organization={source.counterparty}
			{entries}
			onEditPlan={editPlan}
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

	<ContractPanel contract={source.interaction.contract} onEdit={editContract} />

	{#if showLearning}
		<LearningPanel
			groups={source.exchange.groups}
			issue={source.exchange.issue}
			canSend={source.exchange.canSend}
			canComplete={source.exchange.canComplete && active}
		/>
	{/if}

	<DocumentsPanel
		documents={source.interaction.documents}
		{supersessions}
		canUpload={can.upload}
		canGenerate={can.generate}
	/>
</div>
