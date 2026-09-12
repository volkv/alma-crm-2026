<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button/index.js';
	import ActionAlert from '$lib/components/directory/action-alert.svelte';
	import Flash from '$lib/components/directory/flash.svelte';
	import FileInput from '$lib/components/form/file-input.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import {
		documentFormat,
		documentKindLabel,
		DOCUMENT_ORIGIN_LABELS,
		GENERATED_DOCUMENT_KIND
	} from '$lib/contracts/documents';
	import { formatBytes, formatDate, formatDateTime } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Действующая редакция — та, которую никто не заменил. */
	const current = $derived(data.revisions.find((revision) => revision.isCurrent) ?? null);
	const superseded = $derived(current !== null && current.id !== data.document.id);
	const number = $derived(
		data.revisions.findIndex((revision) => revision.id === data.document.id) + 1
	);

	const generated = $derived(data.document.kind === GENERATED_DOCUMENT_KIND);
	const format = $derived(documentFormat(data.document.mime)?.toUpperCase() ?? data.document.mime);
	const facts = $derived(
		[
			{ label: 'Согласован', at: data.document.agreedAt, tone: 'success' as const },
			{ label: 'Утверждён', at: data.document.approvedAt, tone: 'accent' as const },
			{ label: 'Введён в действие', at: data.document.inEffectAt, tone: 'info' as const }
		].filter((fact) => fact.at !== null)
	);
</script>

<svelte:head><title>{data.document.title} — LCT CRM</title></svelte:head>

<Flash messages={{ revision_uploaded: 'Новая редакция загружена' }} />

<PageHeader
	title={data.document.title}
	description="{format} · {formatBytes(data.document.sizeBytes)}"
	breadcrumbs={[{ label: 'Документы', href: resolve('/(app)/documents') }]}
>
	{#snippet actions()}
		<Button
			href={resolve('/(app)/documents/[id=uuid]/download', { id: data.document.id })}
			data-sveltekit-reload
		>
			<DownloadIcon aria-hidden="true" />
			Скачать
		</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<ActionAlert />

	{#if superseded && current}
		<InlineHint tone="warning">
			Эта редакция заменена: файл остаётся, но действует
			<a
				class="underline underline-offset-2 focus-ring"
				href={resolve('/(app)/documents/[id=uuid]', { id: current.id })}
			>
				редакция от {formatDate(current.createdAt)}
			</a>.
		</InlineHint>
	{/if}

	<section class="rounded-lg border border-border bg-surface p-4 sm:p-6">
		<h2 class="mb-4 text-sm font-semibold">Документ</h2>
		<KeyValue>
			<KeyValueRow label="Откуда файл">
				<StatusBadge tone={generated ? 'accent' : 'neutral'}>
					{DOCUMENT_ORIGIN_LABELS[generated ? 'generated' : 'uploaded']}
				</StatusBadge>
			</KeyValueRow>
			<KeyValueRow label="Вид" value={documentKindLabel(data.document.kind)} />
			{#if data.revisions.length > 1}
				<KeyValueRow label="Редакция" value="{number} из {data.revisions.length}" />
			{/if}
			<KeyValueRow label="Формат" value={format} />
			<KeyValueRow label="Размер" value={formatBytes(data.document.sizeBytes)} />
			<KeyValueRow label="Добавлен" value={formatDateTime(data.document.createdAt)} />
			<KeyValueRow label="Взаимодействие">
				{#if data.interaction}
					<a
						class="underline underline-offset-2 focus-ring"
						href={resolve('/(app)/interactions/[id=uuid]', { id: data.interaction.id })}
					>
						{data.interaction.title}
					</a>
				{:else if data.document.interactionId === null}
					<span class="text-muted-foreground">Вне взаимодействия</span>
				{:else}
					<!-- Документ привязан к делу, но самих взаимодействий человеку не
						видно: ссылка привела бы к отказу, а не к записи. -->
					<span class="text-faint">Нет доступа к взаимодействию</span>
				{/if}
			</KeyValueRow>
		</KeyValue>

		<h3 class="mt-6 mb-2 text-xs text-muted-foreground">Отметки</h3>
		{#if facts.length === 0}
			<p class="text-sm text-muted-foreground">
				Отметок нет: документ не согласован, не утверждён и не введён в действие.
			</p>
		{:else}
			<ul class="flex flex-wrap items-center gap-2">
				{#each facts as fact (fact.label)}
					<li>
						<StatusBadge tone={fact.tone} dot>
							{fact.label}
							{fact.at === null ? '' : formatDate(fact.at)}
						</StatusBadge>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="rounded-lg border border-border bg-surface">
		<header
			class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"
		>
			<h2 class="text-sm font-semibold">Редакции</h2>
			<span class="text-xs text-muted-foreground">
				Файл неизменяем: исправленный документ встаёт новой редакцией, а прежняя остаётся
				скачиваемой.
			</span>
		</header>

		<ul class="flex flex-col divide-y divide-border px-4 sm:px-6">
			{#each data.revisions as revision, index (revision.id)}
				<li class="flex flex-wrap items-center gap-2 py-3">
					<span class="min-w-0 flex-1">
						{#if revision.id === data.document.id}
							<span class="block truncate text-sm font-medium">{revision.title}</span>
						{:else}
							<a
								class="block truncate rounded text-sm font-medium underline-offset-4 focus-ring hover:underline"
								href={resolve('/(app)/documents/[id=uuid]', { id: revision.id })}
							>
								{revision.title}
							</a>
						{/if}
						<span class="text-xs text-muted-foreground">
							Редакция {index + 1} · {formatDateTime(revision.createdAt)} · {formatBytes(
								revision.sizeBytes
							)}{revision.authorName ? ` · ${revision.authorName}` : ''}
						</span>
					</span>
					{#if revision.isCurrent}
						<StatusBadge tone="success" dot>Действует</StatusBadge>
					{:else}
						<StatusBadge tone="neutral">Заменена</StatusBadge>
					{/if}
					{#if revision.id === data.document.id}
						<StatusBadge tone="accent">Открыта</StatusBadge>
					{/if}
					<Button
						variant="outline"
						size="sm"
						href={resolve('/(app)/documents/[id=uuid]/download', { id: revision.id })}
						data-sveltekit-reload
					>
						<DownloadIcon aria-hidden="true" />
						Скачать
					</Button>
				</li>
			{/each}
		</ul>

		{#if data.canWrite && !superseded}
			<form
				method="POST"
				action="?/uploadRevision"
				enctype="multipart/form-data"
				use:enhance
				class="flex flex-wrap items-end gap-3 border-t border-border p-4 sm:p-6"
			>
				<FileInput
					id="revisionFile"
					name="file"
					label="Новая редакция"
					description="Название, вид и взаимодействие останутся прежними — меняется только файл."
					required
				/>
				<Button type="submit" size="sm">Загрузить новую редакцию</Button>
			</form>
		{/if}
	</section>
</div>
