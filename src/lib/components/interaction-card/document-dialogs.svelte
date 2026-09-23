<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import DateField from '$lib/components/form/date-field.svelte';
	import FileInput from '$lib/components/form/file-input.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import { actionEnhance } from '$lib/components/interactions/action-enhance';
	import {
		documentKindLabel,
		markDayBounds,
		DOCUMENT_KIND_LABELS,
		DOCUMENT_STATUS_FACTS,
		DOCUMENT_STATUS_FACT_LABELS,
		GENERATED_DOCUMENT_KIND,
		UPLOADED_DOCUMENT_KINDS,
		type DocumentStatusFact,
		type DocumentSupersession,
		type MarkDayBounds
	} from '$lib/contracts/documents';
	import type { InteractionDocumentView, InteractionView } from '$lib/contracts/interactions';
	import { getCardCommands } from './commands.svelte';

	/**
	 * Диалоги документов дела: загрузка, новая редакция, отметка и соглашение
	 * по шаблону. Документ неизменяем: исправленный файл встаёт новой
	 * редакцией, отметку снять нельзя, повторная сборка соглашения встаёт
	 * рядом отдельной парой файлов.
	 */
	let {
		interaction,
		supersessions
	}: {
		interaction: InteractionView;
		supersessions: readonly DocumentSupersession[];
	} = $props();

	const commands = getCardCommands();

	const opened = (kind: Parameters<typeof commands.is>[0]) => ({
		get: () => commands.is(kind),
		set: (next: boolean) => {
			if (!next) commands.close();
		}
	});

	const uploadOpen = opened('upload');
	const revisionOpen = opened('revision');
	const markOpen = opened('mark');
	const generateOpen = opened('generate');

	const documents = $derived(interaction.documents);
	const superseded = $derived(new Set(supersessions.map((item) => item.documentId)));

	function unmarked(document: InteractionDocumentView): DocumentStatusFact[] {
		const moments: Record<DocumentStatusFact, Date | null> = {
			agreed: document.agreedAt,
			approved: document.approvedAt,
			in_effect: document.inEffectAt
		};

		return DOCUMENT_STATUS_FACTS.filter((fact) => moments[fact] === null);
	}

	const revisionOf = $derived.by(() => {
		const current = commands.current;

		return current?.kind === 'revision'
			? (documents.find((document) => document.id === current.documentId) ?? null)
			: null;
	});

	/**
	 * Отметку ставят из строки документа (документ известен) или от условия
	 * стадии (известна отметка, документ выбирают). Во втором случае в списке
	 * только действующие редакции, у которых этой отметки ещё нет.
	 */
	const markCommand = $derived(commands.current?.kind === 'mark' ? commands.current : null);
	const markCandidates = $derived(
		documents.filter(
			(document) =>
				!superseded.has(document.id) &&
				(markCommand === null ||
					markCommand.fact === null ||
					unmarked(document).includes(markCommand.fact))
		)
	);

	let uploadTitle = $state('');
	let uploadKind = $state<string>('agreement');
	let uploadChosen = $state<readonly string[]>([]);
	let revisionChosen = $state<readonly string[]>([]);
	let markDocumentId = $state('');
	let markFact = $state<DocumentStatusFact>('agreed');
	let markDay = $state('');
	let markNote = $state('');
	let generateForm = $state<HTMLFormElement | null>(null);
	let confirmRepeat = $state(false);

	const markDocument = $derived(
		documents.find((document) => document.id === markDocumentId) ?? null
	);
	const markOptions = $derived(markDocument === null ? [] : unmarked(markDocument));
	const markBounds = $derived<MarkDayBounds>(
		markDocument === null ? { min: '', max: '' } : markDayBounds(markDocument.createdAt)
	);

	$effect(() => {
		const current = commands.current;

		untrack(() => {
			if (current === null) return;

			uploadTitle = '';
			uploadKind = 'agreement';
			uploadChosen = [];
			revisionChosen = [];
			markNote = '';

			if (current.kind === 'mark') {
				const only = markCandidates.length === 1 ? markCandidates[0].id : '';

				markDocumentId = current.documentId ?? only;
				pickMark(current.fact);
			}
		});
	});

	/** Отметка по выбранному документу: заданная, если её ещё нет, иначе первая свободная. */
	function pickMark(fact: DocumentStatusFact | null) {
		const available = markDocument === null ? [] : unmarked(markDocument);

		markFact = fact !== null && available.includes(fact) ? fact : (available[0] ?? 'agreed');
		markDay = markBounds.max;
	}

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
</script>

