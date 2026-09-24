<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { goto } from '$app/navigation';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import FieldDate from '$lib/components/form/field-date.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import FormField from '$lib/components/form/form-field.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import OrganizationPicker from '$lib/components/interactions/organization-picker.svelte';
	import { NO_OPTION, toLookupOptions, withEmptyOption } from '$lib/components/directory/labels';
	import type { ContractView, LookupOption } from '$lib/contracts/directory';
	import {
		CONTRACT_STATUS_LABELS,
		createInteractionSchema,
		PARTY_ROLE_LABELS
	} from '$lib/contracts/interactions';
	import { formatDate } from '$lib/format';
	import { listPath } from '../filters';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Адреса раздела: ключ пространства стоит в пути, и его знает страница. */
	const listHref = $derived(listPath(data.workspace.key));
	const lookupPath = $derived(`${listHref}/lookup`);

	const {
		form,
		errors,
		enhance,
		submitting,
		message: formMessage
		// superforms берёт начальную форму один раз и дальше следит за обновлениями
		// страницы сам, поэтому чтение намеренно не является зависимостью.
	} = superForm(
		untrack(() => data.form),
		{
			validators: zod4Client(createInteractionSchema),
			// Стороны и программы — вложенные списки: форма едет одним JSON.
			dataType: 'json',
			// Шапка приложения липкая, и без её высоты superforms считает
			// спрятанную под ней ошибку «уже на экране» и никуда не ведёт.
			stickyNavbar: 'header',
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	// Вуз из ссылки с карточки организации: подставлен сразу, со своими
	// площадками, контактами и договорами, и меняется как выбранный вручную.
	let institution = $state<LookupOption | null>(untrack(() => data.presetInstitution));
	let customer = $state<LookupOption | null>(null);
	let institutionSites = $state<LookupOption[]>([]);
	let institutionContacts = $state<LookupOption[]>([]);
	let selectedSiteIds = $state<string[]>([]);
	let contactAffiliationId = $state<string | null>(null);
	let selectedProgramIds = $state<string[]>([]);
	// Договоры выбранного вуза и выбор по ним: договор один, позиций из него —
	// сколько угодно.
	let contracts = $state<ContractView[]>([]);
	let contractId = $state<string | null>(null);
	let selectedItemIds = $state<string[]>([]);
	// Даты в форме — строки: пустое поле это «не указано», и в контракт оно едет
	// как `null`, а не как пустая строка.
	let periods = $state({
		agreementPeriodStart: '',
		agreementPeriodEnd: '',
		academicPeriodStart: '',
		academicPeriodEnd: ''
	});

	async function loadLookup<TItem>(
		kind: 'sites' | 'contacts' | 'contracts',
		organizationId: string
	): Promise<TItem[]> {
		const response = await fetch(
			`${lookupPath}?kind=${kind}&organizationId=${encodeURIComponent(organizationId)}`
		);

		if (!response.ok) {
			return [];
		}

		const body: { items?: TItem[] } = await response.json();

		return body.items ?? [];
	}

	async function onInstitution(option: LookupOption | null) {
		selectedSiteIds = [];
		contactAffiliationId = null;
		// Договор принадлежит контрагенту: сменили вуз — прежний выбор говорит о
		// чужом обязательстве, и сервер его всё равно отвергнет.
		contractId = null;
		selectedItemIds = [];

		if (option === null) {
			institutionSites = [];
			institutionContacts = [];
			contracts = [];
			return;
		}

		[institutionSites, institutionContacts, contracts] = await Promise.all([
			loadLookup<LookupOption>('sites', option.id),
			loadLookup<LookupOption>('contacts', option.id),
			loadLookup<ContractView>('contracts', option.id)
		]);
	}

	// Площадки, контакты и договоры подставленного вуза подтягиваются в браузере
	// теми же подсказками, что и после ручного выбора.
	onMount(() => {
		if (institution !== null) {
			void onInstitution(institution);
		}
	});

	const contractOptions = $derived(
		withEmptyOption(
			contracts.map((contract) => ({
				value: contract.id,
				label: `№ ${contract.number} — ${CONTRACT_STATUS_LABELS[contract.status]}`
			})),
			'Без договора'
		)
	);

	const chosenContract = $derived(contracts.find((contract) => contract.id === contractId) ?? null);

	/**
	 * Позиции, выбранные по продуктам, которых нет в составе. Позиция добавляет
	 * к продукту коммерческие условия, а состав задают продукты: сервер такую
	 * пару отвергнет, и сказать об этом надо до отправки.
	 */
	const itemsOutsideProducts = $derived(
		(chosenContract?.items ?? []).filter(
			(item) => selectedItemIds.includes(item.id) && !$form.productIds.includes(item.productId)
		)
	);

	// Стороны взаимодействия собираются из выбранных организаций: контракт ждёт
	// список участников с ролями, а форма показывает две понятные строки.
	$effect(() => {
		const parties = [];

		if (institution !== null) {
			parties.push({
				organizationId: institution.id,
				partyRole: 'educational_institution' as const,
				isPrimary: true,
				contactAffiliationId,
				siteIds: selectedSiteIds
			});
		}

		if (customer !== null) {
			parties.push({
				organizationId: customer.id,
				partyRole: 'customer' as const,
				isPrimary: false,
				contactAffiliationId: null,
				siteIds: []
			});
		}

		$form.parties = parties;
	});

	$effect(() => {
		$form.programs = selectedProgramIds.map((programId) => ({
			programId,
			programVersionId: null
		}));
	});

	$effect(() => {
		$form.contractId = contractId;
		$form.contractItemIds = contractId === null ? [] : selectedItemIds;
	});

	$effect(() => {
		$form.agreementPeriodStart = periods.agreementPeriodStart || null;
		$form.agreementPeriodEnd = periods.agreementPeriodEnd || null;
		$form.academicPeriodStart = periods.academicPeriodStart || null;
		$form.academicPeriodEnd = periods.academicPeriodEnd || null;
	});

	function toggle(list: string[], id: string, checked: boolean): string[] {
		return checked ? [...new Set([...list, id])] : list.filter((item) => item !== id);
	}

	// Претензии к сторонам показываются по одной на строку: склеенные в одну
	// фразу, они читаются как сломанное предложение.
	const partyErrors = $derived($errors.parties?._errors ?? []);
</script>

<svelte:head>
	<title>Новое взаимодействие — LCT CRM</title>
</svelte:head>

<Header
	title="Новое взаимодействие"
	description="Кто участвует, какие программы и продукты, кто отвечает и в какие сроки."
/>

<Breadcrumbs
	items={[{ label: data.workspace.name, href: listHref }, { label: 'Новое взаимодействие' }]}
/>

<div class="p-4 sm:px-9 sm:py-6">
	<form
		method="POST"
		use:enhance
		novalidate
		data-tour="interaction-new-form"
		class="flex max-w-3xl flex-col gap-4"
	>
		{#if data.presetRefused !== null}
			<Alert.Root>
				<Alert.Title>{data.presetRefused}</Alert.Title>
				<Alert.Description>Выберите учебное заведение в форме.</Alert.Description>
			</Alert.Root>
		{/if}

		{#if $formMessage}
			<Alert.Root variant="destructive">
				<Alert.Title>{$formMessage}</Alert.Title>
			</Alert.Root>
		{/if}

		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Стороны</Card.Title>
				<Card.Description>
					Учебное заведение обязательно: с ним ведётся процесс. Компания-заказчик — если подготовку
					заказывает она.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<FormField
					name="institution"
					label={PARTY_ROLE_LABELS.educational_institution}
					required
					errors={partyErrors.length === 0 ? undefined : partyErrors}
				>
					{#snippet control({ id, describedBy, invalid })}
						<OrganizationPicker
							{id}
							{describedBy}
							{invalid}
							{lookupPath}
							value={institution?.id ?? null}
							label={institution?.label ?? null}
							onselect={(option) => {
								institution = option;
								void onInstitution(option);
							}}
						/>
					{/snippet}
				</FormField>

				{#if institutionSites.length > 0}
					<fieldset class="flex flex-col gap-2">
						<legend class="text-sm font-medium">Площадки</legend>
						{#each institutionSites as site (site.id)}
							<Label class="flex items-center gap-2 font-normal">
								<Checkbox
									checked={selectedSiteIds.includes(site.id)}
									onCheckedChange={(checked) =>
										(selectedSiteIds = toggle(selectedSiteIds, site.id, checked === true))}
								/>
								{site.label}
							</Label>
						{/each}
					</fieldset>
				{/if}

				{#if institutionContacts.length > 0}
					<FieldSelect
						name="contactAffiliationId"
						label="Контактное лицо вуза"
						options={toLookupOptions(institutionContacts, 'Не выбрано')}
						bind:value={
							() => contactAffiliationId ?? NO_OPTION,
							(next) => (contactAffiliationId = next === NO_OPTION ? null : next)
						}
					/>
				{/if}

				<FormField name="customer" label={PARTY_ROLE_LABELS.customer}>
					{#snippet control({ id, describedBy, invalid })}
						<OrganizationPicker
							{id}
							{describedBy}
							{invalid}
							{lookupPath}
							placeholder="Компания, для которой готовят специалистов"
							value={customer?.id ?? null}
							label={customer?.label ?? null}
							onselect={(option) => (customer = option)}
						/>
					{/snippet}
				</FormField>
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Взаимодействие</Card.Title>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<FieldInput
					name="title"
					label="Название"
					required
					placeholder="Например: подготовка специалистов по защите информации"
					bind:value={$form.title}
					errors={$errors.title}
				/>

				<!-- Пространство не выбирают в форме: запись заводят внутри него, и
					его имя стоит в заголовке. Подсказка называет место словами —
					иначе «куда именно она встанет» остаётся догадкой. -->
				<InlineHint tone="info">
					Запись встанет в пространство «{data.workspace.name}» на первую стадию действующей
					редакции его процесса.
				</InlineHint>

				<FieldSelect
					name="ownerUserId"
					label="Ответственный"
					required
					options={data.users.map((user) => ({
						value: user.id,
						label: `${user.name} — ${user.roleName}`
					}))}
					bind:value={$form.ownerUserId}
					errors={$errors.ownerUserId}
				/>

				<div class="grid gap-4 sm:grid-cols-2">
					<FieldDate
						name="agreementPeriodStart"
						label="Соглашение: с"
						max={periods.agreementPeriodEnd}
						bind:value={periods.agreementPeriodStart}
						errors={$errors.agreementPeriodStart}
					/>
					<FieldDate
						name="agreementPeriodEnd"
						label="Соглашение: по"
						min={periods.agreementPeriodStart}
						bind:value={periods.agreementPeriodEnd}
						errors={$errors.agreementPeriodEnd}
					/>
					<FieldDate
						name="academicPeriodStart"
						label="Учебный период: с"
						max={periods.academicPeriodEnd}
						bind:value={periods.academicPeriodStart}
						errors={$errors.academicPeriodStart}
					/>
					<FieldDate
						name="academicPeriodEnd"
						label="Учебный период: по"
						min={periods.academicPeriodStart}
						bind:value={periods.academicPeriodEnd}
						errors={$errors.academicPeriodEnd}
					/>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Программы и продукты</Card.Title>
				<Card.Description>Что именно передаётся учебному заведению.</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4 sm:grid-cols-2">
				<fieldset class="flex flex-col gap-2">
					<legend class="text-sm font-medium">Образовательные программы</legend>
					{#if data.programs.length === 0}
						<p class="text-xs text-muted-foreground">Справочник программ пока пуст.</p>
					{/if}
					{#each data.programs as program (program.id)}
						<Label class="flex items-start gap-2 font-normal">
							<Checkbox
								checked={selectedProgramIds.includes(program.id)}
								onCheckedChange={(checked) =>
									(selectedProgramIds = toggle(selectedProgramIds, program.id, checked === true))}
							/>
							<span>{program.code} — {program.name}</span>
						</Label>
					{/each}
				</fieldset>

				<fieldset class="flex flex-col gap-2">
					<legend class="text-sm font-medium">Продукты</legend>
					{#if data.products.length === 0}
						<p class="text-xs text-muted-foreground">Справочник продуктов пока пуст.</p>
					{/if}
					{#each data.products as product (product.id)}
						<Label class="flex items-start gap-2 font-normal">
							<Checkbox
								checked={$form.productIds.includes(product.id)}
								onCheckedChange={(checked) =>
									($form.productIds = toggle($form.productIds, product.id, checked === true))}
							/>
							<span>{product.code} — {product.name}</span>
						</Label>
					{/each}
				</fieldset>
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Договор</Card.Title>
				<Card.Description>
					По какому обязательству идёт работа и какие его позиции в ней участвуют. Договоры ведут в
					карточке контрагента: здесь их только выбирают.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				{#if institution === null}
					<p class="text-xs text-muted-foreground">
						Сначала выберите учебное заведение: договор принадлежит ему.
					</p>
				{:else if contracts.length === 0}
					<p class="text-xs text-muted-foreground">
						У выбранного контрагента договоров пока нет: их заводят на его карточке.
					</p>
				{:else}
					<FieldSelect
						name="contractId"
						label="Договор контрагента"
						options={contractOptions}
						errors={$errors.contractId}
						bind:value={
							() => contractId ?? NO_OPTION,
							(next) => {
								contractId = next === NO_OPTION ? null : next;
								selectedItemIds = [];
							}
						}
					/>

					{#if chosenContract !== null}
						<fieldset class="flex flex-col gap-2">
							<legend class="text-sm font-medium">Позиции договора</legend>
							{#if chosenContract.items.length === 0}
								<p class="text-xs text-muted-foreground">
									В договоре нет позиций: коммерческие условия по продуктам не записаны.
								</p>
							{/if}
							{#each chosenContract.items as item (item.id)}
								<Label class="flex items-start gap-2 font-normal">
									<Checkbox
										checked={selectedItemIds.includes(item.id)}
										onCheckedChange={(checked) =>
											(selectedItemIds = toggle(selectedItemIds, item.id, checked === true))}
									/>
									<span class="flex flex-col gap-0.5">
										<span>{item.productCode} — {item.productName}</span>
										<span class="text-xs text-muted-foreground">
											Статус по передаче: {item.transferStatus}{item.licenseUntil === null
												? ''
												: ` · лицензия до ${formatDate(item.licenseUntil)}`}
										</span>
									</span>
								</Label>
							{/each}
						</fieldset>

						{#if itemsOutsideProducts.length > 0}
							<InlineHint tone="warning">
								Позиция описывает продукт, которого нет в составе: отметьте {itemsOutsideProducts
									.map((item) => `«${item.productName}»`)
									.join(', ')} среди продуктов или снимите позицию.
							</InlineHint>
						{/if}
					{/if}
				{/if}
			</Card.Content>
		</Card.Root>

		<FormActions
			submitting={$submitting}
			submitLabel="Создать взаимодействие"
			oncancel={() => goto(listHref)}
		/>
	</form>
</div>
