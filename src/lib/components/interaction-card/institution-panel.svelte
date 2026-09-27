<script lang="ts">
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import UserPenIcon from '@lucide/svelte/icons/user-pen';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { OrganizationView } from '$lib/contracts/directory';
	import type { InteractionSummaryView, InteractionView } from '$lib/contracts/interactions';
	import { getCardCommands, type CompositionSection } from './commands.svelte';
	import ContactLine from './contact-line.svelte';
	import ContextSection from './context-section.svelte';
	import OfferingList from './offering-list.svelte';
	import PartyName from './party-name.svelte';
	import Requisites from './requisites.svelte';

	/**
	 * Сторона и условия работы с учебным заведением: контактное лицо, вуз и его
	 * площадки, заказчик подготовки, программы и продукты. Первым — человек, с
	 * которым говорят: к нему обращаются каждый день, а к реквизитам — по
	 * случаю.
	 *
	 * Вуз назван коротко и ссылкой на свою карточку — там договоры, контакты и
	 * площадки; регион и ИНН рядом, полное юрнаименование и остальные
	 * реквизиты — по раскрытию. Две разные правки названы раздельно: «Сменить
	 * сторону» меняет связь дела (состав), «Изменить реквизиты» ведёт в
	 * справочник, где правят саму организацию.
	 */
	let {
		interaction,
		organization,
		onEditPlan,
		onCompose
	}: {
		interaction: InteractionView;
		organization: OrganizationView | null;
		/**
		 * Правка названия и сроков — здесь, только если в процессе нет панели
		 * сроков, где ей место; `null` — не здесь или права на правку нет.
		 */
		onEditPlan: (() => void) | null;
		/** Открыть «Изменить состав» на разделе; `null` — права на правку нет. */
		onCompose: ((section: CompositionSection) => void) | null;
	} = $props();

	const institution = $derived(
		interaction.parties.find((party) => party.partyRole === 'educational_institution') ?? null
	);
	const customer = $derived(
		interaction.parties.find((party) => party.partyRole === 'customer') ?? null
	);

	/**
	 * Сменить контакт можно тому, у кого есть действие «изменить»: сводка
	 * карточки уже лежит в данных страницы, второй раз её не спрашивают.
	 * Кнопка — подсказка, а не защита: право проверяет сервер.
	 */
	const canEdit = $derived(
		(page.data.summary as InteractionSummaryView | undefined)?.canDo.actions.includes('edit') ??
			false
	);
	const commands = getCardCommands();
</script>

<div class="flex flex-col gap-5" data-slot="institution-panel">
	{#if institution !== null}
		<ContextSection title="Контактное лицо">
			{#snippet action()}
				{#if canEdit}
					<Button size="xs" variant="outline" onclick={() => commands.open({ kind: 'contact' })}>
						<UserPenIcon aria-hidden="true" />
						{institution.contact === null ? 'Указать' : 'Изменить'}
					</Button>
				{/if}
			{/snippet}
			<ContactLine party={institution} />
		</ContextSection>
	{/if}

	<ContextSection title="Учебное заведение">
		{#snippet action()}
			<div class="flex flex-wrap gap-1.5">
				{#if onCompose !== null}
					<Button size="xs" variant="outline" onclick={() => onCompose('parties')}>
						Сменить сторону
					</Button>
				{/if}
				{#if onEditPlan !== null}
					<Button size="xs" variant="outline" onclick={onEditPlan}>
						<PencilIcon aria-hidden="true" />
						Изменить план
					</Button>
				{/if}
			</div>
		{/snippet}
		{#if institution !== null}
			<div class="flex min-w-0 flex-col gap-1 text-sm">
				<PartyName
					organizationId={institution.organizationId}
					name={institution.organizationName}
				/>
				{#if organization !== null}
					<Requisites {organization} />
				{/if}
				<!-- Подразделение — одна из площадок стороны: его выбирают в
					составе дела, и оно закрывает пункт «Найдено профильное
					подразделение». -->
				<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
					<p class="text-xs text-muted-foreground">
						{institution.sites.length > 0
							? `Площадки: ${institution.sites.map((site) => site.name).join(', ')}`
							: 'Подразделение и площадки не выбраны'}
					</p>
					{#if onCompose !== null}
						<Button size="xs" variant="outline" onclick={() => onCompose('parties')}>
							Выбрать площадки
						</Button>
					{/if}
				</div>
			</div>
		{/if}
	</ContextSection>

	<ContextSection title="Заказчик подготовки">
		{#snippet action()}
			{#if onCompose !== null}
				<Button size="xs" variant="outline" onclick={() => onCompose('parties')}>
					{#if customer === null}
						<PlusIcon aria-hidden="true" />
						Добавить
					{:else}
						Изменить
					{/if}
				</Button>
			{/if}
		{/snippet}
		{#if customer === null}
			<p class="text-sm text-faint">Не указан</p>
		{:else}
			<PartyName organizationId={customer.organizationId} name={customer.organizationName} />
		{/if}
	</ContextSection>

	<ContextSection title="Программы и продукты">
		{#snippet action()}
			{#if onCompose !== null}
				<Button size="xs" variant="outline" onclick={() => onCompose('offering')}>
					{#if interaction.programs.length === 0 && interaction.products.length === 0}
						<PlusIcon aria-hidden="true" />
						Добавить
					{:else}
						Изменить
					{/if}
				</Button>
			{/if}
		{/snippet}
		<OfferingList {interaction} />
	</ContextSection>
</div>
