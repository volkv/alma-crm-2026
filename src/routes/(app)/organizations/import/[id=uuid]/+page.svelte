<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { filterHref } from '$lib/components/directory/query';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import {
		CATALOG_IMPORT_STATUS_LABELS,
		CATALOG_ROW_ACTIONS,
		CATALOG_ROW_ACTION_DONE_LABELS,
		DIRECTORY_IMPORT_KIND_LABELS,
		DIRECTORY_IMPORT_KIND_SUBJECTS,
		type CatalogRowAction
	} from '$lib/contracts/directory-import';
	import { formatDateTime, formatNumber, pluralize } from '$lib/format';
	import RowsTable from '../rows-table.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const done = $derived(data.record.status === 'confirmed');

	const title = $derived(`Загрузка ${DIRECTORY_IMPORT_KIND_SUBJECTS[data.record.kind]}`);

	const COUNT_OF: Record<CatalogRowAction, (record: typeof data.record) => number> = {
		create: (record) => record.createCount,
		update: (record) => record.updateCount,
		unchanged: (record) => record.unchangedCount,
		error: (record) => record.errorCount
	};

	const actionHref = (action: CatalogRowAction | null) =>
		filterHref(page.url, 'action', action ?? '');

	const confirmedAt = $derived(
		data.record.confirmedAt === null ? null : formatDateTime(data.record.confirmedAt)
	);
</script>

<svelte:head><title>{title} — Альма CRM</title></svelte:head>

<Header {title} description="Что этот файл сделал со справочником — построчно.">
	{#snippet actions()}
		<Button variant="outline" href={resolve('/(app)/organizations/import')}>
			Загрузить ещё файл
		</Button>
	{/snippet}
</Header>

<Breadcrumbs
	items={[
		{ label: 'Организации', href: resolve('/(app)/organizations') },
		{
			label: `Импорт ${DIRECTORY_IMPORT_KIND_SUBJECTS[data.record.kind]}`,
			href: resolve('/(app)/organizations/import')
		},
		{ label: title }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<div class="flex flex-wrap items-center gap-2">
		<StatusBadge
			tone={done ? 'success' : data.record.status === 'rejected' ? 'danger' : 'neutral'}
			dot
		>
			{CATALOG_IMPORT_STATUS_LABELS[data.record.status]}
		</StatusBadge>
		<span class="text-sm text-muted-foreground">
			{pluralize(data.record.rowCount, ['строка', 'строки', 'строк'])} в файле
		</span>
	</div>

	<KeyValue>
		<KeyValueRow label="Файл" value={data.record.fileName} />
		<KeyValueRow label="Вид загрузки" value={DIRECTORY_IMPORT_KIND_LABELS[data.record.kind]} />
		<KeyValueRow label="Загрузил" value={data.record.authorName} />
		<KeyValueRow label="Загружено" value={formatDateTime(data.record.createdAt)} />
		<KeyValueRow label="Применено" value={confirmedAt} />
		<!-- У отклонённой загрузки в примечании — причина отказа (так его пишет
			`rejectCatalogImport`): подпись говорит, что это за текст. -->
		<KeyValueRow
			label={data.record.status === 'rejected' ? 'Причина отказа' : 'Примечание'}
			value={data.record.note}
		/>
	</KeyValue>

	<div class="grid gap-3 sm:grid-cols-4" data-tour="organizations-import-run-counts">
		{#each CATALOG_ROW_ACTIONS as action (action)}
			<div class="rounded-lg border border-border bg-surface p-4">
				<p class="text-xs text-muted-foreground">{CATALOG_ROW_ACTION_DONE_LABELS[action]}</p>
				<p
					class="text-xl font-semibold {action === 'error' && data.record.errorCount > 0
						? 'text-danger'
						: ''}"
					data-slot="count-{action}"
				>
					{formatNumber(COUNT_OF[action](data.record))}
				</p>
			</div>
		{/each}
	</div>

	<div class="flex flex-wrap items-center gap-2" data-tour="organizations-import-run-rows">
		<Button
			variant={data.action === null ? 'secondary' : 'outline'}
			size="sm"
			href={actionHref(null)}
		>
			Все строки
		</Button>
		{#each CATALOG_ROW_ACTIONS as action (action)}
			<Button
				variant={data.action === action ? 'secondary' : 'outline'}
				size="sm"
				href={actionHref(action)}
			>
				{CATALOG_ROW_ACTION_DONE_LABELS[action]}
			</Button>
		{/each}
		<span class="text-sm text-muted-foreground">
			Показано {pluralize(data.shown, ['строка', 'строки', 'строк'])} из {formatNumber(data.total)}
		</span>
	</div>

	<RowsTable
		rows={data.rows}
		kind={data.record.kind}
		status={data.record.status}
		emptyTitle="Строк нет"
		emptyDescription="Под этот фильтр не подошла ни одна строка."
	/>
</div>
