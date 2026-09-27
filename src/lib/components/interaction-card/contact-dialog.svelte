<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import UserPlusIcon from '@lucide/svelte/icons/user-plus';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as SegmentedControl from '$lib/components/ui/segmented-control/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import FieldDate from '$lib/components/form/field-date.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StaleNotice from '$lib/components/interactions/stale-notice.svelte';
	import { AFFILIATION_ROLE_OPTIONS, NO_OPTION } from '$lib/components/directory/labels';
	import { newOrganizationContactSchema } from '$lib/contracts/directory';
	import type { InteractionPartyView, InteractionView } from '$lib/contracts/interactions';
	import { formatIsoDay } from '$lib/format';

	/**
	 * Контактное лицо стороны: человек из действующих ролей её организации,
	 * «Не выбрано» — или новый человек, заведённый тут же.
	 *
	 * Список — те же подсказки, что у формы заведения записи, и читается он при
	 * каждом открытии: роль могли завести в карточке вуза минуту назад.
	 *
	 * Нужного человека нет — вкладка «Новый человек»: ФИО, должность, роль и
	 * срок полномочий, почта и телефон. Сервер заводит человека и роль тем же
	 * созданием контакта, что у карточки вуза, и сразу делает его контактом
	 * стороны. Если паспорт вуза уже прочитан, его руководители подразделений
	 * стоят там же — одним щелчком. Без права заводить людей вкладки нет.
	 *
	 * Как у плана, диалог несёт версию записи, с которой его открыли, и причину
	 * правки для ленты: отказ 409 оставляет выбор и ввод в диалоге.
	 */
	let {
		open = $bindable(false),
		interaction,
		party
	}: {
		open?: boolean;
		interaction: InteractionView;
		party: InteractionPartyView;
	} = $props();

	type Option = { id: string; label: string };
	type Candidate = { unit: string; name: string; position: string };
	type Mode = 'pick' | 'create';

	/** Поля нового человека так, как их держит форма: строки, пустая — «нет». */
	type ContactForm = {
		lastName: string;
		firstName: string;
		middleName: string;
		position: string;
		roleKind: string;
		validFrom: string;
		validTo: string;
		email: string;
		phone: string;
	};

	function emptyContact(): ContactForm {
		return {
			lastName: '',
			firstName: '',
			middleName: '',
			position: '',
			roleKind: '',
			validFrom: formatIsoDay(),
			validTo: '',
			email: '',
			phone: ''
		};
	}

	let options = $state<Option[]>([]);
	let candidates = $state<Candidate[]>([]);
	let canCreate = $state(false);
	let loading = $state(false);
	let loadFailed = $state(false);
	let saving = $state(false);
	let mode = $state<Mode>('pick');
	let contactId = $state(untrack(() => party.contactAffiliationId ?? NO_OPTION));
	let contact = $state<ContactForm>(emptyContact());
	let fieldErrors = $state<Record<string, string[]>>({});
	let formError = $state<string | null>(null);
	let reason = $state('');
	let editVersion = $state(untrack(() => interaction.editVersion));
	let conflict = $state<string | null>(null);
	/** Кандидат паспорта, которого сейчас заводят: `unit + name`. */
	let adding = $state<string | null>(null);

	const initialId = $derived(party.contactAffiliationId ?? NO_OPTION);
	const workspace = $derived(page.params.workspace ?? '');
	const lookupUrl = $derived(
		`${resolve('/(app)/w/[workspace]/interactions/lookup', { workspace })}?kind=contacts&organizationId=${encodeURIComponent(party.organizationId)}`
	);
	const saveUrl = $derived(
		resolve('/(app)/w/[workspace]/interactions/[id=uuid]/contact', {
			workspace,
			id: interaction.id
		})
	);
	const createUrl = $derived(
		resolve('/(app)/w/[workspace]/interactions/[id=uuid]/contact/new', {
			workspace,
			id: interaction.id
		})
	);

	/**
	 * Нынешний контакт стоит в списке, даже если его роль уже закончилась:
	 * иначе поле показывало бы пустоту вместо того, что записано.
	 */
	const choices = $derived.by(() => {
		const current = party.contactAffiliationId;

		if (
			current === null ||
			party.contact === null ||
			options.some((option) => option.id === current)
		) {
			return options;
		}

		const name = [party.contact.lastName, party.contact.firstName].filter(Boolean).join(' ');

		return [
			{
				id: current,
				label: party.contactPosition ? `${name} — ${party.contactPosition}` : name
			},
			...options
		];
	});

	const chosenLabel = $derived(
		contactId === NO_OPTION
			? 'Не выбрано'
			: (choices.find((option) => option.id === contactId)?.label ?? 'Не выбрано')
	);
	const contactTouched = $derived(
		Object.entries(contact).some(([key, value]) =>
			key === 'validFrom' ? value !== formatIsoDay() : value.trim() !== ''
		)
	);
	const dirty = $derived(contactId !== initialId || reason.trim() !== '' || contactTouched);

	async function loadOptions() {
		loading = true;
		loadFailed = false;

		try {
			const [list, extra] = await Promise.all([
				fetch(lookupUrl),
				fetch(`${createUrl}?partyId=${encodeURIComponent(party.id)}`)
			]);

			if (!list.ok || !extra.ok) {
				loadFailed = true;
				options = [];
				candidates = [];
				canCreate = false;
				return;
			}

			const body: { items?: Option[] } = await list.json();
			const more: { canCreate: boolean; candidates: Candidate[] } = await extra.json();

			options = body.items ?? [];
			canCreate = more.canCreate;
			candidates = more.candidates;
		} catch {
			loadFailed = true;
			options = [];
			candidates = [];
			canCreate = false;
		} finally {
			loading = false;
		}
	}

	// Форма открывается с тем, что записано сейчас, а не с прошлым черновиком.
	$effect(() => {
		if (!open) return;

		untrack(() => {
			mode = 'pick';
			contactId = party.contactAffiliationId ?? NO_OPTION;
			contact = emptyContact();
			fieldErrors = {};
			formError = null;
			reason = '';
			editVersion = interaction.editVersion;
			conflict = null;
			adding = null;
			void loadOptions();
		});
	});

	/** Карточка перечитана после отказа: форма встаёт на свежую версию, ввод остаётся. */
	function rebase() {
		editVersion = interaction.editVersion;
		conflict = null;
	}

	type Failure = { error?: string; issues?: string[]; fields?: Record<string, string[]> };

	/** Отказ сервера: 409 — поверх чужой правки, иначе — у полей и над формой. */
	async function showFailure(response: Response, fallback: string) {
		const body: Failure = await response.json().catch(() => ({}));
		const message = body.error ?? fallback;

		if (response.status === 409) {
			conflict = message;
			return;
		}

		const fields = body.fields ?? {};

		if (Object.keys(fields).length > 0) {
			fieldErrors = fields;
			formError = message;
			return;
		}

		formError = null;
		toast.error(message, {
			description: body.issues && body.issues.length > 0 ? body.issues.join('; ') : undefined
		});
	}

	async function savePick() {
		const response = await fetch(saveUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				partyId: party.id,
				contactAffiliationId: contactId === NO_OPTION ? null : contactId,
				editVersion,
				reason
			})
		});

		if (response.ok) {
			open = false;
			await invalidateAll();
			return;
		}

		await showFailure(response, 'Контактное лицо не сохранено');
	}

	/** Пустые необязательные поля уходят `null`: так их ждёт схема. */
	function contactInput() {
		const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

		return {
			lastName: contact.lastName,
			firstName: contact.firstName,
			middleName: orNull(contact.middleName),
			position: contact.position,
			roleKind: contact.roleKind,
			validFrom: contact.validFrom,
			validTo: orNull(contact.validTo),
			email: orNull(contact.email),
			phone: orNull(contact.phone)
		};
	}

	/**
	 * Та же схема, что на сервере, — до отправки: ошибка встаёт у поля сразу.
	 * Сверх неё — срок полномочий: контактом становится действующая роль.
	 */
	function validateContact(input: ReturnType<typeof contactInput>): boolean {
		const errors: Record<string, string[]> = {};
		const parsed = newOrganizationContactSchema.safeParse(input);

		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				const field = issue.path.at(-1);

				if (typeof field === 'string') {
					(errors[field] ??= []).push(issue.message);
				}
			}
		}

		if (input.validTo !== null && input.validTo < formatIsoDay() && errors.validTo === undefined) {
			errors.validTo = ['Срок полномочий уже закончился: контактом становится действующая роль'];
		}

		fieldErrors = errors;

		return Object.keys(errors).length === 0;
	}

	async function create(source: object): Promise<boolean> {
		const response = await fetch(createUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ partyId: party.id, editVersion, reason, source })
		});

		if (response.ok) {
			open = false;
			await invalidateAll();
			return true;
		}

		await showFailure(response, 'Контакт не заведён');

		return false;
	}

	async function saveNew() {
		const input = contactInput();

		formError = null;

		if (!validateContact(input)) {
			return;
		}

		if (await create({ kind: 'manual', contact: input })) {
			toast.success(`${input.lastName} ${input.firstName} — контактное лицо`);
		}
	}

	async function addCandidate(candidate: Candidate) {
		adding = `${candidate.unit}\u0000${candidate.name}`;
		formError = null;

		try {
			if (
				await create({ kind: 'site', candidate: { unit: candidate.unit, name: candidate.name } })
			) {
				toast.success(`${candidate.name} — контактное лицо`);
			}
		} finally {
			adding = null;
		}
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		saving = true;

		try {
			await (mode === 'pick' ? savePick() : saveNew());
		} finally {
			saving = false;
		}
	}
