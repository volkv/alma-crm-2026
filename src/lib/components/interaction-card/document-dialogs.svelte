<script lang="ts">
	import { untrack } from 'svelte';
	import { applyAction, enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { toast } from 'svelte-sonner';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
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
		DOCUMENT_TEMPLATE_LABELS,
		UPLOADED_DOCUMENT_KINDS,
		type DocumentStatusFact,
		type DocumentTemplateKey,
		type PackageOutcome,
		type DocumentSupersession,
		type MarkDayBounds
	} from '$lib/contracts/documents';
	import type { InteractionDocumentView, InteractionView } from '$lib/contracts/interactions';
	import { pluralize } from '$lib/format';
	import { getCardCommands } from './commands.svelte';

	/**
	 * Диалоги документов дела: загрузка, новая редакция, отметка и пакет
	 * документов по шаблонам. Документ неизменяем: исправленный файл встаёт
	 * новой редакцией, отметку снять нельзя, повторная сборка пакета встаёт
	 * рядом отдельными файлами.
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
	const packageOpen = opened('package');

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
	let packageChosen = $state<DocumentTemplateKey[]>([]);
	let packageCity = $state('');
	let packageOperatorSigner = $state('');
	let packageCounterpartySigner = $state('');
	let packageOutcomes = $state<PackageOutcome[]>([]);
	let packageRefusal = $state<{ message: string; description?: string } | null>(null);

	const packageCommand = $derived(commands.current?.kind === 'package' ? commands.current : null);

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
			packageOutcomes = [];
			packageRefusal = null;

			if (current.kind === 'package') {
				packageChosen = [...current.templates];
			}

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

	function togglePackage(template: DocumentTemplateKey, on: boolean) {
		packageChosen = on
			? [...packageChosen.filter((item) => item !== template), template]
			: packageChosen.filter((item) => item !== template);
	}

	const outcomeOf = (template: DocumentTemplateKey) =>
		packageOutcomes.find((outcome) => outcome.templateKey === template) ?? null;

	/**
	 * Сборка пакета отвечает по каждому документу. Всё собралось — диалог
	 * закрывается; что-то отказало — диалог остаётся открытым и под каждым
	 * документом пишет, что заполнить. Отказ целиком (не собралось ничего)
	 * показывается в самой форме: исправлять его здесь же.
	 */
	const packageSubmit: SubmitFunction = () => {
		packageRefusal = null;

		return async ({ result, update }) => {
			if (result.type === 'failure') {
				const data = (result.data ?? {}) as { message?: unknown; issues?: unknown };
				const issues = Array.isArray(data.issues)
					? data.issues.filter((issue): issue is string => typeof issue === 'string')
					: [];

				packageOutcomes = [];
				packageRefusal = {
					message: typeof data.message === 'string' ? data.message : 'Пакет не собран',
					description: issues.length > 0 ? issues.join('; ') : undefined
				};

				return;
			}

			if (result.type === 'success') {
				const outcomes = (result.data?.outcomes ?? []) as PackageOutcome[];
				const generated = outcomes.filter((outcome) => outcome.status === 'generated').length;

				await update({ reset: false });

				if (generated === outcomes.length) {
					commands.close();
					toast.success(
						`Пакет собран: ${pluralize(generated, ['документ', 'документа', 'документов'])}`
					);
				} else {
					packageOutcomes = outcomes;
				}

				return;
			}

			await applyAction(result);
		};
	};
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
				{#if markFact === 'approved'}
					<p class="text-xs text-muted-foreground">
						«Утверждён» — подписанный сторонами экземпляр. У акта передачи эта отметка ставит
						позициям договора из акта статус «передан».
					</p>
				{/if}
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
	bind:open={packageOpen.get, packageOpen.set}
	title="Пакет документов"
	description="Каждый документ соберётся в DOCX и PDF. Реквизиты, позиции договора, программы и сроки берутся из карточек; здесь — только то, чего в справочнике нет. Собранные раньше файлы останутся: новая сборка встаёт рядом."
	width="lg"
>
	<form
		id="card-package-form"
		method="POST"
		action="?/package"
		use:enhance={packageSubmit}
		class="flex flex-col gap-3"
	>
		<fieldset class="flex flex-col gap-2">
			<legend class="mb-1 text-sm font-medium">Документы</legend>
			{#each packageCommand?.templates ?? [] as template (template)}
				{@const outcome = outcomeOf(template)}
				<Label class="flex items-start gap-2 font-normal">
					<Checkbox
						name="templates"
						value={template}
						checked={packageChosen.includes(template)}
						onCheckedChange={(next) => togglePackage(template, next === true)}
						class="mt-0.5"
					/>
					<span class="flex flex-col gap-0.5">
						{DOCUMENT_TEMPLATE_LABELS[template]}
						{#if outcome?.status === 'generated'}
							<span class="text-xs text-success">Собран</span>
						{:else if outcome?.status === 'refused'}
							<span class="text-xs text-destructive">Не собран: {outcome.issues.join('; ')}</span>
						{/if}
					</span>
				</Label>
			{/each}
		</fieldset>

		{#if packageRefusal !== null}
			<InlineHint tone="warning">
				<span>
					{packageRefusal.message}{packageRefusal.description === undefined
						? ''
						: `: ${packageRefusal.description}`}
				</span>
			</InlineHint>
		{/if}

		<div class="flex flex-col gap-1.5">
			<Label for="card-package-city">Город подписания</Label>
			<Input id="card-package-city" name="city" placeholder="Москва" bind:value={packageCity} />
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="card-package-operator-signer">Подписант оператора (в родительном падеже)</Label>
			<Input
				id="card-package-operator-signer"
				name="operatorSigner"
				placeholder="директора Иванова И. И."
				bind:value={packageOperatorSigner}
			/>
		</div>
		{#if packageCommand?.counterpartyKind !== 'individual'}
			<div class="flex flex-col gap-1.5">
				<Label for="card-package-counterparty-signer">
					Подписант контрагента (в родительном падеже)
				</Label>
				<Input
					id="card-package-counterparty-signer"
					name="counterpartySigner"
					placeholder={packageCommand?.counterpartyKind === 'educational_institution'
						? 'ректора Петрова П. П.'
						: 'генерального директора Сидорова С. С.'}
					bind:value={packageCounterpartySigner}
				/>
			</div>
		{/if}
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>
				{packageOutcomes.length > 0 ? 'Закрыть' : 'Отмена'}
			</Button>
			<Button type="submit" form="card-package-form" disabled={packageChosen.length === 0}>
				Собрать
			</Button>
		</div>
	{/snippet}
</FormDialog>
