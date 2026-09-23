<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { DOCUMENT_STATUS_FACT_LABELS } from '$lib/contracts/documents';
	import type { InteractionDocumentView, StageEntryView } from '$lib/contracts/interactions';
	import { formatDate, formatDateTime } from '$lib/format';
	import { actionEnhance } from './action-enhance';
	import LearningGroupsPanel from './learning-groups-panel.svelte';

	/**
	 * Работа на текущей стадии: чек-лист, результат и подтверждение.
	 *
	 * Переключатель чек-листа отвечает сразу, не дожидаясь сервера: отметка —
	 * самое частое действие на стадии, и ждать круговорота ради галочки незачем.
	 * Если сервер откажет, страница перезагрузит настоящее состояние.
	 */
	let {
		entry,
		documents,
		canWork
	}: {
		entry: StageEntryView | null;
		documents: readonly InteractionDocumentView[];
		/** Есть ли право двигать стадию: без него всё только для чтения. */
		canWork: boolean;
	} = $props();

	// Состояние чек-листа приезжает с сервера; собственная копия нужна только на
	// те доли секунды, пока ответ в пути, и заменяется новым ответом сама.
	let optimistic = $derived<Record<string, boolean>>({ ...(entry?.checklistState ?? {}) });
	let forms = $state<Record<string, HTMLFormElement | null>>({});

	/** Чем закрывают стадию; список отправляет выбранное скрытым полем. */
	const CONFIRM_KINDS = [
		{ value: 'mark', label: 'Отметка ответственного' },
		{ value: 'file', label: 'Документ взаимодействия' },
		{ value: 'lms_record', label: 'Запись в системе обучения' }
	] as const;

	type ConfirmKind = (typeof CONFIRM_KINDS)[number]['value'];

	let confirmKind = $state<ConfirmKind>('mark');
	let documentId = $state('');

	const confirmKindLabel = $derived(
		CONFIRM_KINDS.find((kind) => kind.value === confirmKind)?.label ?? ''
	);
	const documentTitle = $derived(
		documents.find((document) => document.id === documentId)?.title ?? 'Выберите документ'
	);

	async function toggle(key: string, checked: boolean) {
		optimistic = { ...optimistic, [key]: checked };
		await tick();
		forms[key]?.requestSubmit();
	}

	/** Отметка по документу, которую стадия ждёт; `null` — не ждёт никакой. */
	const requiredMark = $derived(entry?.snapshot.requiresDocumentMark ?? null);
	/**
	 * Отметка, которой стадия уже подтверждена. Считается только отметка того
	 * вида, который стадия ждёт: «Согласован» вместо «Утверждён» — это не
	 * выполненное требование, а другая отметка.
	 */
	const documentMark = $derived(
		requiredMark === null || entry?.documentMarkEvidence?.mark !== requiredMark
			? null
			: entry.documentMarkEvidence
	);
</script>

