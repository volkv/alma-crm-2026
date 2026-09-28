<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { goto } from '$app/navigation';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as SegmentedControl from '$lib/components/ui/segmented-control/index.js';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import FormField from '$lib/components/form/form-field.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import OrganizationPicker from '$lib/components/interactions/organization-picker.svelte';
	import type { LookupOption, OrganizationKind } from '$lib/contracts/directory';
	import {
		createInteractionSchema,
		PARTY_ROLE_LABELS,
		type CreateInteractionInput
	} from '$lib/contracts/interactions';
	import { listPath } from '../filters';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Адреса раздела: ключ пространства стоит в пути, и его знает страница. */
	const listHref = $derived(listPath(data.workspace.key));
	const lookupPath = $derived(`${listHref}/lookup`);

	/**
	 * С кем ведётся процесс. Форма заводит дело с минимумом: сторона, название,
	 * ответственный, у вуза — ещё компания-заказчик. Площадки, контакты, сроки,
	 * программы, продукты и договор дополняют в карточке по ходу процесса.
	 * Какие виды предлагать, решает пространство (с кем оно работает); вид
	 * организации, пришедшей по ссылке с её карточки, стоит первым.
	 */
	type PrimaryKind = 'educational_institution' | 'legal_entity' | 'individual';

	const PRIMARY_KIND_LABELS: Record<PrimaryKind, string> = {
		educational_institution: 'Учебное заведение',
		legal_entity: 'Компания',
		individual: 'Физическое лицо'
	};

	const PRIMARY_KIND_HINTS: Record<PrimaryKind, string> = {
		educational_institution:
			'Учебное заведение обязательно: с ним ведётся процесс. Компания-заказчик — если подготовку заказывает она.',
		legal_entity: 'Юридическое лицо, которое отправляет на обучение своих сотрудников.',
		individual: 'Человек, который учится сам и сам оплачивает обучение.'
	};

	/**
	 * Кого искать в поле стороны: режим «Компания» — только юридических лиц и
	 * компании-заказчики, «Физическое лицо» — только физлиц, «Учебное
	 * заведение» — только вузы и колледжи.
	 */
	const SEARCH_KINDS: Record<PrimaryKind, readonly OrganizationKind[]> = {
		educational_institution: ['educational_institution'],
		legal_entity: ['legal_entity', 'customer_company'],
		individual: ['individual']
	};

	const isPrimaryKind = (kind: string | null): kind is PrimaryKind =>
		kind === 'educational_institution' || kind === 'legal_entity' || kind === 'individual';

	const kindOptions = $derived.by(() => {
		const offered = data.counterpartyKinds.filter(isPrimaryKind);
		const preset = data.presetKind;

		return isPrimaryKind(preset) && !offered.includes(preset) ? [preset, ...offered] : offered;
	});

	let counterpartyKind = $state<PrimaryKind>(
		untrack(() =>
			isPrimaryKind(data.presetKind)
				? data.presetKind
				: (data.counterpartyKinds.find(isPrimaryKind) ?? 'educational_institution')
		)
	);

	const isInstitution = $derived(counterpartyKind === 'educational_institution');

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
			// Стороны — вложенный список: форма едет одним JSON.
			dataType: 'json',
			// Шапка приложения липкая, и без её высоты superforms считает
			// спрятанную под ней ошибку «уже на экране» и никуда не ведёт.
			stickyNavbar: 'header',
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	// Организация из ссылки с её карточки: подставлена сразу и меняется как
	// выбранная вручную.
	let institution = $state<LookupOption | null>(untrack(() => data.presetInstitution));
	let customer = $state<LookupOption | null>(null);
	// У физического лица контакт дела — он сам: полем его не выбирают, он
	// подставляется.
	let contactAffiliationId = $state<string | null>(null);

	/**
	 * Тронул ли человек стороны. Они попадают в поля формы производными — и,
	 * будь они «правкой», уход с нетронутой формы спрашивал бы подтверждение.
	 * Название и ответственного отслеживает сама форма.
	 */
	const touched = $derived(
		(institution?.id ?? null) !== (data.presetInstitution?.id ?? null) || customer !== null
	);

	async function onInstitution(option: LookupOption | null, createdContact: string | null = null) {
		contactAffiliationId = createdContact;

		if (option === null || counterpartyKind !== 'individual' || createdContact !== null) {
			return;
		}

		const response = await fetch(
			`${lookupPath}?kind=contacts&organizationId=${encodeURIComponent(option.id)}`
		);

		if (!response.ok) {
			return;
		}

		const body: { items?: LookupOption[] } = await response.json();
		const contacts = body.items ?? [];

		// Роль у физического лица одна — выбирать нечего.
		if (contactAffiliationId === null && contacts.length === 1) {
			contactAffiliationId = contacts[0].id;
		}
	}

	/** Другой вид контрагента — другая основная сторона: выбранное прежде к нему не относится. */
	function onKind(next: string) {
		if (!isPrimaryKind(next)) return;

		counterpartyKind = next;
		institution = null;
		customer = null;
		contactAffiliationId = null;
	}

	onMount(() => {
		if (institution !== null) {
			void onInstitution(institution);
		}
	});

	// Стороны взаимодействия собираются из выбранных организаций: контракт ждёт
	// список участников с ролями, а форма показывает понятные строки. Оператора
	// (саму школу) ставит сервер. Поля формы обновляются без пометки «тронуто»,
	// пока человек ничего не выбрал (`touched`).
	$effect(() => {
		const parties: CreateInteractionInput['parties'] = [];

		if (institution !== null) {
			parties.push({
				organizationId: institution.id,
				// Компания и физическое лицо в ролях сторон — заказчик: они сами
				// заказывают обучение (так же их ставит приём заявки с сайта).
				partyRole: isInstitution ? ('educational_institution' as const) : ('customer' as const),
				isPrimary: true,
				contactAffiliationId,
				siteIds: []
			});
		}

		if (customer !== null && isInstitution) {
			parties.push({
				organizationId: customer.id,
				partyRole: 'customer' as const,
				isPrimary: false,
				contactAffiliationId: null,
				siteIds: []
			});
		}

		form.update(($form) => ({ ...$form, parties }), { taint: touched });
	});

	// Претензии к сторонам показываются по одной на строку: склеенные в одну
	// фразу, они читаются как сломанное предложение.
	const partyErrors = $derived($errors.parties?._errors ?? []);
