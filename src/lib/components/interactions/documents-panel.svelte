<script lang="ts">
	import DownloadIcon from '@lucide/svelte/icons/download';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import FileInput from '$lib/components/form/file-input.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import {
		documentFormat,
		documentKindLabel,
		DOCUMENT_KIND_LABELS,
		GENERATED_DOCUMENT_KIND,
		UPLOADED_DOCUMENT_KINDS,
		type DocumentSupersession
	} from '$lib/contracts/documents';
	import type { InteractionDocumentView, InteractionView } from '$lib/contracts/interactions';
	import { formatBytes, formatDate, formatDateTime } from '$lib/format';
	import { actionEnhance } from './action-enhance';

	/**
	 * Документы взаимодействия: что уже приложено, что можно загрузить и что
	 * собирается по шаблону. Файл отдаёт отдельный маршрут — он же записывает
	 * выдачу в журнал, поэтому ссылка ведёт туда, а не на путь в хранилище.
	 */
	let {
		interaction,
		documents,
		supersessions,
		canUpload,
		canGenerate
	}: {
		interaction: InteractionView;
		documents: readonly InteractionDocumentView[];
		/** Какие из этих файлов уже заменены новой редакцией и когда. */
		supersessions: readonly DocumentSupersession[];
		canUpload: boolean;
		canGenerate: boolean;
	} = $props();

	/**
	 * Заменённые редакции по умолчанию скрыты: панель отвечает на вопрос «что
	 * приложено к делу сейчас». Они не исчезают — переключатель возвращает их
	 * в список с пометкой, чем именно их заменили.
	 */
	let showSuperseded = $state(false);

	const supersededBy = $derived(
		new Map(supersessions.map((item) => [item.documentId, item.supersededAt]))
	);
	const visible = $derived(
		showSuperseded ? documents : documents.filter((document) => !supersededBy.has(document.id))
	);

	const customer = $derived(
		interaction.parties.find((party) => party.partyRole === 'customer')?.organizationName ?? ''
	);
	const operator = $derived(
		interaction.parties.find((party) => party.partyRole === 'operator')?.organizationName ?? ''
	);
	/**
	 * Шаблон соглашения подставляет срок из плана, и без него сборка отказывает.
	 * Отказ после пяти заполненных полей — тупик, поэтому запрет виден заранее.
	 */
	const hasAgreementPeriod = $derived(
		interaction.agreementPeriodStart !== null && interaction.agreementPeriodEnd !== null
	);
	const alreadyGenerated = $derived(
		documents.some((document) => document.kind === GENERATED_DOCUMENT_KIND)
	);

	let uploadKind = $state<string>('agreement');
	let generateForm = $state<HTMLFormElement | null>(null);
	let confirmRepeat = $state(false);
	let revisionOf = $state<InteractionDocumentView | null>(null);
	let revisionOpen = $state(false);

	function askRevision(document: InteractionDocumentView) {
		revisionOf = document;
		revisionOpen = true;
	}

	/** Формат словом; неизвестный тип показывается как записан, а не прячется. */
	function format(mime: string): string {
		return documentFormat(mime)?.toUpperCase() ?? mime;
	}
</script>

