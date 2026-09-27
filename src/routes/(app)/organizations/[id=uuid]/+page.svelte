<script lang="ts">
	import { resolve } from '$app/paths';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import LockIcon from '@lucide/svelte/icons/lock';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import ActionAlert from '$lib/components/directory/action-alert.svelte';
	import ContractsPanel from '$lib/components/directory/contracts-panel.svelte';
	import Flash from '$lib/components/directory/flash.svelte';
	import { SITE_KIND_LABELS } from '$lib/components/directory/labels';
	import ContactsList from '$lib/components/organization-card/contacts-list.svelte';
	import OrganizationFacts from '$lib/components/organization-card/organization-facts.svelte';
	import RequisitesPanel from '$lib/components/organization-card/requisites-panel.svelte';
	import SitePassport from '$lib/components/organization-card/site-passport.svelte';
	import WorkPanel from '$lib/components/organization-card/work-panel.svelte';
	import { partnerStatus, personFullName } from '$lib/components/organization-card/model';
	import ContextSection from '$lib/components/interaction-card/context-section.svelte';
	import { normalizePersonName } from '$lib/contracts/organization-card';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDateTime } from '$lib/format';
	import { isAffiliationCurrent, type AffiliationView } from '$lib/contracts/directory';
	import type { ResponsibleView } from '$lib/server/directory/responsibles';
	import type { ResolvedPathname } from '$app/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const siteNames = $derived(new Map(data.sites.map((site) => [site.id, site.name])));

	const currentAffiliations = $derived(
		data.affiliations.filter((row) => isAffiliationCurrent(row, data.today))
	);

	/** ФИО действующих контактов: по ним кандидат с сайта помечается «в контактах». */
	const contactNames = $derived(
		new Set(currentAffiliations.map((row) => normalizePersonName(personFullName(row))))
	);

	const primaryContact = $derived(currentAffiliations.find((row) => row.isPrimary) ?? null);

	const partner = $derived(partnerStatus(data.contracts, data.today, data.licenseWarningDays));

	/**
	 * Куда заводить взаимодействие: пространства сотрудника с назначенным
	 * процессом, первым — то, где с этой организацией уже больше всего работы.
	 */
	const startTargets = $derived(
		(data.work ?? [])
			.filter((workspace) => workspace.hasWorkflow)
			.sort((left, right) => right.total - left.total)
	);

	/** Форма нового взаимодействия с этим вузом, уже подставленным основной стороной. */
	function startHref(workspace: string): ResolvedPathname {
		// Путь собран `resolve`; добавлена только строка запроса, а её типа в
		// `ResolvedPathname` нет (тот же приём — `home/links.ts`).
		return `${resolve('/(app)/w/[workspace]/interactions/new', { workspace })}?organization=${data.organization.id}` as ResolvedPathname;
	}

	/**
	 * Почему главное действие недоступно тому, у кого на него есть право;
	 * `null` — доступно. Без права кнопки нет вовсе, и объяснять нечего.
	 */
	const startBlocked = $derived.by((): string | null => {
		if (!data.organization.isActive) {
			return 'Организация в архиве: верните её, чтобы завести по ней работу.';
		}

		if (startTargets.length === 0) {
			return 'Ни в одном вашем пространстве не назначен процесс — взаимодействию не с чего начать.';
		}

		return null;
	});

	let archiveForm = $state<HTMLFormElement | null>(null);
	let archiveOpen = $state(false);

	let restoreForm = $state<HTMLFormElement | null>(null);
	let restoreOpen = $state(false);

	let endForm = $state<HTMLFormElement | null>(null);
	let closing = $state<AffiliationView | null>(null);
	let closeOpen = $state(false);

	function askClose(row: AffiliationView) {
		closing = row;
		closeOpen = true;
	}

	let releaseForm = $state<HTMLFormElement | null>(null);
	let releasing = $state<ResponsibleView | null>(null);
	let releaseOpen = $state(false);

	/** Действующие назначения и закрытые: первые — рабочая картина, вторые — история. */
	const currentResponsibles = $derived(data.responsibles.filter((row) => row.validTo === null));
	const pastResponsibles = $derived(data.responsibles.filter((row) => row.validTo !== null));

	/**
	 * Есть ли уже ответственный за вуз целиком. Пока он есть, назначать по
	 * направлениям нельзя — сервис откажет, и предлагать это в форме значит
	 * обещать то, чего не будет.
	 */
	const hasGeneral = $derived(currentResponsibles.some((row) => row.directionId === null));
	const hasByDirection = $derived(currentResponsibles.some((row) => row.directionId !== null));

	/**
	 * Значение пункта «за вуз целиком». Пустая строка тут не годится: для списка
	 * она означает «ничего не выбрано», и пункт стал бы неотличим от пустоты, — а
	 * в форму всё равно уходит пустая строка, которую сервер и читает как «весь
	 * вуз» (`assignResponsible` в `+page.server.ts`).
	 */
	const WHOLE_ORGANIZATION = '__whole';

	/**
	 * Слова карточки по виду организации: «вуз» у учебного заведения, у
	 * компании и остальных — «организация». Карточка общая, а говорить с
	 * юрлицом вузовскими словами значит путать, с кем работа.
	 */
	const isInstitution = $derived(data.organization.kind === 'educational_institution');
	const words = $derived(
		isInstitution
			? {
					whole: 'весь вуз',
					accusative: 'вуз',
					thisAccusative: 'этот вуз',
					thisNominative: 'этот вуз',
					byIt: 'по нему',
					unassigned: 'Вуз не закреплён ни за кем',
					sitesEmpty: 'Кампусы, филиалы и подразделения'
				}
			: {
					whole: 'вся организация',
					accusative: 'организацию',
					thisAccusative: 'эту организацию',
					thisNominative: 'эта организация',
					byIt: 'по ней',
					unassigned: 'Организация не закреплена ни за кем',
					sitesEmpty: 'Офисы, филиалы и подразделения'
				}
	);

	let assignUserId = $state('');
	let assignDirectionId = $state(WHOLE_ORGANIZATION);

	/**
	 * Выбранные строки списков ищутся в самих списках: карточка соседнего вуза
	 * отдаёт другой набор сотрудников и направлений, а выбор пережил бы переход
	 * между ними. Не нашлось — значит, не выбрано, и форма уходит с пустым полем.
	 */
	const assignUser = $derived(
		data.assignableUsers.find((user) => user.id === assignUserId) ?? null
	);
	const assignDirection = $derived(
		hasByDirection && assignDirectionId === WHOLE_ORGANIZATION
			? (data.directionOptions[0] ?? null)
			: (data.directionOptions.find((direction) => direction.id === assignDirectionId) ?? null)
	);

	function askRelease(row: ResponsibleView) {
		releasing = row;
		releaseOpen = true;
	}