</script>

<svelte:head>
	<title>Новое взаимодействие — Альма CRM</title>
</svelte:head>

<Header
	title="Новое взаимодействие"
	description="С кем ведётся работа и кто за неё отвечает. Остальное дополняют в карточке по ходу процесса."
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
				<Alert.Description>Выберите контрагента в форме.</Alert.Description>
			</Alert.Root>
		{/if}

		{#if $formMessage}
			<Alert.Root variant="destructive">
				<Alert.Title>{$formMessage}</Alert.Title>
			</Alert.Root>
		{/if}

		<Card.Root size="sm">
			<Card.Content class="flex flex-col gap-4">
				<FieldInput
					name="title"
					label="Название"
					required
					placeholder="Например: подготовка специалистов по защите информации"
					bind:value={$form.title}
					errors={$errors.title}
				/>

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

				{#if kindOptions.length > 1}
					<SegmentedControl.Root
						aria-label="С кем ведётся процесс"
						value={counterpartyKind}
						onValueChange={onKind}
					>
						{#each kindOptions as kind (kind)}
							<SegmentedControl.Item value={kind}>{PRIMARY_KIND_LABELS[kind]}</SegmentedControl.Item
							>
						{/each}
					</SegmentedControl.Root>
				{/if}

				<p class="text-xs text-muted-foreground">{PRIMARY_KIND_HINTS[counterpartyKind]}</p>

				{#key counterpartyKind}
					<FormField
						name="institution"
						label={counterpartyKind === 'individual'
							? 'Слушатель'
							: PRIMARY_KIND_LABELS[counterpartyKind]}
						required
						errors={partyErrors.length === 0 ? undefined : partyErrors}
					>
						{#snippet control({ id, describedBy, invalid })}
							<OrganizationPicker
								{id}
								{describedBy}
								{invalid}
								{lookupPath}
								placeholder={counterpartyKind === 'individual'
									? 'Начните вводить фамилию, почту или телефон'
									: 'Начните вводить название или ИНН'}
								registryRole={data.registryAvailable && isInstitution
									? 'educational_institution'
									: null}
								kinds={SEARCH_KINDS[counterpartyKind]}
								createKind={counterpartyKind === 'individual'
									? data.canCreate.individual
										? 'individual'
										: null
									: data.canCreate.organization
										? counterpartyKind
										: null}
								value={institution?.id ?? null}
								label={institution?.label ?? null}
								onselect={(option, createdContact) => {
									institution = option;
									void onInstitution(option, createdContact ?? null);
								}}
							/>
						{/snippet}
					</FormField>
				{/key}

				{#if isInstitution}
					<FormField name="customer" label={PARTY_ROLE_LABELS.customer}>
						{#snippet control({ id, describedBy, invalid })}
							<OrganizationPicker
								{id}
								{describedBy}
								{invalid}
								{lookupPath}
								placeholder="Компания, для которой готовят специалистов"
								registryRole={data.registryAvailable ? 'customer' : null}
								kinds={SEARCH_KINDS.legal_entity}
								createKind={data.canCreate.organization ? 'customer_company' : null}
								value={customer?.id ?? null}
								label={customer?.label ?? null}
								onselect={(option) => (customer = option)}
							/>
						{/snippet}
					</FormField>
				{/if}

				<!-- Пространство не выбирают в форме: запись заводят внутри него, и
					его имя стоит в заголовке. Подсказка называет место словами —
					иначе «куда именно она встанет» остаётся догадкой. -->
				<InlineHint tone="info">
					Запись встанет в пространство «{data.workspace.name}» на первую стадию действующей
					редакции его процесса. Площадки, контакты, сроки, программы, продукты и договор заполняют
					в карточке.
				</InlineHint>
			</Card.Content>
		</Card.Root>

		<FormActions
			submitting={$submitting}
			submitLabel="Создать взаимодействие"
			oncancel={() => goto(listHref)}
		/>
	</form>
</div>
