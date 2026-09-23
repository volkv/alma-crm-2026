<script lang="ts">
	import DownloadIcon from '@lucide/svelte/icons/download';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FileSignatureIcon from '@lucide/svelte/icons/file-pen-line';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { resolve } from '$app/paths';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import {
		documentFormat,
		documentKindLabel,
		DOCUMENT_STATUS_FACTS,
		DOCUMENT_STATUS_FACT_LABELS,
		DOCUMENT_TEMPLATE_LABELS,
		type DocumentStatusFact,
		type DocumentTemplateKey,
		type DocumentSupersession
	} from '$lib/contracts/documents';
	import type { InteractionDocumentView } from '$lib/contracts/interactions';
	import { formatBytes, formatDate } from '$lib/format';
	import { getCardCommands } from './commands.svelte';
	import ContextSection from './context-section.svelte';

	/**
	 * Документы дела — какие есть сейчас и в каком они состоянии. Когда и кем
	 * документ добавлен или отмечен — это событие, и оно живёт в ленте; здесь
	 * нынешнее положение: вид, формат и поставленные отметки. Файл отдаёт
	 * отдельный маршрут — он же записывает выдачу в журнал, поэтому ссылка
	 * ведёт туда, а не на путь в хранилище.
	 *
	 * Заменённые редакции по умолчанию скрыты: панель отвечает на вопрос «что
	 * приложено к делу сейчас». Они не исчезают — переключатель возвращает их
	 * с пометкой, когда их заменили.
	 */
	let {
		documents,
		supersessions,
		templates,
		canUpload,
		canGenerate
	}: {
		documents: readonly InteractionDocumentView[];
		/** Какие из этих файлов уже заменены новой редакцией и когда. */
		supersessions: readonly DocumentSupersession[];
		/** Шаблоны, которые объявил процесс записи; других карточка не собирает. */
		templates: readonly DocumentTemplateKey[];
		canUpload: boolean;
		canGenerate: boolean;
	} = $props();

	const commands = getCardCommands();

	let showSuperseded = $state(false);

	const supersededBy = $derived(
		new Map(supersessions.map((item) => [item.documentId, item.supersededAt]))
	);
	const visible = $derived(
		showSuperseded ? documents : documents.filter((document) => !supersededBy.has(document.id))
	);

	const MARK_TONES = {
		agreed: 'success',
		approved: 'accent',
		in_effect: 'info'
	} as const satisfies Record<DocumentStatusFact, 'success' | 'accent' | 'info'>;

	function moments(document: InteractionDocumentView): Record<DocumentStatusFact, Date | null> {
		return {
			agreed: document.agreedAt,
			approved: document.approvedAt,
			in_effect: document.inEffectAt
		};
	}

	/**
	 * Поставленные отметки вместе с комментарием к каждой. Комментарий стоит
	 * внутри бейджа, а не рядом: «Утверждён» и «протокол № 14» двумя узлами
	 * читаются вслух как два разных значения.
	 */
	function marks(document: InteractionDocumentView) {
		const notes: Record<DocumentStatusFact, string | null> = {
			agreed: document.agreedNote,
			approved: document.approvedNote,
			in_effect: document.inEffectNote
		};
		const at = moments(document);

		return DOCUMENT_STATUS_FACTS.filter((fact) => at[fact] !== null).map((fact) => ({
			key: fact,
			label: DOCUMENT_STATUS_FACT_LABELS[fact],
			note: notes[fact],
			tone: MARK_TONES[fact]
		}));
	}

	/** Отметки, которых у документа ещё нет: поставленную снять нельзя. */
	const unmarked = (document: InteractionDocumentView) =>
		DOCUMENT_STATUS_FACTS.filter((fact) => moments(document)[fact] === null);

	/** Формат словом; неизвестный тип показывается как записан, а не прячется. */
	const format = (mime: string) => documentFormat(mime)?.toUpperCase() ?? mime;
</script>

<ContextSection title="Документы">
	{#snippet action()}
		{#if canUpload}
			<Button size="xs" variant="outline" onclick={() => commands.open({ kind: 'upload' })}>
				<UploadIcon aria-hidden="true" />
				Загрузить
			</Button>
		{/if}
	{/snippet}

	{#if supersessions.length > 0}
		<Label class="flex items-center gap-2 text-xs font-normal text-muted-foreground">
			<Switch
				checked={showSuperseded}
				aria-label="Показывать заменённые редакции"
				onCheckedChange={(checked) => (showSuperseded = checked === true)}
			/>
			Заменённые редакции
		</Label>
	{/if}

	{#if documents.length === 0}
		<p class="text-sm text-muted-foreground">Документов пока нет.</p>
	{:else if visible.length === 0}
		<p class="text-sm text-muted-foreground">
			Все файлы дела заменены новыми редакциями — включите переключатель, чтобы их увидеть.
		</p>
	{:else}
		<ul class="flex flex-col gap-3">
			{#each visible as document (document.id)}
				{@const current = !supersededBy.has(document.id)}
				{@const open = unmarked(document)}
				<li class="flex items-start gap-2">
					<FileTextIcon class="mt-0.5 size-4 shrink-0 text-faint" aria-hidden="true" />
					<div class="min-w-0 flex-1">
						<a
							class="rounded-sm text-sm break-words underline-offset-4 focus-ring hover:underline"
							href={resolve('/(app)/documents/[id=uuid]', { id: document.id })}
						>
							{document.title}
						</a>
						<p class="text-xs text-muted-foreground">
							{documentKindLabel(document.kind)} · {format(document.mime)} · {formatBytes(
								document.sizeBytes
							)} · {formatDate(document.createdAt)}
						</p>
						<div class="mt-1 flex flex-wrap items-center gap-1.5">
							{#if !current}
								<StatusBadge tone="neutral">
									Заменён {formatDate(supersededBy.get(document.id) ?? document.createdAt)}
								</StatusBadge>
							{/if}
							{#each marks(document) as mark (mark.key)}
								<StatusBadge tone={mark.tone} dot>
									{mark.label}{mark.note === null ? '' : `: ${mark.note}`}
								</StatusBadge>
							{/each}
						</div>
					</div>
					<div class="flex shrink-0 items-center gap-0.5">
						<Button
							variant="ghost"
							size="icon-sm"
							href={resolve('/(app)/documents/[id=uuid]/download', { id: document.id })}
							data-sveltekit-reload
							aria-label="Скачать «{document.title}»"
							title="Скачать"
						>
							<DownloadIcon aria-hidden="true" />
						</Button>
						{#if canUpload && current}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon-sm"
											aria-label="Действия с «{document.title}»"
										>
											<EllipsisIcon aria-hidden="true" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end" class="w-56">
									<DropdownMenu.Item
										disabled={open.length === 0}
										onSelect={() =>
											commands.open({ kind: 'mark', documentId: document.id, fact: null })}
									>
										{open.length === 0 ? 'Все отметки поставлены' : 'Поставить отметку'}
									</DropdownMenu.Item>
									<DropdownMenu.Item
										onSelect={() => commands.open({ kind: 'revision', documentId: document.id })}
									>
										Загрузить новую редакцию
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	<!-- Шаблон пока один — соглашение, и диалог сборки у него свой. -->
	{#if canGenerate && templates.includes('agreement')}
		<Button
			size="sm"
			variant="outline"
			class="self-start"
			onclick={() => commands.open({ kind: 'generate' })}
		>
			<FileSignatureIcon aria-hidden="true" />
			{DOCUMENT_TEMPLATE_LABELS.agreement} по шаблону
		</Button>
	{/if}
</ContextSection>
