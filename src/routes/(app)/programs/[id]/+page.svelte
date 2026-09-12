<script lang="ts">
	import { resolve } from '$app/paths';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import Flash from '$lib/components/directory/flash.svelte';
	import {
		LIFECYCLE_STATUS_LABELS,
		LIFECYCLE_STATUS_TONES,
		PROGRAM_LEVEL_LABELS
	} from '$lib/components/directory/labels';
	import EmptyState from '$lib/components/empty-state.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDate } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>{data.program.code} — LCT CRM</title></svelte:head>

<Flash
	messages={{
		created: 'Программа создана',
		updated: 'Изменения сохранены',
		version_created: 'Версия добавлена'
	}}
/>

<PageHeader
	title={data.program.name}
	description={data.program.code}
	breadcrumbs={[{ label: 'Программы', href: resolve('/(app)/programs') }]}
>
	{#snippet actions()}
		{#if data.canWrite}
			<Button
				variant="outline"
				href={resolve('/(app)/programs/[id]/edit', { id: data.program.id })}
			>
				<PencilIcon aria-hidden="true" />
				Изменить
			</Button>
			<Button href={resolve('/(app)/programs/[id]/versions/new', { id: data.program.id })}>
				<PlusIcon aria-hidden="true" />
				Новая версия
			</Button>
		{/if}
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<section class="rounded-lg border border-border bg-surface p-4 sm:p-6">
		<h2 class="mb-4 text-sm font-semibold">Программа</h2>
		<KeyValue>
			<KeyValueRow label="Код" value={data.program.code} />
			<KeyValueRow label="Уровень" value={PROGRAM_LEVEL_LABELS[data.program.level]} />
			<KeyValueRow label="Направление подготовки" value={data.program.directionCode} />
			<KeyValueRow label="Состояние">
				<StatusBadge tone={LIFECYCLE_STATUS_TONES[data.program.status]} dot>
					{LIFECYCLE_STATUS_LABELS[data.program.status]}
				</StatusBadge>
			</KeyValueRow>
		</KeyValue>
	</section>

	<section class="rounded-lg border border-border bg-surface">
		<header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
			<h2 class="text-sm font-semibold">Версии</h2>
		</header>

		{#if data.versions.length === 0}
			<EmptyState
				title="Версий пока нет"
				description="Версия фиксирует, что именно предлагалось вузу и с какого дня."
			/>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head class="w-24">Версия</Table.Head>
						<Table.Head class="w-36">Действует с</Table.Head>
						<Table.Head>Что изменилось</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.versions as version (version.id)}
						<Table.Row class="h-row">
							<Table.Cell class="font-medium">в. {version.version}</Table.Cell>
							<Table.Cell>{formatDate(version.effectiveFrom)}</Table.Cell>
							<Table.Cell class="whitespace-pre-line">{version.summary}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</section>
</div>
