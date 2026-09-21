<script lang="ts">
	import { resolve } from '$app/paths';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import ActionAlert from '$lib/components/directory/action-alert.svelte';
	import ContractsPanel from '$lib/components/directory/contracts-panel.svelte';
	import Flash from '$lib/components/directory/flash.svelte';
	import {
		AFFILIATION_ROLE_LABELS,
		EDUCATION_LEVEL_LABELS,
		ORGANIZATION_KIND_LABELS,
		ORGANIZATION_KIND_TONES,
		SITE_KIND_LABELS
	} from '$lib/components/directory/labels';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDate, formatDateTime, formatNumber } from '$lib/format';
	import type { AffiliationView } from '$lib/contracts/directory';
	import type { ResponsibleView } from '$lib/server/directory/responsibles';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const siteNames = $derived(new Map(data.sites.map((site) => [site.id, site.name])));
	const masked = $derived(data.affiliations.some((row) => row.person.contactsMasked));

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
	const WHOLE_ORGANIZATION_LABEL = 'весь вуз';

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

	function fullName(row: AffiliationView) {
		return [row.person.lastName, row.person.firstName, row.person.middleName]
			.filter((part) => part !== null && part !== '')
			.join(' ');
	}
</script>

<svelte:head><title>{data.organization.shortName} — LCT CRM</title></svelte:head>

