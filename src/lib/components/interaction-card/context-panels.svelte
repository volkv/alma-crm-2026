<script lang="ts">
	import ContractPanel from './contract-panel.svelte';
	import DocumentsPanel from './documents-panel.svelte';
	import InstitutionPanel from './institution-panel.svelte';
	import LearnerPanel from './learner-panel.svelte';
	import LearningPanel from './learning-panel.svelte';
	import type { CardSource, CounterpartyShape } from './model';

	/**
	 * Контекст карточки — набор панелей по виду контрагента. Вуз: учебное
	 * заведение, заказчик и сроки соглашения; лицо: слушатель или компания,
	 * программа, оплата. Общие для обоих — позиции договора, потоки в системе
	 * обучения и документы.
	 *
	 * Поток показывается там, где он уже есть или где его требует стадия: на
	 * поиске контактов пустая панель «Система обучения» только отвлекала бы.
	 */
	let {
		source,
		shape,
		id = 'card-context'
	}: {
		source: CardSource;
		shape: CounterpartyShape;
		id?: string;
	} = $props();

	const entries = $derived(
		source.status.current === null
			? source.status.history
			: [source.status.current, ...source.status.history]
	);
	const showLearning = $derived(
		source.exchange.groups.length > 0 || source.status.current?.snapshot.requiresLmsData === true
	);
</script>

<div class="flex min-w-0 flex-col gap-5" data-slot="context-panels">
	{#if shape === 'institution'}
		<InstitutionPanel interaction={source.interaction} organization={source.counterparty} />
	{:else}
		<LearnerPanel interaction={source.interaction} organization={source.counterparty} {entries} />
	{/if}

	{#if source.interaction.contract !== null}
		<ContractPanel contract={source.interaction.contract} />
	{/if}

	{#if showLearning}
		<LearningPanel
			groups={source.exchange.groups}
			issue={source.exchange.issue}
			id="{id}-learning"
		/>
	{/if}

	<DocumentsPanel documents={source.interaction.documents} />
</div>
