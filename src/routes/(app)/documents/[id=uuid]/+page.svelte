<script lang="ts">
	import { resolve } from '$app/paths';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button/index.js';
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
	<section class="rounded-lg border border-border bg-surface p-4 sm:p-6">
		<h2 class="mb-4 text-sm font-semibold">Документ</h2>
		<KeyValue>
			<KeyValueRow label="Откуда файл">
				<StatusBadge tone={generated ? 'accent' : 'neutral'}>
					{DOCUMENT_ORIGIN_LABELS[generated ? 'generated' : 'uploaded']}
				</StatusBadge>
			</KeyValueRow>
			<KeyValueRow label="Вид" value={documentKindLabel(data.document.kind)} />
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
</div>
