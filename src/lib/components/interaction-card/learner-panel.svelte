<script lang="ts">
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { OrganizationView } from '$lib/contracts/directory';
	import type { LearningGroupView } from '$lib/contracts/exchange';
	import type { InteractionView } from '$lib/contracts/interactions';
	import { formatDate } from '$lib/format';
	import ContactLine from './contact-line.svelte';
	import ContextSection from './context-section.svelte';
	import OfferingList from './offering-list.svelte';

	/**
	 * Сторона и условия обучения лица. Физическое лицо учится само: у него
	 * программа и поток, в котором оно учится. Юридическое лицо отправляет на
	 * обучение своих людей: у него реквизиты, контакт и программы. Имя
	 * контрагента стоит в шапке карточки — здесь реквизиты и контакт.
	 *
	 * Оплата, слушатели и сроки — панели процесса, их набор объявляет он.
	 */
	let {
		interaction,
		organization,
		shape,
		groups,
		onEditPlan
	}: {
		interaction: InteractionView;
		organization: OrganizationView | null;
		shape: 'person' | 'company';
		/** Потоки записи: из последнего берётся поток слушателя. */
		groups: readonly LearningGroupView[];
		/**
		 * Правка названия и сроков — здесь, только если в процессе нет панели
		 * сроков, где ей место; `null` — не здесь или права на правку нет.
		 */
		onEditPlan: (() => void) | null;
	} = $props();

	const learner = $derived(interaction.parties.find((party) => party.isPrimary) ?? null);
	const stream = $derived(
		groups.reduce<LearningGroupView | null>(
			(latest, group) =>
				latest === null || group.streamNumber > latest.streamNumber ? group : latest,
			null
		)
	);
	const day = (value: string | null) => (value === null ? '…' : formatDate(value));
</script>

<div class="flex flex-col gap-5" data-slot="learner-panel">
	<ContextSection title={shape === 'person' ? 'Слушатель' : 'Компания'}>
		{#snippet action()}
			{#if onEditPlan !== null}
				<Button size="xs" variant="outline" onclick={onEditPlan}>
					<PencilIcon aria-hidden="true" />
					Изменить план
				</Button>
			{/if}
		{/snippet}
		{#if organization !== null && shape === 'company'}
			<div class="flex flex-col gap-0.5 text-sm">
				<p class="break-words">{organization.legalName}</p>
				<p class="text-xs text-muted-foreground">
					{[organization.region, organization.inn ? `ИНН ${organization.inn}` : null]
						.filter((part) => part !== null)
						.join(' · ')}
				</p>
			</div>
		{/if}
		{#if learner !== null}
			<ContactLine party={learner} />
		{/if}
	</ContextSection>

	<ContextSection title={shape === 'person' ? 'Программа и поток' : 'Программы и продукты'}>
		<OfferingList {interaction} />
		{#if shape === 'person'}
			<p class="text-xs text-muted-foreground tabular-nums">
				{#if stream === null}
					Поток не заявлен
				{:else}
					Поток {stream.streamNumber}: {day(stream.startsOn)} — {day(stream.endsOn)}
				{/if}
			</p>
		{/if}
	</ContextSection>
</div>