</script>

<FormDialog
	bind:open
	title="Контактное лицо"
	description="Человек вуза, с которым ведётся работа. Смена попадёт в ленту вместе с причиной."
	{dirty}
	width={mode === 'create' ? 'lg' : 'md'}
>
	<form id="card-contact-form" class="flex flex-col gap-4" novalidate onsubmit={save}>
		{#if conflict !== null}
			<StaleNotice message={conflict} onrefreshed={rebase} />
		{/if}

		{#if canCreate}
			<SegmentedControl.Root
				size="sm"
				aria-label="Выбрать из контактов или завести нового"
				value={mode}
				onValueChange={(value) => (mode = value as Mode)}
			>
				<SegmentedControl.Item value="pick">Из контактов вуза</SegmentedControl.Item>
				<SegmentedControl.Item value="create">Новый человек</SegmentedControl.Item>
			</SegmentedControl.Root>
		{/if}

		{#if mode === 'pick'}
			<div class="flex flex-col gap-1.5">
				<Label for="card-contact">Контактное лицо</Label>
				<Select.Root type="single" bind:value={contactId} disabled={loading}>
					<Select.Trigger id="card-contact" class="w-full">
						{loading ? 'Загружаем список…' : chosenLabel}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value={NO_OPTION} label="Не выбрано" />
						{#each choices as option (option.id)}
							<Select.Item value={option.id} label={option.label} />
						{/each}
					</Select.Content>
				</Select.Root>
				{#if loadFailed}
					<InlineHint tone="warning"
						>Список людей не загрузился: закройте диалог и откройте снова.</InlineHint
					>
				{/if}
				{#if canCreate}
					<p class="text-xs text-muted-foreground">
						Нет нужного человека?
						<button
							type="button"
							class="rounded-sm text-foreground underline underline-offset-2 focus-ring"
							onclick={() => (mode = 'create')}
						>
							Заведите его здесь
						</button>
					</p>
				{/if}
			</div>
		{:else}
			{#if candidates.length > 0}
				<div class="flex flex-col gap-2" data-slot="passport-candidates">
					<h3 class="section-overline">Из паспорта вуза · {candidates.length}</h3>
					<p class="text-xs text-faint">
						Руководители подразделений с сайта вуза. Источник и дата запишутся в примечание
						человека.
					</p>
					<ul class="flex max-h-48 flex-col divide-y divide-border overflow-y-auto">
						{#each candidates as candidate (`${candidate.unit}\u0000${candidate.name}`)}
							<li class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5">
								<div class="min-w-0 flex-1 basis-48 text-sm">
									<p class="font-medium break-words">{candidate.name}</p>
									<p class="text-xs break-words text-muted-foreground">{candidate.position}</p>
								</div>
								<Button
									type="button"
									size="xs"
									variant="outline"
									disabled={adding !== null || saving}
									onclick={() => addCandidate(candidate)}
								>
									<UserPlusIcon aria-hidden="true" />
									{adding === `${candidate.unit}\u0000${candidate.name}`
										? 'Добавляем…'
										: 'Сделать контактом'}
								</Button>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if formError !== null}
				<InlineHint tone="warning">{formError}</InlineHint>
			{/if}

			<div class="grid gap-3 sm:grid-cols-2">
				<FieldInput
					name="new-contact-lastName"
					label="Фамилия"
					required
					errors={fieldErrors.lastName}
					bind:value={contact.lastName}
				/>
				<FieldInput
					name="new-contact-firstName"
					label="Имя"
					required
					errors={fieldErrors.firstName}
					bind:value={contact.firstName}
				/>
				<FieldInput
					name="new-contact-middleName"
					label="Отчество"
					errors={fieldErrors.middleName}
					bind:value={contact.middleName}
				/>
				<FieldInput
					name="new-contact-position"
					label="Должность"
					required
					placeholder="Например: проректор по учебной работе"
					errors={fieldErrors.position}
					bind:value={contact.position}
				/>
				<FieldSelect
					name="new-contact-roleKind"
					label="Роль в организации"
					required
					options={AFFILIATION_ROLE_OPTIONS}
					errors={fieldErrors.roleKind}
					bind:value={contact.roleKind}
				/>
				<div class="hidden sm:block" aria-hidden="true"></div>
				<FieldDate
					name="new-contact-validFrom"
					label="Полномочия с"
					required
					max={contact.validTo === '' ? undefined : contact.validTo}
					errors={fieldErrors.validFrom}
					bind:value={contact.validFrom}
				/>
				<FieldDate
					name="new-contact-validTo"
					label="Полномочия по"
					description="Пусто — бессрочно"
					min={contact.validFrom === '' ? undefined : contact.validFrom}
					errors={fieldErrors.validTo}
					bind:value={contact.validTo}
				/>
				<FieldInput
					name="new-contact-email"
					label="Почта"
					type="email"
					errors={fieldErrors.email}
					bind:value={contact.email}
				/>
				<FieldInput
					name="new-contact-phone"
					label="Телефон"
					type="tel"
					errors={fieldErrors.phone}
					bind:value={contact.phone}
				/>
			</div>
			<p class="text-xs text-muted-foreground">
				Почта и телефон — персональные данные: хранятся зашифрованными, без права на них в карточке
				видны скрытыми. Человек и его роль появятся и в карточке вуза.
			</p>
		{/if}

		<!-- Причина — у смены контакта: первое назначение ничего не отменяет,
			и объяснять в нём нечего. -->
		{#if party.contactAffiliationId !== null}
			<div class="flex flex-col gap-1.5">
				<Label for="card-contact-reason">Причина правки</Label>
				<Textarea
					id="card-contact-reason"
					rows={2}
					placeholder="Например: прежний контакт перешёл на другую должность"
					bind:value={reason}
				/>
			</div>
		{/if}
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button
				type="submit"
				form="card-contact-form"
				disabled={saving ||
					loading ||
					adding !== null ||
					(mode === 'pick' && contactId === initialId)}
			>
				{mode === 'create' ? 'Завести и сделать контактом' : 'Сохранить'}
			</Button>
		</div>
	{/snippet}
</FormDialog>
