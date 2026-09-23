<script lang="ts">
	import type { OrganizationView } from '$lib/contracts/directory';
	import type { InteractionView } from '$lib/contracts/interactions';
	import { formatDate } from '$lib/format';
	import ContactLine from './contact-line.svelte';
	import ContextSection from './context-section.svelte';

	/**
	 * Контекст работы с учебным заведением: вуз и его площадки, контактное
	 * лицо, заказчик подготовки, программы и сроки соглашения. Короткое имя
	 * вуза стоит в шапке карточки — здесь полное и реквизиты.
	 *
	 * Панель — отдельный компонент, потому что набор панелей зависит от вида
	 * контрагента: у обучения лица (`LearnerPanel`) стороны и сроки другие.
	 */
	let {
		interaction,
		organization
	}: {
		interaction: InteractionView;
		organization: OrganizationView | null;
	} = $props();

	const institution = $derived(
		interaction.parties.find((party) => party.partyRole === 'educational_institution') ?? null
	);
	const customer = $derived(
		interaction.parties.find((party) => party.partyRole === 'customer') ?? null
	);
	const period = (start: string | null, end: string | null) =>
		start === null && end === null
			? null
			: `${start === null ? '…' : formatDate(start)} — ${end === null ? '…' : formatDate(end)}`;
	const agreement = $derived(
		period(interaction.agreementPeriodStart, interaction.agreementPeriodEnd)
	);
	const academic = $derived(period(interaction.academicPeriodStart, interaction.academicPeriodEnd));
</script>

<div class="flex flex-col gap-5" data-slot="institution-panel">
	<ContextSection title="Учебное заведение">
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
		<ul class="flex flex-col gap-1 text-sm">
			{#each interaction.programs as program (program.programId)}
				<li class="break-words">
					<span class="text-muted-foreground tabular-nums">{program.code}</span>
					{program.name}
				</li>
			{/each}
		</ul>
		{#if interaction.products.length > 0}
			<p class="text-xs text-muted-foreground">
				Продукты: {interaction.products.map((product) => product.name).join(', ')}
			</p>
		{/if}
	</ContextSection>

	{#if agreement !== null || academic !== null}
		<ContextSection title="Сроки">
			<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
				{#if agreement !== null}
					<dt class="text-muted-foreground">Соглашение</dt>
					<dd class="tabular-nums">{agreement}</dd>
				{/if}
				{#if academic !== null}
					<dt class="text-muted-foreground">Учебный год</dt>
					<dd class="tabular-nums">{academic}</dd>
				{/if}
			</dl>
		</ContextSection>
	{/if}
</div>
