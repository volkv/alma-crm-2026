<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import ActionAlert from '$lib/components/directory/action-alert.svelte';
	import Flash from '$lib/components/directory/flash.svelte';
	import DateField from '$lib/components/form/date-field.svelte';
	import FileDropzone from '$lib/components/form/file-dropzone.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import {
		documentFormat,
		documentKindLabel,
		DOCUMENT_ORIGIN_LABELS,
		DOCUMENT_STATUS_FACTS,
		DOCUMENT_STATUS_FACT_LABELS,
		GENERATED_DOCUMENT_KIND,
		type DocumentStatusFact
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

	/** Момент каждого факта: `null` — отметки ещё нет. */
	const moments = $derived<Record<DocumentStatusFact, Date | null>>({
		agreed: data.document.agreedAt,
		approved: data.document.approvedAt,
		in_effect: data.document.inEffectAt
	});
	const TONES = {
		agreed: 'success',
		approved: 'accent',
		in_effect: 'info'
	} as const satisfies Record<DocumentStatusFact, 'success' | 'accent' | 'info'>;

	/**
	 * Поставленные отметки строкой «что и когда». Подпись с датой собирается
	 * здесь, а не двумя выражениями в разметке: разорванный на два узла текст
	 * читается вслух как два разных значения.
	 */
	/** Комментарий к каждой отметке: чем она объясняется. */
	const notes = $derived<Record<DocumentStatusFact, string | null>>({
		agreed: data.document.agreedNote,
		approved: data.document.approvedNote,
		in_effect: data.document.inEffectNote
	});

	const facts = $derived(
		DOCUMENT_STATUS_FACTS.flatMap((fact) => {
			const at = moments[fact];

			return at === null
				? []
				: [
						{
							key: fact,
							label: `${DOCUMENT_STATUS_FACT_LABELS[fact]} ${formatDate(at)}`,
							tone: TONES[fact],
							note: notes[fact]
						}
					];
		})
	);

	/**
	 * Факты, которых ещё нет: только их и предлагает форма. Снять отметку
	 * нельзя — поставленная неизменяема, — поэтому выбирать из отмеченных
	 * значило бы показывать команду, которой не существует.
	 */
	const available = $derived(DOCUMENT_STATUS_FACTS.filter((fact) => moments[fact] === null));

	let fact = $state<DocumentStatusFact>('agreed');
	let markDay = $state(data.markBounds.max);

	// Отмеченный факт из списка уходит, и выбор обязан уйти с ним: иначе форма
	// предлагала бы поставить отметку, которая уже стоит.
	$effect(() => {
		if (!available.includes(fact) && available.length > 0) {
			fact = available[0];
		}
	});
</script>

<svelte:head><title>{data.document.title} — Альма CRM</title></svelte:head>

<Flash messages={{ revision_uploaded: 'Новая редакция загружена' }} />

<Header title={data.document.title} description="{format} · {formatBytes(data.document.sizeBytes)}">
	{#snippet actions()}
		<Button
			href={resolve('/(app)/documents/[id=uuid]/download', { id: data.document.id })}
			data-sveltekit-reload
			data-tour="document-download"
		>
			<DownloadIcon aria-hidden="true" />
			Скачать
		</Button>
	{/snippet}
</Header>

<Breadcrumbs
	items={[
		{ label: 'Документы', href: resolve('/(app)/documents') },
		{ label: data.document.title }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
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

	<section class="rounded-lg border border-border bg-surface p-4 sm:p-6" data-tour="document-facts">
		<h2 class="mb-4 section-title">Документ</h2>
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

		{#if data.contractItems.length > 0}
			<h3 class="mt-6 mb-2 text-xs text-muted-foreground">Передаёт позиции договора</h3>
			<ul class="flex flex-col gap-1 text-sm">
				{#each data.contractItems as item (item.id)}
					<li>{item.productName} — {item.transferStatus}</li>
				{/each}
			</ul>
			<p class="mt-1 text-xs text-muted-foreground">
				Отметка «Утверждён» — подписанный сторонами экземпляр — ставит этим позициям статус
				«передан».
			</p>
		{/if}

		<h3 class="mt-6 mb-2 text-xs text-muted-foreground">Отметки</h3>
		{#if facts.length === 0}
			<p class="text-sm text-muted-foreground">
				Отметок нет: документ не согласован, не утверждён и не введён в действие.
			</p>
		{:else}
			<ul class="flex flex-col gap-2">
				{#each facts as item (item.key)}
					<li class="flex flex-wrap items-center gap-2">
						<StatusBadge tone={item.tone} dot>{item.label}</StatusBadge>
						{#if item.note !== null}
							<span class="text-xs text-muted-foreground">{item.note}</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if data.canWrite}
			{#if available.length === 0}
				<p class="mt-3 text-xs text-muted-foreground">
					Все три отметки поставлены. Снять их нельзя: отметка, которую можно переставить, ничего не
					доказывает.
				</p>
			{:else}
				<form
					method="POST"
					action="?/mark"
					use:enhance
					class="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4"
				>
					<div class="flex min-w-48 flex-col gap-1.5">
						<Label for="markFact">Отметка</Label>
						<Select.Root
							type="single"
							name="fact"
							bind:value={() => fact, (next) => (fact = next as DocumentStatusFact)}
						>
							<Select.Trigger id="markFact" class="w-full">
								{DOCUMENT_STATUS_FACT_LABELS[fact]}
							</Select.Trigger>
							<Select.Content>
								{#each available as option (option)}
									<Select.Item value={option} label={DOCUMENT_STATUS_FACT_LABELS[option]} />
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
					<div class="flex min-w-48 flex-col gap-1.5">
						<Label for="markAt">Дата отметки</Label>
						<DateField
							id="markAt"
							name="at"
							bind:value={markDay}
							min={data.markBounds.min}
							max={data.markBounds.max}
							describedBy="markAtHint"
						/>
					</div>
					<div class="flex min-w-64 flex-1 flex-col gap-1.5">
						<Label for="markNote">Комментарий</Label>
						<Input
							id="markNote"
							name="note"
							maxlength={500}
							placeholder="Например: протокол учёного совета № 14"
						/>
					</div>
					<Button type="submit" size="sm">Поставить отметку</Button>
					<p id="markAtHint" class="w-full text-xs text-muted-foreground">
						Дату можно поставить задним числом — от дня, когда документ появился в системе, до
						сегодняшнего. Отметку не снять и не переставить: её ставят заново на новой редакции.
					</p>
				</form>
			{/if}
		{/if}
	</section>

	<section class="rounded-lg border border-border bg-surface" data-tour="document-revisions">
		<header
			class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"
		>
			<h2 class="section-title">Редакции</h2>
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
						{#if revision.revisionNote !== null}
							<span class="block text-sm break-words">{revision.revisionNote}</span>
						{/if}
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
				<FileDropzone
					id="revisionFile"
					name="file"
					label="Новая редакция"
					description="Название, вид и взаимодействие останутся прежними — меняется только файл."
					required
				/>
				<div class="flex min-w-60 flex-1 flex-col gap-1.5">
					<Label for="revisionNote">Что изменилось</Label>
					<Input
						id="revisionNote"
						name="note"
						maxlength={500}
						placeholder="Например: подписанный сторонами скан"
					/>
				</div>
				<Button type="submit" size="sm">Загрузить новую редакцию</Button>
			</form>
		{/if}
	</section>
</div>
