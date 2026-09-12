<script lang="ts">
	import { resolve } from '$app/paths';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import ActionAlert from '$lib/components/directory/action-alert.svelte';
	import Flash from '$lib/components/directory/flash.svelte';
	import {
		AFFILIATION_ROLE_LABELS,
		EDUCATION_LEVEL_LABELS,
		ORGANIZATION_KIND_LABELS,
		ORGANIZATION_KIND_TONES,
		SITE_KIND_LABELS
	} from '$lib/components/directory/labels';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDate, formatNumber } from '$lib/format';
	import type { AffiliationView } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const siteNames = $derived(new Map(data.sites.map((site) => [site.id, site.name])));
	const masked = $derived(data.affiliations.some((row) => row.person.contactsMasked));

	let archiveForm = $state<HTMLFormElement | null>(null);
	let archiveOpen = $state(false);

	let endForm = $state<HTMLFormElement | null>(null);
	let closing = $state<AffiliationView | null>(null);
	let closeOpen = $state(false);

	function askClose(row: AffiliationView) {
		closing = row;
		closeOpen = true;
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
		affiliation_ended: 'Полномочия закрыты'
	}}
/>

<PageHeader
	title={data.organization.shortName}
	description={data.organization.legalName}
	breadcrumbs={[{ label: 'Организации', href: resolve('/(app)/organizations') }]}
>
	{#snippet actions()}
		{#if data.canWrite}
			<Button
				variant="outline"
				href={resolve('/(app)/organizations/[id]/edit', { id: data.organization.id })}
			>
				<PencilIcon aria-hidden="true" />
				Изменить
			</Button>
			{#if data.organization.isActive}
				<Button variant="outline" onclick={() => (archiveOpen = true)}>
					<ArchiveIcon aria-hidden="true" />
					В архив
				</Button>
			{/if}
		{/if}
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-4 p-4 sm:p-6">
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

	<section class="rounded-lg border border-border bg-surface">
		<header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
			<h2 class="text-sm font-semibold">Площадки</h2>
			{#if data.canWrite}
				<Button
					variant="outline"
					size="sm"
					href={resolve('/(app)/organizations/[id]/sites/new', { id: data.organization.id })}
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
										href={resolve('/(app)/organizations/[id]/sites/[siteId]', {
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

	<section class="rounded-lg border border-border bg-surface">
		<header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
			<h2 class="text-sm font-semibold">Контакты</h2>
			{#if data.canWritePeople}
				<Button
					variant="outline"
					size="sm"
					href={resolve('/(app)/organizations/[id]/affiliations/new', {
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
									href={resolve('/(app)/people/[id]', { id: row.person.id })}>{fullName(row)}</a
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

<ConfirmDialog
	bind:open={archiveOpen}
	title="Перевести организацию в архив?"
	description="Организация перестанет предлагаться в списках, но останется в истории взаимодействий и документов."
	confirmLabel="В архив"
	tone="danger"
	onconfirm={() => archiveForm?.requestSubmit()}
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