<FormDialog
	bind:open={uploadOpen.get, uploadOpen.set}
	title="Загрузить документ"
	description="PDF, DOCX, XLSX, изображение или архив, до 25 МиБ."
	dirty={uploadTitle.trim() !== '' || uploadChosen.length > 0}
>
	<form
		id="card-upload-form"
		method="POST"
		action="?/upload"
		enctype="multipart/form-data"
		use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
		class="flex flex-col gap-3"
	>
		<div class="flex flex-col gap-1.5">
			<Label for="card-document-title">Название</Label>
			<Input
				id="card-document-title"
				name="title"
				placeholder="Например: подписанное соглашение"
				bind:value={uploadTitle}
			/>
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="card-document-kind">Вид документа</Label>
			<Select.Root type="single" name="kind" bind:value={uploadKind}>
				<Select.Trigger id="card-document-kind" class="w-full">
					{documentKindLabel(uploadKind)}
				</Select.Trigger>
				<Select.Content>
					{#each UPLOADED_DOCUMENT_KINDS as kind (kind)}
						<Select.Item value={kind} label={DOCUMENT_KIND_LABELS[kind]} />
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<FileInput
			id="card-document-file"
			name="file"
			label="Файл"
			required
			onchoose={(names) => (uploadChosen = names)}
		/>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-upload-form">Загрузить</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={revisionOpen.get, revisionOpen.set}
	title="Новая редакция документа"
	description="«{revisionOf?.title ??
		''}» останется в деле и будет скачиваться по-прежнему: файл неизменяем. Новая редакция встанет на его место с тем же названием и видом."
	dirty={revisionChosen.length > 0}
>
	<form
		id="card-revision-form"
		method="POST"
		action="?/uploadRevision"
		enctype="multipart/form-data"
		use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
		class="flex flex-col gap-3"
	>
		<input type="hidden" name="supersedesId" value={revisionOf?.id ?? ''} />
		<FileInput
			id="card-revision-file"
			name="file"
			label="Файл новой редакции"
			required
			onchoose={(names) => (revisionChosen = names)}
		/>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-revision-form">Загрузить редакцию</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={markOpen.get, markOpen.set}
	title="Отметка по документу"
	description="Согласован, утверждён или введён в действие — три независимых факта, а не ступени одного статуса. Снять отметку нельзя: поставленная остаётся на этой редакции навсегда."
	dirty={markNote.trim() !== ''}