<Flash
	messages={{
		created: 'Организация создана',
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

<Header title={data.organization.shortName} description={data.organization.legalName}>
	{#snippet actions()}
		{#if data.canWrite}
			<Button
				variant="outline"
				href={resolve('/(app)/organizations/[id=uuid]/edit', { id: data.organization.id })}
			>
				<PencilIcon aria-hidden="true" />
				Изменить
			</Button>
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
	{/snippet}
</Header>

<Breadcrumbs
	items={[
		{ label: 'Организации', href: resolve('/(app)/organizations') },
		{ label: data.organization.shortName }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<ActionAlert />

	<section class="rounded-lg border border-border bg-surface p-4 sm:p-6">
		<h2 class="mb-4 text-sm font-semibold">Реквизиты</h2>
		<KeyValue>
			<KeyValueRow label="Вид">
				<StatusBadge tone={ORGANIZATION_KIND_TONES[data.organization.kind]}>
					{ORGANIZATION_KIND_LABELS[data.organization.kind]}
				</StatusBadge>
			</KeyValueRow>
			<KeyValueRow
				label="Уровень образования"
				value={data.organization.educationLevel === null
					? null
					: EDUCATION_LEVEL_LABELS[data.organization.educationLevel]}
			/>
			<KeyValueRow label="ИНН" value={data.organization.inn} />
			<KeyValueRow label="КПП" value={data.organization.kpp} />
			<KeyValueRow label="ОГРН" value={data.organization.ogrn} />
			<KeyValueRow label="Регион" value={data.organization.region} />
			<KeyValueRow label="Сайт">
				{#if data.organization.website}
					<a
						class="underline underline-offset-2 focus-ring"
						href={data.organization.website}
						rel="external noreferrer noopener"
						target="_blank">{data.organization.website}</a
					>
				{:else}
					<span class="text-faint">—</span>
				{/if}
			</KeyValueRow>
			<KeyValueRow label="Состояние">
				{#if data.organization.isActive}
					<StatusBadge tone="success" dot>Активна</StatusBadge>
				{:else}
					<StatusBadge tone="neutral" dot>В архиве</StatusBadge>
				{/if}
			</KeyValueRow>
			<KeyValueRow label="Взаимодействия">
				{#if data.interactionCount === null}
					<span class="text-faint">нет доступа</span>
				{:else}
					<a
						class="underline underline-offset-2 focus-ring"
						href={resolve(`/interactions?organization=${data.organization.id}`)}
					>
						{formatNumber(data.interactionCount)}
					</a>
				{/if}
			</KeyValueRow>
			<KeyValueRow label="Обновлено" value={formatDate(data.organization.updatedAt)} />
		</KeyValue>

		{#if data.organization.notes}
			<p class="mt-4 text-sm whitespace-pre-line">{data.organization.notes}</p>
		{/if}
	</section>

	<section class="rounded-lg border border-border bg-surface" data-tour="organization-responsibles">
		<header class="border-b border-border px-4 py-3">
			<h2 class="text-sm font-semibold">Ответственные</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				Кто ведёт вуз. От этого зависит, кто видит его карточку и взаимодействия по нему: назначение
				действует немедленно, а снятое закрывается точной меткой времени и остаётся в истории.
			</p>
		</header>

		{#if currentResponsibles.length === 0}
			<EmptyState
				title="Ответственного нет"
				description="Вуз не закреплён ни за кем: в списках менеджеров он не появится."
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
									<StatusBadge tone="neutral">весь вуз</StatusBadge>
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
									<Button variant="outline" size="sm" onclick={() => askRelease(row)}>Снять</Button>
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
								{assignDirection?.name ?? WHOLE_ORGANIZATION_LABEL}
							</Select.Trigger>
							<Select.Content>
								<!-- Общее назначение и назначения по направлениям на одном вузе
								     не сосуществуют, поэтому лишний вариант из списка убран. -->
								{#if !hasByDirection}
									<Select.Item value={WHOLE_ORGANIZATION} label={WHOLE_ORGANIZATION_LABEL} />
								{/if}
								{#each data.directionOptions as direction (direction.id)}
									<Select.Item value={direction.id} label={direction.name} disabled={hasGeneral} />
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
									Уйдут записи в работе, где этот вуз — основная сторона, а владелец — прежний
									ответственный; при назначении по направлению — только записи этого направления.
									Завершённые и отменённые остаются у тех, кто их вёл.
								</span>
							</span>
						</Label>
					{/if}

					<Button type="submit" size="sm">Назначить</Button>
				</form>

				{#if hasGeneral}
					<InlineHint class="mt-3">
						За вуз целиком уже кто-то отвечает: чтобы разделить его по направлениям, сначала снимите
						общее назначение.
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
								<Table.Cell>{row.directionName ?? 'весь вуз'}</Table.Cell>
								<Table.Cell>{formatDateTime(row.validFrom)}</Table.Cell>
								<Table.Cell>{row.validTo === null ? '—' : formatDateTime(row.validTo)}</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</details>
		{/if}
	</section>

	<section class="rounded-lg border border-border bg-surface" data-tour="organization-sites">
		<header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
			<h2 class="text-sm font-semibold">Площадки</h2>
			{#if data.canWrite}
				<Button
					variant="outline"
					size="sm"
					href={resolve('/(app)/organizations/[id=uuid]/sites/new', { id: data.organization.id })}
				>
					<PlusIcon aria-hidden="true" />
					Добавить площадку
				</Button>
			{/if}
		</header>

		{#if data.sites.length === 0}
			<EmptyState
				title="Площадок пока нет"
				description="Кампусы, филиалы и подразделения нужны, чтобы взаимодействие знало, где оно идёт."
			/>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head>Название</Table.Head>
						<Table.Head>Вид</Table.Head>
						<Table.Head>Адрес</Table.Head>
						<Table.Head>Регион</Table.Head>
						<Table.Head class="w-24"></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.sites as site (site.id)}
						<Table.Row class="h-row">
							<Table.Cell class="font-medium">{site.name}</Table.Cell>
							<Table.Cell>{SITE_KIND_LABELS[site.kind]}</Table.Cell>
							<Table.Cell>{site.address ?? '—'}</Table.Cell>
							<Table.Cell>{site.region ?? '—'}</Table.Cell>
							<Table.Cell class="text-right">
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
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</section>

	<ContractsPanel
		contracts={data.contracts}
		products={data.productOptions}
		canWrite={data.canWrite}
	/>

	<section class="rounded-lg border border-border bg-surface" data-tour="organization-contacts">
		<header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
			<h2 class="text-sm font-semibold">Контакты</h2>
			{#if data.canWritePeople}
				<Button
					variant="outline"
					size="sm"
					href={resolve('/(app)/organizations/[id=uuid]/affiliations/new', {
						id: data.organization.id
					})}
				>
					<PlusIcon aria-hidden="true" />
					Добавить контакт
				</Button>
			{/if}
		</header>

		{#if !data.canReadPeople}
			<EmptyState
				title="Контакты закрыты правами"
				description="Нужно право «Просмотр людей и их ролей в организациях»."
			/>
		{:else if data.affiliations.length === 0}
			<EmptyState
				title="Контактов пока нет"
				description="Добавьте человека, с которым идёт переписка по процессу."
			/>
		{:else}
			{#if masked}
				<div class="px-4 pt-3">
					<InlineHint tone="info">
						Почта и телефон показаны закрытыми: полные контакты видны с правом «Просмотр контактов
						людей без маскирования».
					</InlineHint>
				</div>
			{/if}
			<Table.Root>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head>Человек</Table.Head>
						<Table.Head>Должность</Table.Head>
						<Table.Head>Роль</Table.Head>
						<Table.Head>Площадка</Table.Head>
						<Table.Head>Период</Table.Head>
						<Table.Head>Контакты</Table.Head>
						<Table.Head class="w-28"></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.affiliations as row (row.id)}
						<Table.Row class="h-row">
							<Table.Cell class="font-medium">
								<a
									class="underline underline-offset-2 focus-ring"
									href={resolve('/(app)/people/[id=uuid]', { id: row.person.id })}
									>{fullName(row)}</a
								>
								{#if row.isPrimary}
									<StatusBadge tone="accent" class="ml-2">основной</StatusBadge>
								{/if}
							</Table.Cell>
							<Table.Cell>{row.position}</Table.Cell>
							<Table.Cell>{AFFILIATION_ROLE_LABELS[row.roleKind]}</Table.Cell>
							<Table.Cell
								>{row.siteId === null ? '—' : (siteNames.get(row.siteId) ?? '—')}</Table.Cell
							>
							<Table.Cell>
								{formatDate(row.validFrom)} — {row.validTo === null
									? 'по настоящее время'
									: formatDate(row.validTo)}
							</Table.Cell>
							<Table.Cell class="text-xs">
								<div>{row.person.email ?? '—'}</div>
								<div class="text-muted-foreground">{row.person.phone ?? '—'}</div>
							</Table.Cell>
							<Table.Cell class="text-right">
								{#if data.canWritePeople && row.validTo === null}
									<Button variant="ghost" size="sm" onclick={() => askClose(row)}>Закрыть</Button>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</section>
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
		: `${releasing.userFullName} перестанет видеть этот вуз и взаимодействия по нему сразу после снятия. Незавершённые записи, которые он ведёт сам, останутся у него.`}
	confirmLabel="Снять"
	tone="danger"
	onconfirm={() => releaseForm?.requestSubmit()}
/>

<form method="POST" action="?/releaseResponsible" bind:this={releaseForm} class="hidden">
	<input type="hidden" name="responsibleId" value={releasing?.id ?? ''} />
</form>
