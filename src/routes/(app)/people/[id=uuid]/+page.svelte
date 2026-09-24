<script lang="ts">
	import { resolve } from '$app/paths';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import ActionAlert from '$lib/components/directory/action-alert.svelte';
	import Flash from '$lib/components/directory/flash.svelte';
	import { AFFILIATION_ROLE_LABELS } from '$lib/components/directory/labels';
	import PersonalDataPanel from '$lib/components/directory/personal-data-panel.svelte';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDate } from '$lib/format';
	import type { PersonAffiliationView } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const fullName = $derived(
		[data.person.lastName, data.person.firstName, data.person.middleName]
			.filter((part) => part !== null && part !== '')
			.join(' ')
	);

	let endForm = $state<HTMLFormElement | null>(null);
	let closing = $state<PersonAffiliationView | null>(null);
	let closeOpen = $state(false);

	function askClose(row: PersonAffiliationView) {
		closing = row;
		closeOpen = true;
	}
</script>

<svelte:head><title>{fullName} — Альма CRM</title></svelte:head>

<Flash
	messages={{
		created: 'Человек заведён',
		updated: 'Изменения сохранены',
		affiliation_created: 'Роль добавлена',
		affiliation_ended: 'Полномочия закрыты',
		retention_changed: 'Срок хранения сохранён',
		consent_recorded: 'Согласие зафиксировано',
		consent_withdrawn: 'Согласие отозвано',
		anonymized: 'Данные обезличены'
	}}
/>

<Header title={fullName}>
	{#snippet actions()}
		<!-- Обезличенную запись не правят: стёртые данные не возвращают той же
			строкой, и кнопка, которая это предлагает, врёт. -->
		{#if data.canWrite && data.person.anonymizedAt === null}
			<Button
				variant="outline"
				href={resolve('/(app)/people/[id=uuid]/edit', { id: data.person.id })}
			>
				<PencilIcon aria-hidden="true" />
				Изменить
			</Button>
		{/if}
	{/snippet}
</Header>

<Breadcrumbs items={[{ label: 'Контакты', href: resolve('/(app)/people') }, { label: fullName }]} />

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<ActionAlert />

	<section
		class="rounded-lg border border-border bg-surface p-4 sm:p-6"
		data-tour="person-contacts"
	>
		<h2 class="mb-4 section-title">Контактные данные</h2>
		<KeyValue>
			<KeyValueRow label="Почта" value={data.person.email} />
			<KeyValueRow label="Телефон" value={data.person.phone} />
		</KeyValue>

		{#if data.person.contactsMasked}
			<div class="mt-4">
				<InlineHint tone="info">
					Контакты показаны закрытыми: полные значения видны с правом «Просмотр контактов людей без
					маскирования».
				</InlineHint>
			</div>
		{/if}

		{#if data.person.notes}
			<p class="mt-4 text-sm whitespace-pre-line">{data.person.notes}</p>
		{/if}
	</section>

	{#if data.managesPii}
		<PersonalDataPanel
			person={data.person}
			consents={data.consents}
			today={data.today}
			anonymize={data.anonymize}
		/>
	{/if}

	<section class="rounded-lg border border-border bg-surface" data-tour="person-affiliations">
		<header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
			<h2 class="section-title">Роли в организациях</h2>
			{#if data.canWrite}
				<Button
					variant="outline"
					size="sm"
					href={resolve('/(app)/people/[id=uuid]/affiliations/new', { id: data.person.id })}
				>
					<PlusIcon aria-hidden="true" />
					Добавить роль
				</Button>
			{/if}
		</header>

		{#if data.affiliations.length === 0}
			<EmptyState
				title="Ролей пока нет"
				description="Роль связывает человека с организацией: должность, период полномочий и канал связи."
			/>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head>Организация</Table.Head>
						<Table.Head>Должность</Table.Head>
						<Table.Head>Роль</Table.Head>
						<Table.Head>Площадка</Table.Head>
						<Table.Head>Период</Table.Head>
						<Table.Head class="w-28"></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.affiliations as row (row.affiliation.id)}
						<Table.Row class="h-row">
							<Table.Cell class="font-medium">
								<a
									class="underline underline-offset-2 focus-ring"
									href={resolve('/(app)/organizations/[id=uuid]', { id: row.organization.id })}
									>{row.organization.label}</a
								>
								{#if row.affiliation.isPrimary}
									<StatusBadge tone="accent" class="ml-2">основной</StatusBadge>
								{/if}
							</Table.Cell>
							<Table.Cell>{row.affiliation.position}</Table.Cell>
							<Table.Cell>{AFFILIATION_ROLE_LABELS[row.affiliation.roleKind]}</Table.Cell>
							<Table.Cell>{row.site?.label ?? '—'}</Table.Cell>
							<Table.Cell>
								{formatDate(row.affiliation.validFrom)} — {row.affiliation.validTo === null
									? 'по настоящее время'
									: formatDate(row.affiliation.validTo)}
							</Table.Cell>
							<Table.Cell class="text-right">
								{#if data.canWrite && row.affiliation.validTo === null}
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

<form method="POST" action="?/endAffiliation" bind:this={endForm} hidden>
	<input type="hidden" name="id" value={closing?.affiliation.id ?? ''} />
	<input type="hidden" name="validTo" value={data.today} />
</form>

<ConfirmDialog
	bind:open={closeOpen}
	title="Закрыть полномочия?"
	description="Роль останется в истории: закроется её период — сегодняшним днём."
	confirmLabel="Закрыть полномочия"
	onconfirm={() => endForm?.requestSubmit()}
/>
