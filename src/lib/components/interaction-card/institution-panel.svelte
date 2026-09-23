<script lang="ts">
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { OrganizationView } from '$lib/contracts/directory';
	import type { InteractionView } from '$lib/contracts/interactions';
	import ContactLine from './contact-line.svelte';
	import ContextSection from './context-section.svelte';
	import OfferingList from './offering-list.svelte';

	/**
	 * Сторона и условия работы с учебным заведением: вуз и его площадки,
	 * контактное лицо, заказчик подготовки, программы и продукты. Короткое имя
	 * вуза стоит в шапке карточки — здесь полное и реквизиты. Договор с
	 * позициями и лицензиями и сроки — панели процесса, их набор объявляет он.
	 */
	let {
		interaction,
		organization,
		onEditPlan
	}: {
		interaction: InteractionView;
		organization: OrganizationView | null;
		/**
		 * Правка названия и сроков — здесь, только если в процессе нет панели
		 * сроков, где ей место; `null` — не здесь или права на правку нет.
		 */
		onEditPlan: (() => void) | null;
	} = $props();

	const institution = $derived(
		interaction.parties.find((party) => party.partyRole === 'educational_institution') ?? null
	);
	const customer = $derived(
		interaction.parties.find((party) => party.partyRole === 'customer') ?? null
	);
</script>

<div class="flex flex-col gap-5" data-slot="institution-panel">
	<ContextSection title="Учебное заведение">
		{#snippet action()}
			{#if onEditPlan !== null}
				<Button size="xs" variant="outline" onclick={onEditPlan}>
					<PencilIcon aria-hidden="true" />
					Изменить план
				</Button>
			{/if}
		{/snippet}
		<div class="flex flex-col gap-0.5 text-sm">
			{#if organization !== null}
				<p class="break-words">{organization.legalName}</p>
				<p class="text-xs text-muted-foreground">
					{[organization.region, organization.inn ? `ИНН ${organization.inn}` : null]
						.filter((part) => part !== null)
						.join(' · ')}
				</p>
			{/if}
			{#if institution !== null && institution.sites.length > 0}
				<p class="text-xs text-muted-foreground">
					Площадки: {institution.sites.map((site) => site.name).join(', ')}
				</p>
			{/if}
		</div>
		{#if institution !== null}
			<ContactLine party={institution} />
		{/if}
	</ContextSection>

	{#if customer !== null}
		<ContextSection title="Заказчик подготовки">
			<p class="text-sm">{customer.organizationName}</p>
		</ContextSection>
	{/if}

	<ContextSection title="Программы и продукты">
		<OfferingList {interaction} />
	</ContextSection>
</div>
