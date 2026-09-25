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
		paidStreamNumber,
		onEditPlan
	}: {
		interaction: InteractionView;
		organization: OrganizationView | null;
		shape: 'person' | 'company';
		/** Потоки записи: из последнего берётся поток слушателя. */
		groups: readonly LearningGroupView[];
		/**
		 * Поток из оплаты с сайта; `null` — оплату не загружали или данные
		 * человека уничтожены. Показывается, пока группы в системе обучения нет.
		 */
		paidStreamNumber: number | null;
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
	/**
	 * Поток словами — только известное: группа, заявленная без дат, остаётся
	 * «Поток 1», а не «Поток 1: … — …».
	 */
	function streamLine(group: LearningGroupView): string {
		const { startsOn, endsOn } = group;
		const dates =
			startsOn !== null && endsOn !== null
				? `${formatDate(startsOn)} — ${formatDate(endsOn)}`
				: startsOn !== null
					? `с ${formatDate(startsOn)}`
					: endsOn !== null
						? `до ${formatDate(endsOn)}`
						: null;

		return dates === null ? `Поток ${group.streamNumber}` : `Поток ${group.streamNumber}: ${dates}`;
	}
</script>

<div class="flex flex-col gap-5" data-slot="learner-panel">
	<!-- У компании первым — контактное лицо, реквизиты под ним: к человеку
		обращаются каждый день, к реквизитам — по случаю. -->
	{#if shape === 'company' && learner !== null}
		<ContextSection title="Контактное лицо">
			<ContactLine party={learner} />
		</ContextSection>
	{/if}

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
		{#if shape === 'person' && learner !== null}
			<ContactLine party={learner} />
		{/if}
	</ContextSection>

	<ContextSection title={shape === 'person' ? 'Программа и поток' : 'Программы и продукты'}>
		<OfferingList {interaction} />
		{#if shape === 'person'}
			<p class="text-xs text-muted-foreground tabular-nums">
				{#if stream === null && paidStreamNumber !== null}
					Поток {paidStreamNumber} — из оплаты с сайта, в систему обучения ещё не заявлен
				{:else if stream === null}
					Поток не заявлен
				{:else}
					{streamLine(stream)}
				{/if}
			</p>
		{/if}
	</ContextSection>
</div>
