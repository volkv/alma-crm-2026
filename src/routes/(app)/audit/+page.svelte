<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button/index.js';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDateTime, formatNumber } from '$lib/format';
	import type { AuditEventView, AuditOutcome } from '$lib/contracts/audit';
	import EventSheet from './event-sheet.svelte';
	import FilterBar from './filter-bar.svelte';
	import { exportHref } from './filters';
	import {
		AUDIT_OUTCOME_LABELS,
		AUDIT_OUTCOME_TONES,
		AUDIT_SOURCE_LABELS,
		auditEventLabel,
		subjectHref,
		subjectTypeLabel
	} from './labels';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let selected = $state<AuditEventView | null>(null);
	let sheetOpen = $state(false);

	const tooManyToExport = $derived(data.events.total > data.exportLimit);

	/**
	 * Сортировка колонок выключена: журнал всегда идёт от новых событий к
	 * старым, и другой порядок в нём не имеет смысла — это лента, а не таблица
	 * записей, которую перекладывают по столбцам.
	 */
	const columns: ColumnDef<DataTableFeatures, AuditEventView>[] = [
		{
			accessorKey: 'occurredAt',
			header: 'Время',
			meta: { title: 'Время' },
			enableSorting: false,
			enableHiding: false,
			cell: ({ row }) => formatDateTime(row.original.occurredAt)
		},
		{
			accessorKey: 'source',
			header: 'Источник',
			meta: { title: 'Источник' },
			enableSorting: false,
			cell: ({ row }) => AUDIT_SOURCE_LABELS[row.original.source]
		},
		{
			accessorKey: 'eventType',
			header: 'Событие',
			meta: { title: 'Событие' },
			enableSorting: false,
			enableHiding: false,
			cell: ({ row }) => auditEventLabel(row.original.eventType)
		},
		{
			accessorKey: 'outcome',
			header: 'Результат',
			meta: { title: 'Результат' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(outcomeCell, { outcome: row.original.outcome })
		},
		{
			accessorKey: 'actorLabel',
			header: 'Кто',
			meta: { title: 'Кто' },
			enableSorting: false,
			cell: ({ row }) =>
				renderSnippet(actorCell, {
					label: row.original.actorLabel,
					viaKey: row.original.apiKeyId !== null
				})
		},
		{
			accessorKey: 'ip',
			header: 'Адрес',
			meta: { title: 'Адрес' },
			enableSorting: false,
			cell: ({ row }) => row.original.ip ?? '—'
		},
		{
			id: 'subject',
			header: 'Над чем',
			meta: { title: 'Над чем' },
			enableSorting: false,
			cell: ({ row }) =>
				renderSnippet(subjectCell, { type: row.original.subjectType, id: row.original.subjectId })
		},
		{
			accessorKey: 'requestId',
			header: 'Запрос',
			meta: { title: 'Запрос' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(requestCell, { requestId: row.original.requestId })
		}
	];

	function openEvent(event: AuditEventView) {
		selected = event;
		sheetOpen = true;
	}
</script>

<svelte:head>
	<title>Журнал действий — Альма CRM</title>
</svelte:head>

{#snippet outcomeCell({ outcome }: { outcome: AuditOutcome })}
	<StatusBadge tone={AUDIT_OUTCOME_TONES[outcome]}>{AUDIT_OUTCOME_LABELS[outcome]}</StatusBadge>
{/snippet}

{#snippet actorCell({ label, viaKey }: { label: string; viaKey: boolean })}
	<span class="block max-w-48 truncate" title={label}>{label}</span>
	{#if viaKey}
		<span class="text-xs text-muted-foreground">через ключ доступа</span>
	{/if}
{/snippet}

{#snippet subjectCell({ type, id }: { type: string | null; id: string | null })}
	{#if type === null}
		<span class="text-faint">—</span>
	{:else}
		{@const href = id === null ? null : subjectHref(type, id)}
		{#if href}
			<!-- Клик по ссылке не должен заодно открывать карточку события. -->
			<a class="text-primary focus-ring" {href} onclick={(clicked) => clicked.stopPropagation()}>
				{subjectTypeLabel(type)}
			</a>
		{:else}
			<span>{subjectTypeLabel(type)}</span>
		{/if}
	{/if}
{/snippet}

{#snippet requestCell({ requestId }: { requestId: string })}
	<span class="font-mono text-xs text-muted-foreground" title={requestId}>
		{requestId.slice(0, 8)}
	</span>
{/snippet}

<Header
	title="Журнал действий"
	description="Кто, что и чем кончилось. Записи неизменяемы: их нельзя исправить или удалить."
>
	{#snippet actions()}
		{#if data.canExport}
			<!-- Обёртка без оформления: подсказка обводит выгрузку целиком, обе
				кнопки сразу. Классы те же, что у ряда действий в шапке, — вложенный
				ряд переносится так же, как переносился бы сам. -->
			<div data-tour="audit-export" class="flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					href={exportHref(page.url, 'csv')}
					disabled={tooManyToExport}
					data-sveltekit-reload
				>
					<DownloadIcon aria-hidden="true" />
					Экспорт CSV
				</Button>
				<Button
					variant="outline"
					href={exportHref(page.url, 'json')}
					disabled={tooManyToExport}
					data-sveltekit-reload
				>
					<DownloadIcon aria-hidden="true" />
					Экспорт JSON
				</Button>
			</div>
		{/if}
	{/snippet}
</Header>

<Breadcrumbs items={[{ label: 'Главное', href: resolve('/') }, { label: 'Журнал действий' }]} />

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<FilterBar url={page.url} actors={data.actors} />

	{#if data.exportDenied}
		<InlineHint tone="warning">
			Выгрузка журнала закрыта: она уносит из системы адреса, клиентов и всю историю действий, и
			право на неё выдаётся отдельно. Сам журнал остаётся здесь целиком.
		</InlineHint>
	{/if}

	{#if data.canExport && tooManyToExport}
		<InlineHint tone="warning">
			Под фильтр попало {formatNumber(data.events.total)} записей — за один раз выгружается не больше
			{formatNumber(data.exportLimit)}. Сузьте период или условия.
		</InlineHint>
	{/if}

	<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`).
		Обёртка без оформления: у списка своя разметка, а `min-w-0` оставляет её
		право сжиматься в колонке. -->
	<div data-tour="audit-events" class="min-w-0">
		<DataTable
			{columns}
			rows={data.events.items}
			total={data.events.total}
			getRowId={(event) => event.id}
			searchPlaceholder="Поиск по человеку и типу события"
			emptyTitle="Под фильтр не попало ни одного события"
			emptyDescription="Проверьте период и условия: журнал пишется только о том, что уже произошло."
			onopen={openEvent}
		/>
	</div>
</div>

<EventSheet event={selected} url={page.url} bind:open={sheetOpen} />