>
	<form
		id="card-mark-form"
		method="POST"
		action="?/markDocument"
		use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
		class="flex flex-col gap-3"
	>
		{#if markCommand === null || markCommand.documentId === null}
			<div class="flex flex-col gap-1.5">
				<Label for="card-mark-document">Документ</Label>
				<Select.Root
					type="single"
					bind:value={
						() => markDocumentId,
						(next) => {
							markDocumentId = next;
							pickMark(markCommand?.fact ?? null);
						}
					}
				>
					<Select.Trigger id="card-mark-document" class="w-full">
						<span class="truncate">{markDocument?.title ?? 'Выберите документ'}</span>
					</Select.Trigger>
					<Select.Content>
						{#each markCandidates as document (document.id)}
							<Select.Item value={document.id} label={document.title} />
						{/each}
					</Select.Content>
				</Select.Root>
				{#if markCandidates.length === 0}
					<p class="text-xs text-muted-foreground">
						Подходящих документов нет — загрузите подписанный файл в панели «Документы».
					</p>
				{/if}
			</div>
		{:else}
			<p class="text-sm font-medium break-words">«{markDocument?.title ?? ''}»</p>
		{/if}
		<input type="hidden" name="documentId" value={markDocumentId} />

		{#if markDocument !== null}
			<div class="flex flex-col gap-1.5">
				<Label for="card-mark-fact">Отметка</Label>
				<Select.Root
					type="single"
					name="fact"
					bind:value={() => markFact, (next) => (markFact = next as DocumentStatusFact)}
				>
					<Select.Trigger id="card-mark-fact" class="w-full">
						{DOCUMENT_STATUS_FACT_LABELS[markFact]}
					</Select.Trigger>
					<Select.Content>
						{#each markOptions as fact (fact)}
							<Select.Item value={fact} label={DOCUMENT_STATUS_FACT_LABELS[fact]} />
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="card-mark-at">Дата отметки</Label>
				<DateField
					id="card-mark-at"
					name="at"
					bind:value={markDay}
					min={markBounds.min}
					max={markBounds.max}
					describedBy="card-mark-at-hint"
				/>
				<p id="card-mark-at-hint" class="text-xs text-muted-foreground">
					Задним числом — можно, от дня загрузки документа до сегодняшнего.
				</p>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="card-mark-note">Комментарий</Label>
				<Input
					id="card-mark-note"
					name="note"
					maxlength={500}
					placeholder="Например: протокол учёного совета № 14"
					bind:value={markNote}
				/>
			</div>
		{/if}
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button
				type="submit"
				form="card-mark-form"
				disabled={markDocument === null || markOptions.length === 0}
			>
				Поставить отметку
			</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={generateOpen.get, generateOpen.set}
	title="Соглашение по шаблону"
	description="Соберётся сразу в DOCX и PDF. Пустых мест в договоре не бывает, поэтому все поля обязательны."
	width="lg"
>
	{#if !hasAgreementPeriod}
		<InlineHint tone="warning">
			Сначала заполните срок соглашения: «Изменить план» в панели «Сроки».
		</InlineHint>
	{/if}
	<form
		id="card-generate-form"
		method="POST"
		action="?/generate"
		bind:this={generateForm}
		use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
		class="mt-3 flex flex-col gap-3"
	>
		<div class="flex flex-col gap-1.5">
			<Label for="card-city">Город подписания</Label>
			<Input id="card-city" name="city" placeholder="Москва" />
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="card-operator-name">Оператор</Label>
			<Input id="card-operator-name" name="operatorName" value={operator} />
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="card-operator-signer">Подписант оператора (в родительном падеже)</Label>
			<Input
				id="card-operator-signer"
				name="operatorSigner"
				placeholder="директора Иванова И. И."
			/>
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="card-institution-signer">Подписант учебного заведения</Label>
			<Input
				id="card-institution-signer"
				name="institutionSigner"
				placeholder="ректора Петрова П. П."
			/>
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="card-customer-name">Заказчик подготовки</Label>
			<Input id="card-customer-name" name="customerName" value={customer} />
		</div>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button
				type={alreadyGenerated ? 'button' : 'submit'}
				form="card-generate-form"
				disabled={!hasAgreementPeriod}
				onclick={alreadyGenerated ? () => (confirmRepeat = true) : undefined}
			>
				Сгенерировать соглашение
			</Button>
		</div>
	{/snippet}
</FormDialog>

<ConfirmDialog
	bind:open={confirmRepeat}
	title="Собрать соглашение ещё раз?"
	description="По этому взаимодействию соглашение уже собрано. Старые файлы останутся: документ неизменяем, и новая сборка встанет рядом отдельной парой DOCX и PDF."
	confirmLabel="Собрать ещё раз"
	onconfirm={() => generateForm?.requestSubmit()}
/>