{#if entry === null}
	<InlineHint>Взаимодействие не стоит ни на одной стадии.</InlineHint>
{:else}
	<div class="grid items-start gap-4 lg:grid-cols-2">
		<!-- Якорь: из блока «Что мешает» ведёт ссылка прямо сюда, а не «поищите
			ниже по странице». Отступ прокрутки — под липкую шапку вместе с полосой
			демо-режима: она липкая с ней заодно. -->
		<Card.Root size="sm" id="stage-checklist" class="scroll-mt-28">
			<Card.Header>
				<Card.Title>Чек-лист стадии</Card.Title>
				<Card.Description>
					Обязательные пункты закрывают путь дальше, пока не отмечены.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				{#if entry.snapshot.checklist.length === 0}
					<p class="text-sm text-muted-foreground">У этой стадии чек-листа нет.</p>
				{/if}

				{#each entry.snapshot.checklist as item (item.key)}
					<form
						method="POST"
						action="?/checklist"
						use:enhance={actionEnhance()}
						bind:this={forms[item.key]}
					>
						<input type="hidden" name="key" value={item.key} />
						<input type="hidden" name="done" value={String(optimistic[item.key] === true)} />
						<Label class="flex items-start gap-3 font-normal">
							<Switch
								checked={optimistic[item.key] === true}
								disabled={!canWork}
								aria-label={item.label}
								onCheckedChange={(checked) => void toggle(item.key, checked === true)}
							/>
							<span class="flex flex-col gap-0.5">
								<span>{item.label}</span>
								{#if item.required}
									<span class="text-xs text-muted-foreground">обязательный</span>
								{/if}
							</span>
						</Label>
					</form>
				{/each}
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Результат и подтверждение</Card.Title>
				<Card.Description>
					{entry.snapshot.requiresResult ? 'Стадия требует результата. ' : ''}{entry.snapshot
						.requiresConfirmation
						? 'Стадия требует подтверждения.'
						: ''}
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<form
					method="POST"
					action="?/result"
					use:enhance={actionEnhance()}
					class="flex flex-col gap-2"
				>
					<Label for="resultText">Результат стадии</Label>
					<Textarea
						id="resultText"
						name="resultText"
						rows={3}
						disabled={!canWork}
						value={entry.resultText ?? ''}
						placeholder="Что получилось на этой стадии"
					/>
					<div class="flex justify-end">
						<Button type="submit" size="sm" variant="outline" disabled={!canWork}>
							Сохранить результат
						</Button>
					</div>
				</form>

				{#if requiredMark !== null}
					<div class="flex flex-col gap-2 border-t border-border pt-4">
						{#if documentMark === null}
							<InlineHint tone="warning">
								Стадии нужна отметка «{DOCUMENT_STATUS_FACT_LABELS[requiredMark]}» по документу дела
								— её ещё не поставили. Поставить её можно во вкладке «Документы»: стадию закрывает
								сам документ, а не отметка ответственного.
							</InlineHint>
						{:else}
							<p class="flex flex-wrap items-center gap-2 text-sm">
								<StatusBadge tone="success" dot>Подтверждено отметкой документа</StatusBadge>
								<span class="text-muted-foreground">
									«{documentMark.title}» от {formatDate(new Date(documentMark.markedAt))}
								</span>
								<a
									class="rounded text-sm underline-offset-4 focus-ring hover:underline"
									href={resolve('/(app)/documents/[id=uuid]', { id: documentMark.documentId })}
								>
									Открыть документ
								</a>
							</p>
						{/if}
					</div>
				{/if}

				<div class="flex flex-col gap-2 border-t border-border pt-4">
					{#if entry.confirmation !== null}
						<p class="flex flex-wrap items-center gap-2 text-sm">
							<StatusBadge tone="success" dot>Подтверждено</StatusBadge>
							<span class="text-muted-foreground">
								{entry.confirmation.kind === 'file'
									? 'файлом'
									: entry.confirmation.kind === 'mark'
										? 'отметкой ответственного'
										: entry.confirmation.kind === 'document_mark'
											? `отметкой «${DOCUMENT_STATUS_FACT_LABELS[entry.confirmation.mark]}» по документу`
											: `записью в системе обучения (${entry.confirmation.source})`}
								{entry.confirmedAt ? `, ${formatDateTime(entry.confirmedAt)}` : ''}
							</span>
						</p>
					{/if}

					<form
						method="POST"
						action="?/confirm"
						use:enhance={actionEnhance()}
						class="flex flex-col gap-2"
					>
						<input type="hidden" name="fromStageId" value={entry.stageId} />

						<Label for="confirmKind">Чем подтверждаем</Label>
						<Select.Root
							type="single"
							name="kind"
							disabled={!canWork}
							bind:value={() => confirmKind, (next) => (confirmKind = next as ConfirmKind)}
						>
							<Select.Trigger id="confirmKind" class="w-full">{confirmKindLabel}</Select.Trigger>
							<Select.Content>
								{#each CONFIRM_KINDS as kind (kind.value)}
									<Select.Item value={kind.value} label={kind.label} />
								{/each}
							</Select.Content>
						</Select.Root>

						{#if confirmKind === 'file'}
							<Select.Root type="single" name="documentId" bind:value={documentId}>
								<Select.Trigger aria-label="Документ подтверждения" class="w-full">
									{documentTitle}
								</Select.Trigger>
								<Select.Content>
									{#each documents as document (document.id)}
										<Select.Item value={document.id} label={document.title} />
									{/each}
								</Select.Content>
							</Select.Root>
							{#if documents.length === 0}
								<p class="text-xs text-muted-foreground">
									Документов пока нет — загрузите файл во вкладке «Документы».
								</p>
							{:else if documentId === ''}
								<!-- Документ подтверждения уходит в историю стадии, поэтому он
									выбирается, а не подставляется первым из списка. -->
								<p class="text-xs text-muted-foreground">
									Выберите документ: он останется в истории как подтверждение стадии.
								</p>
							{/if}
						{:else if confirmKind === 'lms_record'}
							<div class="grid gap-2 sm:grid-cols-2">
								<Input name="source" aria-label="Система обучения" placeholder="Например, moodle" />
								<Input
									name="recordId"
									aria-label="Идентификатор записи"
									placeholder="Идентификатор записи"
								/>
							</div>
						{/if}

						<div class="flex justify-end">
							<Button
								type="submit"
								size="sm"
								disabled={!canWork ||
									(confirmKind === 'file' && (documents.length === 0 || documentId === ''))}
							>
								Подтвердить стадию
							</Button>
						</div>
					</form>
				</div>
			</Card.Content>
		</Card.Root>

		<LearningGroupsPanel {entry} {canWork} />
	</div>
{/if}
