<script lang="ts">
	import { resolve } from '$app/paths';
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import { Button } from '$lib/components/ui/button/index.js';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FilterSelect from '$lib/components/directory/filter-select.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { FieldOption } from '$lib/components/form/field-select.svelte';
	import {
		documentFormat,
		DOCUMENT_FORMATS,
		type DocumentListItem
	} from '$lib/contracts/documents';
	import { formatDate, formatDateTime, formatNumber } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const KIND_OPTIONS: readonly FieldOption[] = [
		{ value: 'uploaded', label: 'Загружен' },
		{ value: 'generated', label: 'Сгенерирован' }
	];

	/** Формат человек называет расширением, а не типом: «DOCX», не «…wordprocessingml». */
	const FORMAT_OPTIONS: readonly FieldOption[] = DOCUMENT_FORMATS.map((format) => ({
		value: format,
		label: format.toUpperCase()
	}));

	const FACT_OPTIONS: readonly FieldOption[] = [
		{ value: 'agreed', label: 'Согласован' },
		{ value: 'approved', label: 'Утверждён' },
		{ value: 'in_effect', label: 'Введён в действие' },
		{ value: 'none', label: 'Без отметок' }
	];

	/**
	 * Размер файла словами. Читать «2 411 059 байт» человек не умеет, а решение
	 * «скачивать ли это сейчас» принимает именно по размеру.
	 */
	const SIZE_UNITS = ['Б', 'КБ', 'МБ'] as const;
	const sizeFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

	function formatSize(bytes: number): string {
		let value = bytes;
		let unit = 0;

		while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
			value /= 1024;
			unit += 1;
		}

		return `${sizeFormat.format(value)} ${SIZE_UNITS[unit]}`;
	}

	const columns: ColumnDef<DataTableFeatures, DocumentListItem>[] = [
		{
			id: 'title',
			accessorFn: (row) => row.title,
			header: 'Название',
			meta: { title: 'Название' },
			enableHiding: false,
			cell: ({ row }) => renderSnippet(titleCell, row.original)
		},
		{
			id: 'kind',
			accessorFn: (row) => row.kind,
			header: 'Вид',
			meta: { title: 'Вид' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(kindCell, row.original)
		},
		{
			id: 'interaction',
			accessorFn: (row) => row.interaction?.title ?? '',
			header: 'Взаимодействие',
			meta: { title: 'Взаимодействие' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(interactionCell, row.original)
		},
		{
			id: 'format',
			accessorFn: (row) => row.mime,
			header: 'Формат',
			meta: { title: 'Формат' },
			cell: ({ row }) => documentFormat(row.original.mime)?.toUpperCase() ?? '—'
		},
		{
			id: 'sizeBytes',
			accessorFn: (row) => row.sizeBytes,
			header: 'Размер',
			meta: { title: 'Размер', align: 'end' },
			cell: ({ row }) => formatSize(row.original.sizeBytes)
		},
		{
			id: 'facts',
			header: 'Отметки',
			meta: { title: 'Отметки' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(factsCell, row.original)
		},
		{
			id: 'author',
			accessorFn: (row) => row.authorName ?? '',
			header: 'Загрузил',
			meta: { title: 'Загрузил' },
			enableSorting: false,
			cell: ({ row }) => row.original.authorName ?? '—'
		},
		{
			id: 'createdAt',
			accessorFn: (row) => row.createdAt,
			header: 'Дата',
			meta: { title: 'Дата' },
			cell: ({ row }) => formatDateTime(row.original.createdAt)
		},
		{
			id: 'download',
			header: '',
			meta: { title: 'Скачивание', align: 'end' },
			enableSorting: false,
			enableHiding: false,
			cell: ({ row }) => renderSnippet(downloadCell, row.original)
		}
	];
</script>

{#snippet titleCell(row: DocumentListItem)}
	<!-- Название соглашения повторяет название дела и потому длинное; колонки
		справа от него важнее, поэтому оно урезается, а целиком показывается
		подсказкой. -->
	<span class="flex max-w-80 items-baseline gap-2">
		<span class="truncate font-medium" title={row.title}>{row.title}</span>
		{#if row.uploadedKind}
			<span class="shrink-0 text-xs text-muted-foreground">{row.uploadedKind}</span>
		{/if}
	</span>
{/snippet}

{#snippet kindCell(row: DocumentListItem)}
	{#if row.kind === 'generated'}
		<StatusBadge tone="accent">Сгенерирован</StatusBadge>
	{:else}
		<StatusBadge tone="neutral">Загружен</StatusBadge>
	{/if}
{/snippet}

{#snippet interactionCell(row: DocumentListItem)}
	{#if row.interaction}
		<a
			class="block max-w-64 truncate rounded underline-offset-4 focus-ring hover:underline"
			title={row.interaction.title}
			href={resolve('/(app)/interactions/[id]', { id: row.interaction.id })}
		>
			{row.interaction.title}
		</a>
	{:else}
		<span class="text-muted-foreground">Вне взаимодействия</span>
	{/if}
{/snippet}

{#snippet factsCell(row: DocumentListItem)}
	{#if row.agreedAt === null && row.approvedAt === null && row.inEffectAt === null}
		<span class="text-muted-foreground">—</span>
	{:else}
		<span class="flex flex-wrap items-center gap-1">
			{#if row.agreedAt}
				<StatusBadge tone="success" dot title="Согласован {formatDate(row.agreedAt)}">
					Согласован
				</StatusBadge>
			{/if}
			{#if row.approvedAt}
				<StatusBadge tone="accent" dot title="Утверждён {formatDate(row.approvedAt)}">
					Утверждён
				</StatusBadge>
			{/if}
			{#if row.inEffectAt}
				<StatusBadge tone="info" dot title="Введён в действие {formatDate(row.inEffectAt)}">
					Введён
				</StatusBadge>
			{/if}
		</span>
	{/if}
{/snippet}

{#snippet downloadCell(row: DocumentListItem)}
	<Button
		variant="outline"
		size="sm"
		href={resolve('/(app)/documents/[id]/download', { id: row.id })}
	>
		<DownloadIcon aria-hidden="true" />
		Скачать
	</Button>
{/snippet}

<svelte:head><title>Документы — LCT CRM</title></svelte:head>

<PageHeader
	title="Документы"
	description="Всё, что приложено к взаимодействиям и собрано по шаблонам: соглашения, приказы, акты и отчёты."
/>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	{#if data.total === 0 && !data.filtered}
		<div class="rounded-lg border border-border bg-surface shadow-xs">
			<EmptyState
				icon={FileTextIcon}
				title="Документов пока нет"
				description="Документы появляются из карточек взаимодействий: файл загружают на вкладке «Документы» или собирают по шаблону."
			>
				{#snippet action()}
					<Button variant="outline" href={resolve('/interactions')}>К взаимодействиям</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-3">
			<FilterSelect param="kind" label="Вид" options={KIND_OPTIONS} />
			<FilterSelect param="format" label="Формат" options={FORMAT_OPTIONS} />
			<FilterSelect param="fact" label="Отметки" options={FACT_OPTIONS} allLabel="Любые" />
			<span class="text-sm text-muted-foreground">Всего: {formatNumber(data.total)}</span>
		</div>

		<DataTable
			{columns}
			rows={data.rows}
			total={data.total}
			getRowId={(row) => row.id}
			searchPlaceholder="Поиск по названию и взаимодействию"
			emptyTitle="Под фильтр ничего не подошло"
			emptyDescription="Смягчите условия или очистите поиск."
		/>
	{/if}
</div>