<div class="flex flex-col gap-4">
	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Документы взаимодействия</Card.Title>
			{#if supersessions.length > 0}
				<Card.Action>
					<Label class="flex items-center gap-2 text-xs font-normal text-muted-foreground">
						<Switch
							checked={showSuperseded}
							aria-label="Показывать заменённые редакции"
							onCheckedChange={(checked) => (showSuperseded = checked === true)}
						/>
						Заменённые редакции
					</Label>
				</Card.Action>
			{/if}
		</Card.Header>
		<Card.Content>
			{#if documents.length === 0}
				<EmptyState
					icon={FileTextIcon}
					title="Документов пока нет"
					description="Загрузите подписанный файл или соберите соглашение по шаблону."
				/>
			{:else}
				<ul class="flex flex-col divide-y divide-border">
					{#each visible as document (document.id)}
						<li class="flex flex-wrap items-center gap-2 py-2">
							<span class="min-w-0 flex-1">
								<a
									class="block truncate rounded text-sm font-medium underline-offset-4 focus-ring hover:underline"
									title={document.title}
									href={resolve('/(app)/documents/[id=uuid]', { id: document.id })}
								>
									{document.title}
								</a>
								<span class="text-xs text-muted-foreground">
									{documentKindLabel(document.kind)} · {format(document.mime)} · {formatBytes(
										document.sizeBytes
									)} · {formatDateTime(document.createdAt)}
								</span>
							</span>
							{#if supersededBy.has(document.id)}
								<StatusBadge tone="neutral">
									Заменён редакцией от {formatDate(supersededBy.get(document.id) ?? new Date())}
								</StatusBadge>
							{/if}
							{#if document.agreedAt}
								<StatusBadge tone="success" dot>Согласован</StatusBadge>
							{/if}
							{#if document.approvedAt}
								<StatusBadge tone="accent" dot>Утверждён</StatusBadge>
							{/if}
							{#if canUpload && !supersededBy.has(document.id)}
								<Button variant="ghost" size="sm" onclick={() => askRevision(document)}>
									Новая редакция
								</Button>
							{/if}
							<Button
								variant="outline"
								size="sm"
								href={resolve('/(app)/documents/[id=uuid]/download', { id: document.id })}
								data-sveltekit-reload
							>
								<DownloadIcon aria-hidden="true" />
								Скачать
							</Button>
						</li>
					{/each}
				</ul>

				{#if visible.length === 0}
					<p class="text-sm text-muted-foreground">
						Все файлы этого дела заменены новыми редакциями. Включите переключатель, чтобы увидеть
						их.
					</p>
				{/if}
			{/if}
		</Card.Content>
	</Card.Root>

	<div class="grid items-start gap-4 lg:grid-cols-2">
		{#if canUpload}
			<Card.Root size="sm">
				<Card.Header>
					<Card.Title>Загрузить документ</Card.Title>
					<Card.Description>PDF, DOCX, XLSX, изображение или архив, до 25 МиБ.</Card.Description>
				</Card.Header>
				<Card.Content>
					<form
						method="POST"
						action="?/upload"
						enctype="multipart/form-data"
						use:enhance={actionEnhance()}
						class="flex flex-col gap-3"
					>
						<div class="flex flex-col gap-1.5">
							<Label for="documentTitle">Название</Label>
							<Input
								id="documentTitle"
								name="title"
								placeholder="Например: подписанное соглашение"
							/>
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="documentKind">Вид документа</Label>
							<Select.Root type="single" name="kind" bind:value={uploadKind}>
								<Select.Trigger id="documentKind" class="w-full">
									{documentKindLabel(uploadKind)}
								</Select.Trigger>
								<Select.Content>
									{#each UPLOADED_DOCUMENT_KINDS as kind (kind)}
										<Select.Item value={kind} label={DOCUMENT_KIND_LABELS[kind]} />
									{/each}
								</Select.Content>
							</Select.Root>
						</div>
						<FileInput id="documentFile" name="file" label="Файл" required />
						<div class="flex justify-end">
							<Button type="submit" size="sm">Загрузить</Button>
						</div>
					</form>
				</Card.Content>
			</Card.Root>
		{/if}

		{#if canGenerate}
			<Card.Root size="sm">
				<Card.Header>
					<Card.Title>Соглашение по шаблону</Card.Title>
					<Card.Description>
						Соберётся сразу в DOCX и PDF. Пустых мест в договоре не бывает, поэтому все поля
						обязательны.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<form
						method="POST"
						action="?/generate"
						bind:this={generateForm}
						use:enhance={actionEnhance()}
						class="flex flex-col gap-3"
					>
						<div class="flex flex-col gap-1.5">
							<Label for="city">Город подписания</Label>
							<Input id="city" name="city" placeholder="Москва" />
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="operatorName">Оператор</Label>
							<Input id="operatorName" name="operatorName" value={operator} />
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="operatorSigner">Подписант оператора (в родительном падеже)</Label>
							<Input
								id="operatorSigner"
								name="operatorSigner"
								placeholder="директора Иванова И. И."
							/>
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="institutionSigner">Подписант учебного заведения</Label>
							<Input
								id="institutionSigner"
								name="institutionSigner"
								placeholder="ректора Петрова П. П."
							/>
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="customerName">Заказчик подготовки</Label>
							<Input id="customerName" name="customerName" value={customer} />
						</div>
						<div class="flex flex-col items-end gap-1.5">
							<Button
								type={alreadyGenerated ? 'button' : 'submit'}
								size="sm"
								variant="outline"
								disabled={!hasAgreementPeriod}
								onclick={alreadyGenerated ? () => (confirmRepeat = true) : undefined}
							>
								Сгенерировать соглашение
							</Button>
							{#if !hasAgreementPeriod}
								<p class="text-xs text-muted-foreground">
									Сначала заполните срок соглашения на вкладке «План».
								</p>
							{/if}
						</div>
					</form>
				</Card.Content>
			</Card.Root>
		{/if}
	</div>
</div>

<Dialog.Root bind:open={revisionOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Новая редакция документа</Dialog.Title>
			<Dialog.Description>
				«{revisionOf?.title ?? ''}» останется в деле и будет скачиваться по-прежнему: файл
				неизменяем. Новая редакция встанет на его место с тем же названием и видом.
			</Dialog.Description>
		</Dialog.Header>

		<form
			method="POST"
			action="?/uploadRevision"
			enctype="multipart/form-data"
			use:enhance={actionEnhance({ onsuccess: () => (revisionOpen = false) })}
			class="flex flex-col gap-3"
		>
			<input type="hidden" name="supersedesId" value={revisionOf?.id ?? ''} />
			<FileInput id="revisionFile" name="file" label="Файл новой редакции" required />
			<Dialog.Footer>
				<Button type="submit" size="sm">Загрузить редакцию</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmRepeat}
	title="Собрать соглашение ещё раз?"
	description="По этому взаимодействию соглашение уже собрано. Старые файлы останутся: документ неизменяем, и новая сборка встанет рядом отдельной парой DOCX и PDF."
	confirmLabel="Собрать ещё раз"
	onconfirm={() => generateForm?.requestSubmit()}
/>
