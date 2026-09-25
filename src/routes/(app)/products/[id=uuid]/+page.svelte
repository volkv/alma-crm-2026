<script lang="ts">
	import { resolve } from '$app/paths';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { Button } from '$lib/components/ui/button/index.js';
	import Flash from '$lib/components/directory/flash.svelte';
	import {
		AFFILIATION_ROLE_LABELS,
		LIFECYCLE_STATUS_LABELS,
		LIFECYCLE_STATUS_TONES
	} from '$lib/components/directory/labels';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import { personFullName } from '$lib/components/organization-card/model';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const masked = $derived(data.contacts?.some((row) => row.person.contactsMasked) ?? false);
</script>

<svelte:head><title>{data.product.code} — Альма CRM</title></svelte:head>

<Flash messages={{ created: 'Продукт создан', updated: 'Изменения сохранены' }} />

<Header title={data.product.name} description={data.product.code}>
	{#snippet actions()}
		{#if data.canWrite}
			<Button
				variant="outline"
				href={resolve('/(app)/products/[id=uuid]/edit', { id: data.product.id })}
			>
				<PencilIcon aria-hidden="true" />
				Изменить
			</Button>
		{/if}
	{/snippet}
</Header>

<Breadcrumbs
	items={[{ label: 'Продукты', href: resolve('/(app)/products') }, { label: data.product.name }]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<section
		class="rounded-lg border border-border bg-surface p-4 sm:p-6"
		data-tour="product-summary"
	>
		<h2 class="mb-4 text-sm font-semibold">Продукт</h2>
		<KeyValue>
			<KeyValueRow label="Код" value={data.product.code} />
			<KeyValueRow label="Состояние">
				<StatusBadge tone={LIFECYCLE_STATUS_TONES[data.product.status]} dot>
					{LIFECYCLE_STATUS_LABELS[data.product.status]}
				</StatusBadge>
			</KeyValueRow>
			<KeyValueRow label="Вендор">
				{#if data.vendor}
					<a
						class="underline underline-offset-2 focus-ring"
						href={resolve('/(app)/organizations/[id=uuid]', { id: data.vendor.id })}
						>{data.vendor.label}</a
					>
				{:else}
					<span class="text-faint">—</span>
				{/if}
			</KeyValueRow>
		</KeyValue>

		{#if data.product.description}
			<p class="mt-4 text-sm whitespace-pre-line">{data.product.description}</p>
		{/if}
	</section>

	<section
		class="rounded-lg border border-border bg-surface p-4 sm:p-6"
		data-tour="product-contacts"
	>
		<h2 class="mb-4 text-sm font-semibold">Контакты вендора по продукту</h2>
		{#if data.contacts === null}
			<p class="text-sm text-muted-foreground">
				Контакты закрыты правами: нужно право «Просмотр людей и их ролей в организациях».
			</p>
		{:else if data.contacts.length === 0}
			<p class="text-sm text-muted-foreground">
				Контактов по продукту нет. Их заводит импорт вендоров на странице «Импорт каталога».
			</p>
		{:else}
			{#if masked}
				<InlineHint tone="info">
					Почта и телефон закрыты: полные контакты видны с правом «Просмотр контактов людей без
					маскирования».
				</InlineHint>
			{/if}
			<ul class="flex flex-col divide-y divide-border">
				{#each data.contacts as row (row.person.id)}
					<li class="flex flex-col gap-0.5 py-2 text-sm">
						<a
							class="w-fit font-medium break-words underline-offset-2 focus-ring hover:underline"
							href={resolve('/(app)/people/[id=uuid]', { id: row.person.id })}
							>{personFullName(row)}</a
						>
						{#if row.position !== null}
							<p class="break-words">{row.position}</p>
						{/if}
						<p class="text-xs text-muted-foreground">
							{row.roleKind === null
								? 'Роли у вендора продукта нет'
								: AFFILIATION_ROLE_LABELS[row.roleKind]}{row.channel === null
								? ''
								: ` · способ связи: ${row.channel}`}
						</p>
						{#if row.person.email || row.person.phone}
							<p class="text-xs break-all text-muted-foreground">
								{[row.person.email, row.person.phone].filter(Boolean).join(' · ')}
							</p>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
