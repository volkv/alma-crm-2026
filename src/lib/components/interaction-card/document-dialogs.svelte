<script lang="ts">
	import { untrack } from 'svelte';
	import { applyAction, enhance } from '$app/forms';
	import { page } from '$app/state';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { toast } from 'svelte-sonner';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import DateField from '$lib/components/form/date-field.svelte';
	import FileInput from '$lib/components/form/file-input.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import { actionEnhance } from '$lib/components/interactions/action-enhance';
	import {
		documentFormat,
		documentKindLabel,
		markDayBounds,
		DOCUMENT_KIND_LABELS,
		DOCUMENT_STATUS_FACTS,
		DOCUMENT_STATUS_FACT_LABELS,
		DOCUMENT_TEMPLATE_KEYS,
		DOCUMENT_TEMPLATE_LABELS,
		UPLOADED_DOCUMENT_KINDS,
		type UploadedDocumentKind,
		type DocumentStatusFact,
		type DocumentTemplateKey,
		type PackageDefaults,
		type PackageFix,
		type PackageOutcome,
		type DocumentSupersession,
		type MarkDayBounds
	} from '$lib/contracts/documents';
	import type { InteractionDocumentView, InteractionView } from '$lib/contracts/interactions';
	import { resolve } from '$app/paths';
	import { formatDate, pluralize } from '$lib/format';
	import { kindOwner } from '$lib/platform/registry';
	import { getCardCommands } from './commands.svelte';
	import type { CardCommand } from './model';

	/**
	 * Диалоги документов дела: загрузка, новая редакция, отметка и пакет
	 * документов по шаблонам. Документ неизменяем: исправленный файл встаёт
	 * новой редакцией, отметку снять нельзя, повторная сборка пакета даёт
	 * собранному документу новую редакцию, а не двойника рядом.
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

	/**
	 * Виды, которые можно выбрать при загрузке. Вид модуля («Документ об
	 * обучении» у «Обучения») предлагается, только пока модуль действует в
	 * пространстве дела; действующие модули отдаёт загрузчик карточки.
	 */
	const uploadKinds = $derived.by(() => {
		const active = (page.data.modules as readonly string[] | undefined) ?? [];

		return UPLOADED_DOCUMENT_KINDS.filter((kind) => {
			const owner = kindOwner(kind);

			return owner === null || active.includes(owner);
		});
	});

	const documents = $derived(interaction.documents);
	const superseded = $derived(new Set(supersessions.map((item) => item.documentId)));
	/** Редакция → та, которую она заменила: по цепочке считается номер редакции. */
	const predecessorOf = $derived(
		new Map(supersessions.map((item) => [item.supersededById, item.documentId]))
	);

	/** Номер редакции в цепочке документа: у первой — 1. */
	function revisionNo(documentId: string): number {
		let count = 1;
		let current = predecessorOf.get(documentId);

		while (current !== undefined && count <= documents.length) {
			count += 1;
			current = predecessorOf.get(current);
		}

		return count;
	}

	/**
	 * Документ одной строкой для выбора: у пересобранного пакета названия
	 * совпадают, различают их формат, дата и номер редакции.
	 */
	function describeDocument(document: InteractionDocumentView): string {
		const format = documentFormat(document.mime)?.toUpperCase() ?? document.mime;

		return `${document.title} · ${format} · ${formatDate(document.createdAt)} · ред. ${revisionNo(document.id)}`;
	}

	/**
	 * Документы, собранные по шаблону и ещё не заменённые: скан подписанного
	 * экземпляра встаёт их новой редакцией. Порядок — по каталогу шаблонов
	 * (соглашение раньше акта), внутри шаблона PDF раньше DOCX: подписывают
	 * напечатанный PDF.
	 */
	const revisionTargets = $derived(
		documents
			.filter((document) => document.templateKey !== null && !superseded.has(document.id))
			.toSorted(
				(left, right) =>
					templateOrder(left.templateKey) - templateOrder(right.templateKey) ||
					Number(documentFormat(right.mime) === 'pdf') -
						Number(documentFormat(left.mime) === 'pdf') ||
					right.createdAt.getTime() - left.createdAt.getTime()
			)
	);

	function templateOrder(key: DocumentTemplateKey | null): number {
		return key === null ? Number.MAX_SAFE_INTEGER : DOCUMENT_TEMPLATE_KEYS.indexOf(key);
	}

	/**
	 * Вид загрузки по умолчанию: у вуза главная бумага — соглашение, у лица и
	 * компании — договор. Подписанный договор юрлица видом «Соглашение» читался
	 * бы как другая бумага.
	 */
	const defaultUploadKind = $derived<UploadedDocumentKind>(
		(page.data.card as { counterpartyKind?: string } | undefined)?.counterpartyKind ===
			'educational_institution'
			? 'agreement'
			: 'contract'
	);

	/**
	 * Стадия, на которой бумаги подписывают и обмениваются ими: загрузка с неё
	 * по умолчанию — новая редакция собранного документа (подписанный скан), а
	 * не отдельный файл, который стадия не засчитает.
	 */
	const documentsStage = $derived(
		(page.data.status as { current?: { snapshot?: { category?: string } } | null } | undefined)
			?.current?.snapshot?.category === 'documents'
	);

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
	/**
	 * Шаблон, который ждёт стадия: засчитывается только отметка на документе,
	 * собранном по нему, или на его новой редакции (скан подписанного
	 * экземпляра наследует шаблон). Загруженный руками файл того же вида стадию
	 * не закроет — поэтому его нет среди кандидатов, а ниже сказано почему.
	 */
	const markTemplate = $derived(markCommand?.template ?? null);
	const markOpenDocuments = $derived(
		documents.filter(
			(document) =>
				!superseded.has(document.id) &&
				(markCommand === null ||
					markCommand.fact === null ||
					unmarked(document).includes(markCommand.fact))
		)
	);
	const markCandidates = $derived(
		markTemplate === null
			? markOpenDocuments
			: markOpenDocuments.filter((document) => document.templateKey === markTemplate)
	);
	/** Документы, которые подошли бы по отметке, но собраны не по шаблону стадии. */
	const markForeign = $derived(
		markTemplate === null
			? []
			: markOpenDocuments.filter((document) => document.templateKey !== markTemplate)
	);

	let uploadTitle = $state('');
	let uploadKind = $state<string>('agreement');
	/** Чью новую редакцию загружают; `''` — новый документ. */
	let uploadTarget = $state('');
	let uploadNote = $state('');
	let uploadChosen = $state<readonly string[]>([]);
	let revisionChosen = $state<readonly string[]>([]);
	let revisionNote = $state('');
	let markDocumentId = $state('');
	let markFact = $state<DocumentStatusFact>('agreed');
	let markDay = $state('');
	let markNote = $state('');
	let packageChosen = $state<DocumentTemplateKey[]>([]);
	let packageCity = $state('');
	let packageOperatorSigner = $state('');
	let packageCounterpartySigner = $state('');
	let packageOutcomes = $state<PackageOutcome[]>([]);
	/** Претензии к полям формы сборки, найденные до отправки. */
	let packageErrors = $state<Partial<Record<PackageField, string>>>({});
	/**
	 * Пакет, из которого ушли исправлять дело («Изменить план», стороны,
	 * договор): когда тот диалог закроется, пакет откроется снова с тем же
	 * выбором и введёнными полями — вводить подписантов заново не придётся.
	 */
	let packageReturn = $state<{
		command: Extract<CardCommand, { kind: 'package' }>;
		chosen: DocumentTemplateKey[];
		city: string;
		operatorSigner: string;
		counterpartySigner: string;
	} | null>(null);
	let packageRefusal = $state<{ message: string; description?: string } | null>(null);
	/**
	 * Умолчания формы сборки приходят отдельным запросом при открытии: город из
	 * прошлой сборки или реквизитов оператора, подписанты — из прошлой сборки.
	 */
	let packageDefaultsError = $state<string | null>(null);

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
			uploadKind =
				current.kind === 'upload' ? (current.documentKind ?? defaultUploadKind) : defaultUploadKind;
			uploadTarget =
				current.kind === 'upload' && current.documentKind === undefined && documentsStage
					? (revisionTargets.find((document) => document.approvedAt === null)?.id ?? '')
					: '';
			uploadNote = '';
			uploadChosen = [];
			revisionChosen = [];
			revisionNote = '';
			markNote = '';
			packageOutcomes = [];
			packageRefusal = null;

			if (current.kind === 'package') {
				const back = packageReturn;

				packageReturn = null;
				packageErrors = {};
				packageChosen = back?.chosen ?? [...current.templates];

				if (back !== null) {
					packageCity = back.city;
					packageOperatorSigner = back.operatorSigner;
					packageCounterpartySigner = back.counterpartySigner;
				}

				void loadPackageDefaults();
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

	/**
	 * Подставляет умолчания, не затирая того, что человек уже ввёл. Отказ —
	 * строкой в форме: поля остаются пустыми, и их заполняют руками.
	 */
	async function loadPackageDefaults() {
		const { id } = page.params;

		packageDefaultsError = null;

		if (id === undefined) return;

		const response = await fetch(resolve('/(app)/documents/package-defaults/[id=uuid]', { id }));

		if (!response.ok) {
			packageDefaultsError =
				'Не удалось подставить город и подписантов прошлой сборки — впишите их сами.';

			return;
		}

		const defaults = (await response.json()) as PackageDefaults;

		if (packageCity.trim() === '') packageCity = defaults.city ?? '';
		if (packageOperatorSigner.trim() === '') packageOperatorSigner = defaults.operatorSigner ?? '';
		if (packageCounterpartySigner.trim() === '') {
			packageCounterpartySigner = defaults.counterpartySigner ?? '';
		}
	}

	/** Куда ведёт исправление из отказа сборки: название кнопки и что она делает. */
	const FIX_LABELS: Record<PackageFix, string> = {
		parties: 'Изменить состав → Стороны',
		plan: 'Изменить план',
		contract: 'Выбрать договор'
	};

	/** Исправления всех отказавших документов, без повторов, в порядке важности. */
	const packageFixes = $derived(
		(['parties', 'plan', 'contract'] as const).filter((fix) =>
			packageOutcomes.some((outcome) => outcome.status === 'refused' && outcome.fixes.includes(fix))
		)
	);

	/**
	 * Каждое исправление — диалог этой же карточки: стороны — раздел «Стороны»
	 * состава дела, план и договор — свои диалоги. Открытый диалог сменяет этот.
	 */
	function openFix(fix: PackageFix) {
		if (packageCommand !== null) {
			packageReturn = {
				command: packageCommand,
				chosen: [...packageChosen],
				city: packageCity,
				operatorSigner: packageOperatorSigner,
				counterpartySigner: packageCounterpartySigner
			};
		}

		if (fix === 'parties') {
			commands.openComposition('parties');
		} else {
			commands.open({ kind: fix });
		}
	}

	/** Диалог исправления закрыт — сохранил человек или передумал: пакет снова открыт. */
	$effect(() => {
		if (commands.busy || packageReturn === null) return;

		// Поля и выбор вернёт сброс формы при открытии пакета (эффект выше):
		// он узнаёт возврат по `packageReturn` и снимает его сам.
		untrack(() => {
			if (packageReturn !== null) commands.open(packageReturn.command);
		});
	});

	type PackageField = 'city' | 'operatorSigner' | 'counterpartySigner';

	/** Подписант контрагента нужен всем, кроме физического лица: оно подписывает само. */
	const needsCounterpartySigner = $derived(packageCommand?.counterpartyKind !== 'individual');

	/**
	 * Обязательные поля формы — до отправки, у самого поля. Сервер проверяет их
	 * ещё раз, но без названного подписанта не собирается ни один документ, и
	 * ждать ответа ради этого незачем.
	 */
	function packageFieldErrors(): Partial<Record<PackageField, string>> {
		const errors: Partial<Record<PackageField, string>> = {};

		if (packageCity.trim() === '') errors.city = 'Укажите город подписания';
		if (packageOperatorSigner.trim() === '') {
			errors.operatorSigner = 'Укажите, кто подписывает за оператора';
		}
		if (needsCounterpartySigner && packageCounterpartySigner.trim() === '') {
			errors.counterpartySigner = 'Укажите, кто подписывает за контрагента';
		}

		return errors;
	}

	/** Что уже собрано в деле по шаблону: действующие редакции собранных документов. */
	function builtOf(template: DocumentTemplateKey): InteractionDocumentView[] {
		return documents.filter(
			(document) => document.templateKey === template && !superseded.has(document.id)
		);
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
	const packageSubmit: SubmitFunction = ({ cancel, formElement }) => {
		packageRefusal = null;
		packageErrors = packageFieldErrors();

		const invalid = Object.keys(packageErrors)[0] as PackageField | undefined;

		if (invalid !== undefined) {
			cancel();
			formElement.querySelector<HTMLInputElement>(`[name="${invalid}"]`)?.focus();

			return;
		}

		return async ({ result, update }) => {
			if (result.type === 'failure') {
				const data = (result.data ?? {}) as {
					message?: unknown;
					issues?: unknown;
					outcomes?: unknown;
				};
				const message = typeof data.message === 'string' ? data.message : 'Пакет не собран';

				// Отказ всего пакета с исходами по документам — те же строки под
				// каждым документом и кнопки исправлений, что и у частичного.
				if (Array.isArray(data.outcomes)) {
					packageOutcomes = data.outcomes as PackageOutcome[];
					packageRefusal = { message };

					return;
				}

				const issues = Array.isArray(data.issues)
					? data.issues.filter((issue): issue is string => typeof issue === 'string')
					: [];

				packageOutcomes = [];
				packageRefusal = {
					message,
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

{#snippet fieldError(id: string, message: string | undefined)}
	{#if message !== undefined}
		<p {id} class="text-xs text-danger-soft-foreground">{message}</p>
	{/if}
{/snippet}

<!-- Звёздочка у поля, без которого документ не собрать. Пустое поле форма
	называет у него самого до отправки (`packageFieldErrors`), атрибута `required`
	нет: браузерная подсказка всплывала бы по-английски поверх диалога. -->
{#snippet requiredMark()}
	<span class="text-danger" aria-hidden="true">*</span>
	<span class="sr-only">обязательное поле</span>
{/snippet}

<FormDialog
	bind:open={uploadOpen.get, uploadOpen.set}
	title="Загрузить документ"
	description="PDF, DOCX, XLSX, изображение или архив, до 25 МиБ."
	dirty={uploadTitle.trim() !== '' || uploadNote.trim() !== '' || uploadChosen.length > 0}
>
	<form
		id="card-upload-form"
		method="POST"
		action={uploadTarget === '' ? '?/upload' : '?/uploadRevision'}
		enctype="multipart/form-data"
		use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
		class="flex flex-col gap-3"
	>
		{#if revisionTargets.length > 0}
			<div class="flex flex-col gap-1.5">
				<Label for="card-upload-target">Что загружаете</Label>
				<Select.Root type="single" bind:value={uploadTarget}>
					<Select.Trigger id="card-upload-target" class="w-full">
						<span class="truncate">
							{uploadTarget === ''
								? 'Новый документ'
								: `Новая редакция: ${describeDocument(
										revisionTargets.find((document) => document.id === uploadTarget) ??
											revisionTargets[0]
									)}`}
						</span>
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="" label="Новый документ" />
						{#each revisionTargets as document (document.id)}
							<Select.Item
								value={document.id}
								label={`Новая редакция: ${describeDocument(document)}`}
							/>
						{/each}
					</Select.Content>
				</Select.Root>
				<p class="text-xs text-muted-foreground">
					Скан подписанного экземпляра собранного документа загружайте его новой редакцией: он
					остаётся тем же документом, и отметка «{DOCUMENT_STATUS_FACT_LABELS.approved}» на нём
					засчитывается стадией. Отдельный документ её не закроет.
				</p>
			</div>
		{/if}

		{#if uploadTarget !== ''}
			<input type="hidden" name="supersedesId" value={uploadTarget} />
			<div class="flex flex-col gap-1.5">
				<Label for="card-upload-note">Что изменилось</Label>
				<Input
					id="card-upload-note"
					name="note"
					maxlength={500}
					placeholder="Например: подписанный сторонами скан"
					bind:value={uploadNote}
				/>
			</div>
		{:else}
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
						{#each uploadKinds as kind (kind)}
							<Select.Item value={kind} label={DOCUMENT_KIND_LABELS[kind]} />
						{/each}
					</Select.Content>
				</Select.Root>
				{#if uploadKind === 'act'}
					<p class="text-xs text-muted-foreground">
						Подписанный акт передачи загружайте не здесь, а новой редакцией акта, собранного по
						шаблону: «Что загружаете» → «Новая редакция». Отдельно загруженный акт стадию не закроет
						— он не связан с позициями договора.
					</p>
				{/if}
			</div>
		{/if}
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
	dirty={revisionChosen.length > 0 || revisionNote.trim() !== ''}
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
		{#if revisionOf?.templateKey != null}
			<p class="text-sm text-muted-foreground">
				Документ собран по шаблону «{DOCUMENT_TEMPLATE_LABELS[revisionOf.templateKey]}». Скан
				подписанного экземпляра, загруженный здесь, остаётся тем же документом: отметка «Утверждён»
				на нём засчитывается стадией.
			</p>
		{/if}
		<FileInput
			id="card-revision-file"
			name="file"
			label="Файл новой редакции"
			required
			onchoose={(names) => (revisionChosen = names)}
		/>
		<div class="flex flex-col gap-1.5">
			<Label for="card-revision-note">Что изменилось</Label>
			<Textarea
				id="card-revision-note"
				name="note"
				rows={2}
				maxlength={500}
				placeholder="Например: подписанный сторонами скан; исправлены сроки"
				bind:value={revisionNote}
			/>
			<p class="text-xs text-muted-foreground">Видно в истории редакций документа.</p>
		</div>
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
						<span class="truncate">
							{markDocument === null ? 'Выберите документ' : describeDocument(markDocument)}
						</span>
					</Select.Trigger>
					<Select.Content>
						{#each markCandidates as document (document.id)}
							<Select.Item value={document.id} label={describeDocument(document)} />
						{/each}
					</Select.Content>
				</Select.Root>
				{#if markTemplate !== null}
					<p class="text-xs text-muted-foreground">
						Стадия засчитывает только «{DOCUMENT_TEMPLATE_LABELS[markTemplate]}», собранный по
						шаблону. Путь: «Собрать пакет документов» в панели «Документы» → подписанный скан
						загрузить новой редакцией собранного документа («Загрузить» → «Что загружаете» → «Новая
						редакция») → отметить «{DOCUMENT_STATUS_FACT_LABELS.approved}».
					</p>
				{:else if markCandidates.length === 0}
					<p class="text-xs text-muted-foreground">
						Подходящих документов нет — загрузите подписанный файл в панели «Документы».
					</p>
				{/if}
				{#if markForeign.length > 0}
					<InlineHint tone="warning">
						<span>
							{markForeign.map((document) => `«${document.title}»`).join(', ')}
							{markForeign.length === 1 ? 'не собран' : 'не собраны'} по шаблону — отметка на
							{markForeign.length === 1 ? 'нём' : 'них'} стадию не закроет. Загрузите скан как новую редакцию
							собранного документа.
						</span>
					</InlineHint>
				{/if}
			</div>
		{:else}
			<p class="text-sm font-medium break-words">
				{markDocument === null ? '' : describeDocument(markDocument)}
			</p>
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
	description="Каждый документ соберётся в DOCX и PDF. Реквизиты, позиции договора, программы, сроки и стоимость берутся из карточек; здесь — только то, чего в справочнике нет. Документ, уже собранный в деле, получит новую редакцию: прежняя останется в истории."
	width="lg"
>
	<form
		id="card-package-form"
		method="POST"
		action="?/package"
		novalidate
		use:enhance={packageSubmit}
		class="flex flex-col gap-3"
	>
		<fieldset class="flex flex-col gap-2">
			<legend class="mb-1 text-sm font-medium">Документы</legend>
			{#each packageCommand?.templates ?? [] as template (template)}
				{@const outcome = outcomeOf(template)}
				{@const built = builtOf(template)}
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
						{#if built.length > 0 && outcome === null}
							<span class="text-xs text-muted-foreground">
								Уже в деле: {built
									.map(
										(document) =>
											`${documentFormat(document.mime)?.toUpperCase() ?? document.mime}, ред. ${revisionNo(document.id)} от ${formatDate(document.createdAt)}${document.approvedAt === null ? '' : `, ${DOCUMENT_STATUS_FACT_LABELS.approved.toLowerCase()}`}`
									)
									.join('; ')}. Новая сборка встанет новой редакцией{built.some(
									(document) => document.approvedAt !== null
								)
									? ' — подписанный экземпляр останется в истории, стадия его не потеряет'
									: ''}.
							</span>
						{/if}
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

		{#if packageFixes.length > 0}
			<div class="flex flex-wrap gap-2">
				{#each packageFixes as fix (fix)}
					<Button size="sm" variant="outline" onclick={() => openFix(fix)}>
						{FIX_LABELS[fix]}
					</Button>
				{/each}
			</div>
		{/if}

		{#if packageDefaultsError !== null}
			<p class="text-xs text-muted-foreground">{packageDefaultsError}</p>
		{/if}

		<div class="flex flex-col gap-1.5">
			<Label for="card-package-city">
				Город подписания
				{@render requiredMark()}
			</Label>
			<Input
				id="card-package-city"
				name="city"
				placeholder="Москва"
				aria-invalid={packageErrors.city === undefined ? undefined : true}
				aria-describedby={packageErrors.city === undefined ? undefined : 'card-package-city-error'}
				oninput={() => (packageErrors.city = undefined)}
				bind:value={packageCity}
			/>
			{@render fieldError('card-package-city-error', packageErrors.city)}
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="card-package-operator-signer">
				Подписант оператора
				{@render requiredMark()}
			</Label>
			<Input
				id="card-package-operator-signer"
				name="operatorSigner"
				placeholder="директор Школы Иванов И. И."
				aria-invalid={packageErrors.operatorSigner === undefined ? undefined : true}
				aria-describedby="card-package-signer-hint{packageErrors.operatorSigner === undefined
					? ''
					: ' card-package-operator-signer-error'}"
				oninput={() => (packageErrors.operatorSigner = undefined)}
				bind:value={packageOperatorSigner}
			/>
			{@render fieldError('card-package-operator-signer-error', packageErrors.operatorSigner)}
		</div>
		{#if needsCounterpartySigner}
			<div class="flex flex-col gap-1.5">
				<Label for="card-package-counterparty-signer">
					Подписант контрагента
					{@render requiredMark()}
				</Label>
				<Input
					id="card-package-counterparty-signer"
					name="counterpartySigner"
					placeholder={packageCommand?.counterpartyKind === 'educational_institution'
						? 'ректор Петров П. П.'
						: 'генеральный директор Сидоров С. С.'}
					aria-invalid={packageErrors.counterpartySigner === undefined ? undefined : true}
					aria-describedby="card-package-signer-hint{packageErrors.counterpartySigner === undefined
						? ''
						: ' card-package-counterparty-signer-error'}"
					oninput={() => (packageErrors.counterpartySigner = undefined)}
					bind:value={packageCounterpartySigner}
				/>
				{@render fieldError(
					'card-package-counterparty-signer-error',
					packageErrors.counterpartySigner
				)}
			</div>
		{/if}
		<p id="card-package-signer-hint" class="text-xs text-muted-foreground">
			Должность и фамилия с инициалами — как в строке подписи, в именительном падеже. Во вступлении
			документа подписант назван так же: «от имени … действует директор Школы Иванов И. И.».
		</p>
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
