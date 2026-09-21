<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button/index.js';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import { filterHref } from '$lib/components/directory/query';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import RowsTable from '$lib/components/stats/rows-table.svelte';
	import { STAT_SNAPSHOT_STATUS_TONES } from '$lib/components/stats/labels';
	import {
		isEmptyCoverage,
		STAT_FIELD_LABELS,
		STAT_SNAPSHOT_MODE_HINTS,
		STAT_SNAPSHOT_MODE_LABELS,
		STAT_SNAPSHOT_STATUS_LABELS,
		STAT_PERIOD_KIND_LABELS,
		STAT_SOURCE_LABELS
	} from '$lib/contracts/stats';
	import { formatDate, formatDateTime, formatNumber, pluralize } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const snapshot = $derived(data.snapshot);
	const mappedColumns = $derived(Object.entries(snapshot.mapping));

	/** Ссылка на тот же экран с другим фильтром: список — это адрес. */
	const issuesHref = (onlyIssues: boolean) => filterHref(page.url, 'issues', onlyIssues ? '1' : '');
</script>

<svelte:head><title>Снимок данных — LCT CRM</title></svelte:head>

<Header
	title="Снимок данных: {STAT_SOURCE_LABELS[snapshot.source]}"
	description={snapshot.fileName ?? 'Загрузка без файла'}
>
	{#snippet actions()}
		<StatusBadge tone={STAT_SNAPSHOT_STATUS_TONES[snapshot.status]}>
			{STAT_SNAPSHOT_STATUS_LABELS[snapshot.status]}
		</StatusBadge>
		{#if snapshot.isCurrent}
			<StatusBadge tone="accent" dot title="Учитывается в показателях">Текущий</StatusBadge>
		{/if}
		{#if snapshot.fileDocumentId}
			<Button
				variant="outline"
				href={resolve('/(app)/documents/[id=uuid]/download', { id: snapshot.fileDocumentId })}
			>
				<DownloadIcon aria-hidden="true" />
				Скачать файл
			</Button>
		{/if}
		{#if data.canImport && (snapshot.status === 'uploading' || snapshot.status === 'mapped')}
			<Button href={resolve('/(app)/data/[id=uuid]/mapping', { id: snapshot.id })}>
				Продолжить загрузку
			</Button>
		{:else if data.canImport && snapshot.status === 'validated'}
			<Button href={resolve('/(app)/data/[id=uuid]/check', { id: snapshot.id })}>
				К проверке и подтверждению
			</Button>
		{/if}
	{/snippet}
</Header>

<Breadcrumbs
	items={[
		{ label: 'Данные об обучении', href: resolve('/(app)/data') },
		{ label: `Снимок данных: ${STAT_SOURCE_LABELS[snapshot.source]}` }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<div class="rounded-lg border border-border bg-surface p-4" data-tour="data-snapshot-summary">
		<KeyValue>
			<KeyValueRow label="Источник">{STAT_SOURCE_LABELS[snapshot.source]}</KeyValueRow>
			<KeyValueRow label="Режим">
				{STAT_SNAPSHOT_MODE_LABELS[snapshot.mode]}
				<span class="block text-xs text-muted-foreground">
					{STAT_SNAPSHOT_MODE_HINTS[snapshot.mode]}
				</span>
			</KeyValueRow>
			<KeyValueRow label="Период">
				{formatDate(snapshot.periodStart)} — {formatDate(snapshot.periodEnd)}
				<span class="block text-xs text-muted-foreground">
					{STAT_PERIOD_KIND_LABELS[snapshot.periodKind]}
				</span>
			</KeyValueRow>
			<KeyValueRow label="Область покрытия">
				{#if isEmptyCoverage(snapshot.coverage)}
					Всё, что есть в файле
				{:else}
					{pluralize(snapshot.coverageSize, ['запись', 'записи', 'записей'])} справочника
				{/if}
			</KeyValueRow>
			<KeyValueRow label="Строк">
				{formatNumber(snapshot.rowCount)}, с ошибками {formatNumber(snapshot.errorCount)}
			</KeyValueRow>
			<KeyValueRow label="Загрузил">
				{snapshot.authorName ?? '—'}
				<span class="block text-xs text-muted-foreground">
					{formatDateTime(snapshot.createdAt)}
				</span>
			</KeyValueRow>
			{#if snapshot.confirmedAt}
				<KeyValueRow label="Подтверждён">{formatDateTime(snapshot.confirmedAt)}</KeyValueRow>
			{/if}
			{#if data.supersedes}
				<KeyValueRow label="Замещает">
					<a
						class="underline underline-offset-4 focus-ring hover:no-underline"
						href={resolve('/(app)/data/[id=uuid]', { id: data.supersedes.id })}
					>
						Выгрузку от {formatDateTime(data.supersedes.createdAt)}
					</a>
				</KeyValueRow>
			{/if}
			{#if snapshot.note}
				<KeyValueRow label="Примечание">{snapshot.note}</KeyValueRow>
			{/if}
		</KeyValue>
	</div>

	{#if mappedColumns.length > 0}
		<div class="rounded-lg border border-border bg-surface p-4">
			<h2 class="text-sm font-medium">Сопоставление колонок</h2>
			<ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
				{#each mappedColumns as [column, field] (column)}
					<li><span class="text-foreground">{column}</span> → {STAT_FIELD_LABELS[field]}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<div class="flex flex-wrap items-center gap-2" data-tour="data-snapshot-rows">
		<Button variant={data.onlyIssues ? 'outline' : 'secondary'} size="sm" href={issuesHref(false)}>
			Все строки
		</Button>
		<Button variant={data.onlyIssues ? 'secondary' : 'outline'} size="sm" href={issuesHref(true)}>
			Только с ошибками
		</Button>
		<span class="text-sm text-muted-foreground">
			Показано {pluralize(data.shown, ['строка', 'строки', 'строк'])} из {formatNumber(data.total)}
		</span>
	</div>

	<RowsTable
		rows={data.rows}
		emptyTitle={data.onlyIssues ? 'Ошибок нет' : 'Строк нет'}
		emptyDescription={data.onlyIssues
			? 'Все строки снимка разобрались.'
			: 'Колонки ещё не сопоставлены: строки появятся после второго шага загрузки.'}
	/>
</div>