</script>

<svelte:head><title>{data.organization.shortName} — Альма CRM</title></svelte:head>

<Flash
	messages={{
		created: 'Организация создана',
		registry_created:
			'Организация создана по выписке из ЕГРЮЛ. Проверьте вид и уровень образования: они угаданы',
		updated: 'Изменения сохранены',
		site_created: 'Площадка добавлена',
		site_updated: 'Площадка сохранена',
		affiliation_created: 'Контакт добавлен',
		affiliation_ended: 'Полномочия закрыты',
		responsible_assigned: 'Ответственный назначен, доступ изменён',
		responsible_released: 'Назначение снято, доступ изменён',
		contract_saved: 'Договор сохранён',
		contract_item_saved: 'Позиция договора сохранена',
		restored: 'Организация возвращена из архива'
	}}
/>

<!-- Полное наименование — в реквизитах: длинное юридическое имя в шапке
	оттесняло бы то, по чему вуз узнают. -->
<Header title={data.organization.shortName}>
	{#snippet actions()}
		{#if data.canWrite}
			<!-- Физическое лицо — это карточка человека: ФИО и контакты правятся там,
				а формы организации для него нет. -->
			{#if data.organization.personId !== null}
				<Button
					variant="outline"
					href={resolve('/(app)/people/[id=uuid]', { id: data.organization.personId })}
				>
					<PencilIcon aria-hidden="true" />
					Карточка человека
				</Button>
			{:else}
				<Button
					variant="outline"
					href={resolve('/(app)/organizations/[id=uuid]/edit', { id: data.organization.id })}
				>
					<PencilIcon aria-hidden="true" />
					Изменить
				</Button>
			{/if}
			{#if data.organization.isActive}
				<Button variant="outline" onclick={() => (archiveOpen = true)}>
					<ArchiveIcon aria-hidden="true" />
					В архив
				</Button>
			{:else}
				<Button variant="outline" onclick={() => (restoreOpen = true)}>
					<ArchiveRestoreIcon aria-hidden="true" />
					Вернуть из архива
				</Button>
			{/if}
		{/if}
		<!-- Главное действие карточки — в шапке рядом с «Изменить»: основная
			кнопка ведёт в пространство, где с вузом больше всего работы, другие
			пространства — в меню соседней кнопки со стрелкой. Отдельная кнопка на
			каждое пространство переносила ряд действий шапки на вторую строку. -->
		{#if data.canStartInteraction && startBlocked === null}
			{@const [main, ...others] = startTargets}
			<div class="flex items-center gap-1" data-tour="organization-primary">
				<Button href={startHref(main.key)} title="В пространстве «{main.name}»">
					<PlusIcon aria-hidden="true" />
					Завести взаимодействие
				</Button>
				{#if others.length > 0}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="outline"
									size="icon"
									aria-label="Завести взаимодействие в другом пространстве"
								>
									<ChevronDownIcon aria-hidden="true" />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" class="w-64">
							<DropdownMenu.Group>
								<DropdownMenu.GroupHeading>Завести в пространстве</DropdownMenu.GroupHeading>
								<DropdownMenu.Item>
									{#snippet child({ props })}
										<a {...props} href={startHref(main.key)}>«{main.name}» — основное</a>
									{/snippet}
								</DropdownMenu.Item>
								{#each others as workspace (workspace.key)}
									<DropdownMenu.Item>
										{#snippet child({ props })}
											<a {...props} href={startHref(workspace.key)}>«{workspace.name}»</a>
										{/snippet}
									</DropdownMenu.Item>
								{/each}
							</DropdownMenu.Group>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				{/if}
			</div>
		{/if}
	{/snippet}
</Header>

<Breadcrumbs
	items={[
		{ label: 'Организации', href: resolve('/(app)/organizations') },
		{ label: data.organization.shortName }
	]}
/>

<div class="flex min-w-0 flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<ActionAlert />

	<!-- Почему завести работу нельзя, хотя право есть: архив или пространство
		без процесса. -->
	{#if data.canStartInteraction && startBlocked !== null}
		<InlineHint icon={LockIcon}>{startBlocked}</InlineHint>
	{/if}

	<OrganizationFacts
		organization={data.organization}
		responsibles={currentResponsibles}
		{partner}
		{primaryContact}
		canReadPeople={data.canReadPeople}
	/>

	<!-- Два блока — работа и контекст — стоят в разметке в том порядке, в каком
		их читают на телефоне. На рабочем экране контекст уходит в правую колонку,
		как на карточке взаимодействия. -->
	<div
		class="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_20rem]"
	>
		<div class="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">
			<div class="min-w-0 rounded-xl border border-border bg-surface p-4">
				<WorkPanel organizationId={data.organization.id} work={data.work} />
			</div>

			<ContractsPanel
				contracts={data.contracts}
				products={data.productOptions}
				canWrite={data.canWrite}
				canStartRenewal={data.canStartRenewal}
				licenseWarningDays={data.licenseWarningDays}
				today={data.today}
			/>

			<!-- «Сведения с сайта» — подготовка к работе, а не сама работа: под
				взаимодействиями и договорами, свёрнутые до счётчиков. Раздел
				«Сведения об образовательной организации» есть только у учебных
				заведений — у компании его искать незачем. -->
			{#if isInstitution}
				<div class="min-w-0 rounded-xl border border-border bg-surface p-4">
					<!-- Прочитанные «Сведения» живут в самом блоке: при переходе на карточку
					другого вуза блок создаётся заново, чтобы не показать чужих кандидатов. -->
					{#key data.organization.id}
						<SitePassport
							website={data.organization.website}
							reading={data.siteReading}
							initial={data.sitePassport}
							canAddContacts={data.canWritePeople}
							{contactNames}
						/>
					{/key}
				</div>
			{/if}

			<section
				class="min-w-0 rounded-xl border border-border bg-surface"
				data-tour="organization-responsibles"
			>
				<header class="border-b border-border px-4 py-3">
					<h2 class="section-title">Ответственные</h2>
					<p class="mt-1 text-xs text-muted-foreground">
						Кто ведёт {words.accusative}. От этого зависит, кто видит его карточку и взаимодействия
						по нему: назначение действует немедленно, а снятое закрывается точной меткой времени и
						остаётся в истории.
					</p>
				</header>

				{#if currentResponsibles.length === 0}
					<EmptyState
						title="Ответственного нет"
						description={`${words.unassigned}: в списках менеджеров не появится.`}
					/>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Сотрудник</Table.Head>
								<Table.Head>Направление</Table.Head>
								<Table.Head>С</Table.Head>
								<Table.Head>Назначил</Table.Head>
								{#if data.canAssign}
									<Table.Head class="text-right">Действия</Table.Head>
								{/if}
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each currentResponsibles as row (row.id)}
								<Table.Row>
									<Table.Cell>{row.userFullName}</Table.Cell>
									<Table.Cell>
										{#if row.directionName}
											{row.directionName}
										{:else}
											<StatusBadge tone="neutral">{words.whole}</StatusBadge>
										{/if}
									</Table.Cell>
									<Table.Cell>{formatDateTime(row.validFrom)}</Table.Cell>
									<Table.Cell>
										{#if row.assignedByFullName}
											{row.assignedByFullName}
										{:else}
											<span class="text-faint">—</span>
										{/if}
									</Table.Cell>
									{#if data.canAssign}
										<Table.Cell class="text-right">
											<Button variant="outline" size="sm" onclick={() => askRelease(row)}
												>Снять</Button
											>
										</Table.Cell>
									{/if}
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}

				{#if data.canAssign}
					<div class="border-t border-border px-4 py-3">
						<form
							method="POST"
							action="?/assignResponsible"
							class="flex flex-wrap items-end gap-3"
							data-testid="assign-responsible"
						>
							<!-- Списки — наши, а форме нужны обычные поля: значение каждого
							     уходит скрытым `input`. Сотрудника не сторожит `required`:
							     нативную проверку браузер пишет по-английски, а отказ «Не
							     выбран сотрудник» приходит с сервера и на русском. -->
							<div class="flex flex-col gap-1 text-xs">
								<Label for="assignUserId" class="text-xs font-medium">Сотрудник</Label>
								<input type="hidden" name="userId" value={assignUser?.id ?? ''} />
								<Select.Root type="single" bind:value={assignUserId}>
									<Select.Trigger id="assignUserId" class="min-w-56 text-sm">
										{assignUser?.fullName ?? '— выберите —'}
									</Select.Trigger>
									<Select.Content>
										{#each data.assignableUsers as user (user.id)}
											<Select.Item value={user.id} label={user.fullName} />
										{/each}
									</Select.Content>
								</Select.Root>
							</div>

							<div class="flex flex-col gap-1 text-xs">
								<Label for="assignDirectionId" class="text-xs font-medium">Направление</Label>
								<input type="hidden" name="directionId" value={assignDirection?.id ?? ''} />
								<Select.Root type="single" bind:value={assignDirectionId}>
									<Select.Trigger id="assignDirectionId" class="min-w-56 text-sm">
										{assignDirection?.name ?? words.whole}
									</Select.Trigger>
									<Select.Content>
										<!-- Общее назначение и назначения по направлениям на одном вузе
										     не сосуществуют, поэтому лишний вариант из списка убран. -->
										{#if !hasByDirection}
											<Select.Item value={WHOLE_ORGANIZATION} label={words.whole} />
										{/if}
										{#each data.directionOptions as direction (direction.id)}
											<Select.Item
												value={direction.id}
												label={direction.name}
												disabled={hasGeneral}
											/>
										{/each}
									</Select.Content>
								</Select.Root>
							</div>

							{#if data.canTransfer}
								<!-- Флажок ниже полей и выше кнопки: это условие отправки, а не
								     ещё одно поле формы. Снятый браузер не присылает вовсе,
								     поэтому сервер читает присутствие значения. -->
								<Label class="flex w-full items-start gap-2 font-normal">
									<Checkbox name="transferInteractions" value="true" checked class="mt-0.5" />
									<span class="flex flex-col gap-0.5">
										<span>Передать незавершённые взаимодействия новому ответственному</span>
										<span class="text-xs text-muted-foreground">
											Уйдут записи в работе, где {words.thisNominative} — основная сторона, а владелец
											— прежний ответственный; при назначении по направлению — только записи этого направления.
											Завершённые и отменённые остаются у тех, кто их вёл.
										</span>
									</span>
								</Label>
							{/if}

							<Button type="submit" size="sm">Назначить</Button>
						</form>

						{#if hasGeneral}
							<InlineHint class="mt-3">
								За {words.accusative} целиком уже кто-то отвечает: чтобы разделить по направлениям, сначала
								снимите общее назначение.
							</InlineHint>
						{/if}
					</div>
				{/if}

				{#if pastResponsibles.length > 0}
					<details class="border-t border-border px-4 py-3">
						<summary class="text-xs font-medium">
							История назначений ({pastResponsibles.length})
						</summary>
						<Table.Root class="mt-3">
							<Table.Header>
								<Table.Row>
									<Table.Head>Сотрудник</Table.Head>
									<Table.Head>Направление</Table.Head>
									<Table.Head>С</Table.Head>
									<Table.Head>По</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each pastResponsibles as row (row.id)}
									<Table.Row>
										<Table.Cell>{row.userFullName}</Table.Cell>
										<Table.Cell>{row.directionName ?? words.whole}</Table.Cell>
										<Table.Cell>{formatDateTime(row.validFrom)}</Table.Cell>
										<Table.Cell
											>{row.validTo === null ? '—' : formatDateTime(row.validTo)}</Table.Cell
										>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</details>
				{/if}
			</section>
		</div>

		<aside
			class="flex min-w-0 flex-col gap-5 rounded-xl border border-border bg-surface p-4 lg:col-start-2 lg:row-start-1"
			aria-label="Контекст"
		>
			<RequisitesPanel
				organization={data.organization}
				passportApplied={data.passportApplied}
				origin={data.origin}
			/>

			<ContactsList
				organizationId={data.organization.id}
				fromSite={isInstitution}
				affiliations={data.affiliations}
				{siteNames}
				canRead={data.canReadPeople}
				canWrite={data.canWritePeople}
				today={data.today}
				onclose={askClose}
			/>

			<div data-tour="organization-sites">
				<ContextSection title="Площадки">
					{#snippet action()}
						{#if data.canWrite}
							<Button
								variant="ghost"
								size="sm"
								href={resolve('/(app)/organizations/[id=uuid]/sites/new', {
									id: data.organization.id
								})}
							>
								<PlusIcon aria-hidden="true" />
								Добавить
							</Button>
						{/if}
					{/snippet}

					{#if data.sites.length === 0}
						<p class="text-sm text-muted-foreground">
							Площадок нет. {words.sitesEmpty} нужны, чтобы взаимодействие знало, где оно идёт.
						</p>
					{:else}
						<ul class="flex flex-col divide-y divide-border">
							{#each data.sites as site (site.id)}
								<li class="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
									<div class="min-w-0 flex-1">
										<p class="font-medium break-words">{site.name}</p>
										<p class="text-xs break-words text-muted-foreground">
											{SITE_KIND_LABELS[site.kind]}{site.address ? ` · ${site.address}` : ''}
										</p>
									</div>
									{#if data.canWrite}
										<Button
											variant="ghost"
											size="sm"
											href={resolve('/(app)/organizations/[id=uuid]/sites/[siteId=uuid]', {
												id: data.organization.id,
												siteId: site.id
											})}>Изменить</Button
										>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</ContextSection>
			</div>
		</aside>
	</div>
</div>

<form method="POST" action="?/archive" bind:this={archiveForm} hidden></form>
<form method="POST" action="?/restore" bind:this={restoreForm} hidden></form>

<ConfirmDialog
	bind:open={archiveOpen}
	title="Перевести организацию в архив?"
	description="Организация перестанет предлагаться в списках, но останется в истории взаимодействий и документов."
	confirmLabel="В архив"
	tone="danger"
	onconfirm={() => archiveForm?.requestSubmit()}
/>

<ConfirmDialog
	bind:open={restoreOpen}
	title="Вернуть организацию из архива?"
	description="Организация снова будет предлагаться в формах и списках выбора."
	confirmLabel="Вернуть"
	onconfirm={() => restoreForm?.requestSubmit()}
/>

<form method="POST" action="?/endAffiliation" bind:this={endForm} hidden>
	<input type="hidden" name="id" value={closing?.id ?? ''} />
	<input type="hidden" name="validTo" value={data.today} />
</form>

<ConfirmDialog
	bind:open={closeOpen}
	title="Закрыть полномочия?"
	description="Роль останется в истории: закроется её период — сегодняшним днём."
	confirmLabel="Закрыть полномочия"
	onconfirm={() => endForm?.requestSubmit()}
/>

<ConfirmDialog
	bind:open={releaseOpen}
	title="Снять ответственного?"
	description={releasing === null
		? undefined
		: `${releasing.userFullName} перестанет видеть ${words.thisAccusative} и взаимодействия ${words.byIt} сразу после снятия. Незавершённые записи, которые он ведёт сам, останутся у него.`}
	confirmLabel="Снять"
	tone="danger"
	onconfirm={() => releaseForm?.requestSubmit()}
/>

<form method="POST" action="?/releaseResponsible" bind:this={releaseForm} class="hidden">
	<input type="hidden" name="responsibleId" value={releasing?.id ?? ''} />
</form>
