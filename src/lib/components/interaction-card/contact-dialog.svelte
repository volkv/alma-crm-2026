<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import LibraryIcon from '@lucide/svelte/icons/library';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as RadioGroup from '$lib/components/ui/radio-group/index.js';
	import * as SegmentedControl from '$lib/components/ui/segmented-control/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import FieldDate from '$lib/components/form/field-date.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FormGrid from '$lib/components/form/form-grid.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StaleNotice from '$lib/components/interactions/stale-notice.svelte';
	import { AFFILIATION_ROLE_OPTIONS, NO_OPTION } from '$lib/components/directory/labels';
	import { newOrganizationContactSchema } from '$lib/contracts/directory';
	import type { InteractionPartyView, InteractionView } from '$lib/contracts/interactions';
	import type { SiteSourceView } from '$lib/contracts/organization-card';
	import { formatIsoDay } from '$lib/format';
	import { getCardCommands } from './commands.svelte';
	import type { CounterpartyShape } from './model';
	import SiteOffersSection from './site-offers-section.svelte';
	import { SITE_POLL_ATTEMPTS, SITE_POLL_INTERVAL_MS } from './site-offers';

	/**
	 * Контактное лицо основной стороны: человек из действующих ролей её
	 * организации, «Не выбрано» — или новый человек, заведённый тут же.
	 *
	 * Здесь же — «Как связываться»: канал связи, о котором договорились, живёт
	 * в роли человека, и пункт «Согласован канал связи» закрывается на месте,
	 * без похода в карточку организации. Открывается диалог командой карточки
	 * (`contact`) — из панели стороны и кнопкой у пункта чек-листа.
	 *
	 * Список — те же подсказки, что у формы заведения записи, и читается он при
	 * каждом открытии: роль могли завести в карточке вуза минуту назад.
	 *
	 * Выбор — поиском по одной строке в двух блоках: «В справочнике» — уже
	 * заведённые люди организации, ниже, отдельно, «С сайта вуза» — люди из
	 * «Руководства» и «Структуры» сайта, которых в справочнике ещё нет, с
	 * кнопкой «Импортировать»: сервер заводит человека тем же созданием
	 * контакта, что у карточки вуза, и сразу делает его контактом стороны.
	 * Сайт ещё читается — блок говорит об этом и переспрашивает сервер
	 * несколько раз. Почта и телефон кандидатов в диалоге не показываются:
	 * они ложатся в карточку человека зашифрованными.
	 *
	 * Нужного человека нет нигде — вкладка «Добавить нового»: ФИО, должность,
	 * роль и срок полномочий, почта и телефон. Без права заводить людей ни
	 * вкладки, ни блока с сайта нет.
	 *
	 * Как у плана, диалог несёт версию записи, с которой его открыли, и причину
	 * правки для ленты: отказ 409 оставляет выбор и ввод в диалоге.
	 */
	let {
		interaction,
		party,
		shape
	}: {
		interaction: InteractionView;
		party: InteractionPartyView;
		shape: CounterpartyShape;
	} = $props();

	const commands = getCardCommands();
	const open = $derived(commands.is('contact'));

	function setOpen(next: boolean) {
		if (!next) commands.close();
	}

	/** Чей это человек — словами для подписей: вуза, компании или сам слушатель. */
	const whose = $derived(
		shape === 'institution' ? 'вуза' : shape === 'company' ? 'компании' : 'стороны'
	);

	type Option = { id: string; label: string };
	type Candidate = {
		unit: string;
		name: string;
		position: string;
		fromManagement: boolean;
		siteId: string | null;
	};
	type Offers = {
		canCreate: boolean;
		candidates: Candidate[];
		source: SiteSourceView | null;
		total: number;
	};
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
	/** Состояние отчёта сайта; `null` — блока «С сайта вуза» нет. */
	let source = $state<SiteSourceView | null>(null);
	let candidatesTotal = $state(0);
	/** Повторные вопросы кончились, а сайт всё ещё читается. */
	let candidatesExhausted = $state(false);
	/** Поиск по одной строке в обоих блоках. */
	let query = $state('');
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
	/** «Как связываться»: пусто — не менять записанное. */
	let channel = $state('');
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
	const initialChannel = $derived(party.contactChannel ?? '');
	const channelChanged = $derived(channel.trim() !== initialChannel.trim());
	const dirty = $derived(
		contactId !== initialId || reason.trim() !== '' || contactTouched || channelChanged
	);

	/**
	 * Номер открытия диалога: ответ, пришедший после закрытия или повторного
	 * открытия, не должен перетирать то, что показано сейчас.
	 */
	let generation = 0;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;

	const offersUrl = $derived(`${createUrl}?partyId=${encodeURIComponent(party.id)}`);

	function applyOffers(offers: Offers) {
		canCreate = offers.canCreate;
		candidates = offers.candidates;
		source = offers.source;
		candidatesTotal = offers.total;
	}

	/** Сайт ещё читается — спросить ещё раз, но не больше `SITE_POLL_ATTEMPTS` раз. */
	function schedulePoll(current: number, attempt: number) {
		if (source?.state !== 'warming') return;

		if (attempt >= SITE_POLL_ATTEMPTS) {
			candidatesExhausted = true;
			return;
		}

		pollTimer = setTimeout(() => void pollOffers(current, attempt + 1), SITE_POLL_INTERVAL_MS);
	}

	/** Повторный вопрос о кандидатах с сайта: сбой оставляет показанное как было. */
	async function pollOffers(current: number, attempt: number) {
		try {
			const response = await fetch(offersUrl);

			if (current !== generation || !response.ok) return;

			const offers: Offers = await response.json();

			if (current !== generation) return;

			applyOffers(offers);
			schedulePoll(current, attempt);
		} catch {
			// Нет связи — блок остаётся «подтягиваем», форма работает без него.
		}
	}

	async function loadOptions(current: number) {
		loading = true;
		loadFailed = false;

		try {
			const [list, extra] = await Promise.all([fetch(lookupUrl), fetch(offersUrl)]);

			if (current !== generation) return;

			if (!list.ok || !extra.ok) {
				loadFailed = true;
				options = [];
				applyOffers({ canCreate: false, candidates: [], source: null, total: 0 });
				return;
			}

			const body: { items?: Option[] } = await list.json();
			const offers: Offers = await extra.json();

			if (current !== generation) return;

			options = body.items ?? [];
			applyOffers(offers);
			schedulePoll(current, 1);
		} catch {
			if (current !== generation) return;

			loadFailed = true;
			options = [];
			applyOffers({ canCreate: false, candidates: [], source: null, total: 0 });
		} finally {
			if (current === generation) loading = false;
		}
	}

	// Форма открывается с тем, что записано сейчас, а не с прошлым черновиком.
	$effect(() => {
		if (!open) return;

		untrack(() => {
			generation += 1;
			mode = 'pick';
			contactId = party.contactAffiliationId ?? NO_OPTION;
			contact = emptyContact();
			fieldErrors = {};
			formError = null;
			reason = '';
			channel = party.contactChannel ?? '';
			editVersion = interaction.editVersion;
			conflict = null;
			adding = null;
			query = '';
			candidatesExhausted = false;
			void loadOptions(generation);
		});

		return () => {
			generation += 1;
			clearTimeout(pollTimer);
		};
	});

	function matches(text: string): boolean {
		const wanted = query.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е');

		return wanted === '' || text.toLocaleLowerCase('ru').replace(/ё/g, 'е').includes(wanted);
	}

	/** Люди справочника по поиску; выбранный виден всегда — выбор не прячется. */
	const choiceMatches = $derived(
		choices.filter((option) => option.id === contactId || matches(option.label))
	);

	const candidateMatches = $derived(
		candidates.filter((candidate) => matches(`${candidate.name} ${candidate.position}`))
	);

	/** Переключение выбора: канал записан у прежнего человека, у выбранного он свой. */
	function selectContact(next: string) {
		contactId = next;
		channel = next === initialId ? (party.contactChannel ?? '') : '';
	}

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
				reason,
				channel: channelInput()
			})
		});

		if (response.ok) {
			commands.close();
			await invalidateAll();
			return;
		}

		await showFailure(response, 'Контактное лицо не сохранено');
	}

	/**
	 * Канал связи уходит, только если его поменяли: `null` — оставить
	 * записанный. Стереть канал отсюда нельзя — его снимают в карточке роли.
	 */
	function channelInput(): string | null {
		return channelChanged && channel.trim() !== '' ? channel.trim() : null;
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
			body: JSON.stringify({
				partyId: party.id,
				editVersion,
				reason,
				source,
				channel: channel.trim() === '' ? null : channel.trim()
			})
		});

		if (response.ok) {
			commands.close();
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

{#snippet channelField()}
	<FieldInput
		name="contact-channel"
		label="Как связываться"
		description="Как договорились: почта, телефон, мессенджер или портал. Закрывает пункт «Согласован канал связи»."
		placeholder="Например: Telegram, по будням после 15:00"
		errors={fieldErrors.channel}
		bind:value={channel}
	/>
{/snippet}

<FormDialog
	bind:open={() => open, setOpen}
	title="Контактное лицо"
	description="Человек {whose}, с которым ведётся работа, и как с ним связываться. Смена контакта попадёт в ленту вместе с причиной."
	{dirty}
	width={mode === 'create' ? 'xl' : 'lg'}
>
	<form id="card-contact-form" class="flex flex-col gap-form" novalidate onsubmit={save}>
		{#if conflict !== null}
			<StaleNotice message={conflict} onrefreshed={rebase} />
		{/if}

		{#if canCreate}
			<SegmentedControl.Root
				size="sm"
				aria-label="Выбрать из контактов или добавить нового"
				value={mode}
				onValueChange={(value) => (mode = value as Mode)}
			>
				<SegmentedControl.Item value="pick">Из контактов {whose}</SegmentedControl.Item>
				<SegmentedControl.Item value="create">Добавить нового</SegmentedControl.Item>
			</SegmentedControl.Root>
		{/if}

		{#if mode === 'pick'}
			<div class="flex flex-col gap-2">
				<Label for="card-contact-search">Контактное лицо</Label>
				<div class="relative">
					<SearchIcon
						class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
						aria-hidden="true"
					/>
					<Input
						id="card-contact-search"
						type="search"
						class="pl-8"
						autocomplete="off"
						placeholder="Найти по ФИО или должности"
						disabled={loading}
						bind:value={query}
						onkeydown={(event) => {
							// Enter в поиске не сохраняет выбор.
							if (event.key === 'Enter') event.preventDefault();
						}}
					/>
				</div>
				<p class="text-xs text-muted-foreground">Выбрано: {chosenLabel}</p>

				<section class="flex flex-col gap-1.5" aria-label="Люди в справочнике">
					<p class="flex items-center gap-1.5 text-xs font-medium">
						<LibraryIcon class="size-3.5" aria-hidden="true" />
						В справочнике
					</p>
					{#if loading}
						<p class="text-xs text-muted-foreground">Загружаем список…</p>
					{:else}
						<RadioGroup.Root
							value={contactId}
							onValueChange={selectContact}
							aria-label="Контактное лицо из справочника"
							class="flex max-h-48 flex-col gap-1.5 overflow-y-auto"
						>
							<div class="flex items-center gap-2">
								<RadioGroup.Item value={NO_OPTION} id="card-contact-none" />
								<Label for="card-contact-none" class="font-normal">Не выбрано</Label>
							</div>
							{#each choiceMatches as option (option.id)}
								<div class="flex items-start gap-2">
									<RadioGroup.Item value={option.id} id="card-contact-{option.id}" class="mt-0.5" />
									<Label for="card-contact-{option.id}" class="font-normal break-words">
										{option.label}
									</Label>
								</div>
							{/each}
						</RadioGroup.Root>
						{#if choices.length === 0}
							<p class="text-xs text-muted-foreground">У {whose} пока нет действующих контактов</p>
						{:else if choiceMatches.length === 0 && query.trim() !== ''}
							<p class="text-xs text-muted-foreground">Среди контактов {whose} не нашлось</p>
						{/if}
					{/if}
				</section>

				{#if canCreate && source !== null && !loading}
					<SiteOffersSection
						{source}
						kind="people"
						total={candidatesTotal}
						shown={candidates.length}
						exhausted={candidatesExhausted}
						hint="Люди из «Руководства» и «Структуры» сайта, которых нет в справочнике. «Импортировать» заведёт человека и сразу сделает его контактным лицом."
					>
						{#if candidateMatches.length === 0}
							<p class="px-3 py-2 text-xs text-muted-foreground">С сайта по запросу никого</p>
						{:else}
							<ul class="flex max-h-56 flex-col divide-y divide-border overflow-y-auto">
								{#each candidateMatches as candidate, index (`${candidate.unit}\u0000${candidate.name}\u0000${index}`)}
									<li
										class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5"
									>
										<div class="min-w-0 flex-1 basis-48 text-sm">
											<p class="font-medium break-words">{candidate.name}</p>
											<p class="text-xs break-words text-muted-foreground">{candidate.position}</p>
											{#if candidate.fromManagement}
												<p class="text-xs text-faint">Руководство вуза</p>
											{:else if candidate.siteId !== null}
												<p class="text-xs text-faint">Подразделение уже в справочнике</p>
											{/if}
										</div>
										<Button
											type="button"
											size="xs"
											variant="outline"
											disabled={adding !== null || saving}
											onclick={() => addCandidate(candidate)}
										>
											<DownloadIcon aria-hidden="true" />
											{adding === `${candidate.unit}\u0000${candidate.name}`
												? 'Импортируем…'
												: 'Импортировать'}
										</Button>
									</li>
								{/each}
							</ul>
						{/if}
					</SiteOffersSection>
				{/if}

				{#if formError !== null}
					<InlineHint tone="warning">{formError}</InlineHint>
				{/if}
				{#if loadFailed}
					<InlineHint tone="warning"
						>Список людей не загрузился: закройте диалог и откройте снова.</InlineHint
					>
				{/if}
				{#if canCreate && contactId !== NO_OPTION}
					{@render channelField()}
				{/if}
				{#if canCreate}
					<p class="text-xs text-muted-foreground">
						Нет нужного человека?
						<button
							type="button"
							class="rounded-sm text-foreground underline underline-offset-2 focus-ring"
							onclick={() => (mode = 'create')}
						>
							Добавьте его здесь
						</button>
					</p>
				{/if}
			</div>
		{:else}
			{#if formError !== null}
				<InlineHint tone="warning">{formError}</InlineHint>
			{/if}

			<FormGrid cols={2}>
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
				<div class="sm:col-span-2">{@render channelField()}</div>
			</FormGrid>
			<p class="text-xs text-muted-foreground">
				Почта и телефон — персональные данные: хранятся зашифрованными, без права на них в карточке
				видны скрытыми. Человек и его роль появятся и в карточке вуза.
			</p>
		{/if}

		<!-- Причина — у смены контакта: первое назначение ничего не отменяет,
			и объяснять в нём нечего. -->
		{#if party.contactAffiliationId !== null}
			<div class="flex flex-col gap-field">
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
					(mode === 'pick' && contactId === initialId && !channelChanged)}
			>
				{mode === 'create' ? 'Добавить и сделать контактом' : 'Сохранить'}
			</Button>
		</div>
	{/snippet}
</FormDialog>
