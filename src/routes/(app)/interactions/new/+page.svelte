<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { resolve } from '$app/paths';
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
	import PageHeader from '$lib/components/page-header.svelte';
	import OrganizationPicker from '$lib/components/interactions/organization-picker.svelte';
	import { NO_OPTION, toLookupOptions } from '$lib/components/directory/labels';
	import type { LookupOption } from '$lib/contracts/directory';
	import { createInteractionSchema, PARTY_ROLE_LABELS } from '$lib/contracts/interactions';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

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
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	/**
	 * Что скажет подсказка о процессе. Группу выбирает не человек, а вид
	 * организации, отмеченной основной стороной, — поэтому здесь перечислены
	 * группы и то, описан ли в них процесс: узнать об этом после сохранения
	 * означало бы отказ там, где заполнена вся форма.
	 */
	const emptyProcess = $derived(data.groups.some((group) => group.stageCount === 0));
	const processHint = $derived(
		data.groups
			.map(
				(group) =>
					`${group.name} — ${group.stageCount === 0 ? 'процесс ещё не описан' : `${group.stageCount} стадий`}`
			)
			.join('; ')
	);

	let institution = $state<LookupOption | null>(null);
	let customer = $state<LookupOption | null>(null);
	let institutionSites = $state<LookupOption[]>([]);
	let institutionContacts = $state<LookupOption[]>([]);
	let selectedSiteIds = $state<string[]>([]);
	let contactAffiliationId = $state<string | null>(null);
	let selectedProgramIds = $state<string[]>([]);
	// Даты в форме — строки: пустое поле это «не указано», и в контракт оно едет
	// как `null`, а не как пустая строка.
	let periods = $state({
		agreementPeriodStart: '',
		agreementPeriodEnd: '',
		academicPeriodStart: '',
		academicPeriodEnd: ''
	});

	async function loadLookup(kind: 'sites' | 'contacts', organizationId: string) {
		const response = await fetch(
			`/interactions/lookup?kind=${kind}&organizationId=${encodeURIComponent(organizationId)}`
		);

		if (!response.ok) {
			return [];
		}

		const body: { items?: LookupOption[] } = await response.json();

		return body.items ?? [];
	}

	async function onInstitution(option: LookupOption | null) {
		selectedSiteIds = [];
		contactAffiliationId = null;

		if (option === null) {
			institutionSites = [];
			institutionContacts = [];
			return;
		}

		[institutionSites, institutionContacts] = await Promise.all([
			loadLookup('sites', option.id),
			loadLookup('contacts', option.id)
		]);
	}

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
		$form.agreementPeriodStart = periods.agreementPeriodStart || null;
		$form.agreementPeriodEnd = periods.agreementPeriodEnd || null;
		$form.academicPeriodStart = periods.academicPeriodStart || null;
		$form.academicPeriodEnd = periods.academicPeriodEnd || null;
	});

	function toggle(list: string[], id: string, checked: boolean): string[] {
		return checked ? [...new Set([...list, id])] : list.filter((item) => item !== id);
	}

	const partyError = $derived($errors.parties?._errors?.join(' ') ?? '');
</script>

<svelte:head>
	<title>Новое взаимодействие — LCT CRM</title>
</svelte:head>

<PageHeader
	title="Новое взаимодействие"
	description="Кто участвует, какие программы и продукты, кто отвечает и в какие сроки."
	breadcrumbs={[{ label: 'Взаимодействия', href: resolve('/interactions') }]}
/>

<div class="p-4 sm:p-6">
	<form method="POST" use:enhance novalidate class="flex max-w-3xl flex-col gap-4">
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
					errors={partyError === '' ? undefined : [partyError]}
				>
					{#snippet control({ id, describedBy, invalid })}
						<OrganizationPicker
							{id}
							{describedBy}
							{invalid}
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

				<!-- Процесс не выбирают: он выводится из вида организации, отмеченной
					основной стороной. Подсказка объясняет это заранее — иначе выбор
					стороны выглядел бы как выбор одного лишь участника. -->
				<InlineHint tone={emptyProcess ? 'warning' : 'info'}>
					Процесс определится по основной стороне: {processHint}. Взаимодействие начнётся с первой
					стадии действующего процесса своей группы.
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

		<FormActions
			submitting={$submitting}
			submitLabel="Создать взаимодействие"
			oncancel={() => goto(resolve('/interactions'))}
		/>
	</form>
</div>
