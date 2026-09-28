<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { page } from '$app/state';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import FormField from '$lib/components/form/form-field.svelte';
	import FormGrid from '$lib/components/form/form-grid.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import ProcessCardForm from '$lib/components/process-editor/process-card-form.svelte';
	import ProcessPreview from '$lib/components/process-editor/process-preview.svelte';
	import StageRequirements from '$lib/components/process-editor/stage-requirements.svelte';
	import StageStrip from '$lib/components/interaction-card/stage-strip.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import Flash from '$lib/components/directory/flash.svelte';
	import { formatNumber, pluralize } from '$lib/format';
	import { keyFromName, STAGE_KEY_STYLE } from '$lib/key-from-name';
	import {
		DOCUMENT_STATUS_FACTS,
		DOCUMENT_STATUS_FACT_LABELS,
		DOCUMENT_TEMPLATE_KEYS,
		DOCUMENT_TEMPLATE_LABELS
	} from '$lib/contracts/documents';
	import { LEARNING_PURPOSES, LEARNING_PURPOSE_LABELS } from '$lib/contracts/exchange';
	import {
		STAGE_CATEGORIES,
		STAGE_ENTER_NOTIFY_LABELS,
		STAGE_ENTER_NOTIFY_TARGETS,
		STAGE_TRANSITION_KINDS,
		type StageTransitionKind,
		type StageView
	} from '$lib/contracts/interactions';
	import { STAGE_CATEGORY_LABELS } from '../../../w/[workspace]/interactions/filters';
	import { offeredChecklistActions, offeredChecklistRules } from '$lib/platform/checklist';
	import { stageFormSchema, transitionFormSchema } from './schema';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	const detail = $derived(data.detail);
	const workflow = $derived(detail.workflow);
	const draft = $derived(detail.draft);
	/** На экране правится черновик, а без него читается действующий процесс. */
	const shown = $derived(draft ?? detail.active);
	const editable = $derived(draft !== null);
	const stageNames = $derived(new Map((shown?.stages ?? []).map((s) => [s.id, s.name])));
	const stageKeys = $derived(new Map((shown?.stages ?? []).map((s) => [s.id, s.key])));
	/**
	 * Номер стадии — её место в цепочке сейчас. Позиция в базе после удаления
	 * стадии остаётся с пропуском («1, 3, 4»), а человек считает по порядку.
	 */
	const stageNumbers = $derived(
		new Map((shown?.stages ?? []).map((s, index) => [s.id, index + 1]))
	);

	/**
	 * Переходы в порядке цепочки: по номеру стадии «откуда», затем «куда». В
	 * черновике они лежат в порядке заведения, и добавленный последним шаг из
	 * первой стадии оказывался бы в конце таблицы.
	 */
	const orderedTransitions = $derived(
		[...(shown?.transitions ?? [])].sort(
			(left, right) =>
				(stageNumbers.get(left.fromStageId) ?? 0) - (stageNumbers.get(right.fromStageId) ?? 0) ||
				(stageNumbers.get(left.toStageId) ?? 0) - (stageNumbers.get(right.toStageId) ?? 0)
		)
	);
	const permissionLabels = $derived(
		new Map<string, string>(
			data.permissions.map((permission) => [permission.key, permission.label])
		)
	);

	/**
	 * Разделы редактора. Цепочка стадий — то, ради чего экран открывают,
	 * поэтому она первая и открыта по умолчанию; состав карточки правится
	 * редко и черновика не касается; последствия черновика — отдельно, чтобы
	 * их читали целиком, а не между двумя таблицами.
	 */
	const TABS = ['stages', 'card', 'changes'] as const;
	type Tab = (typeof TABS)[number];

	let tab = $state<Tab>('stages');

	// Раздел открывается по якорю адреса: ссылки «Состав карточки» из
	// настроек модулей ведут сразу в него. Читается после гидрации: на сервере
	// якоря адреса нет.
	onMount(() => {
		const hash = page.url.hash.slice(1);

		if ((TABS as readonly string[]).includes(hash)) {
			tab = hash as Tab;
		}
	});

	/**
	 * Что переход значит для процесса. Словарь местный: в карточке
	 * взаимодействия те же виды названы действиями («Вернуть: …»), а здесь —
	 * устройством процесса, и общего названия у этих двух смыслов нет.
	 */
	const TRANSITION_KIND_LABELS: Record<StageTransitionKind, string> = {
		forward: 'Шаг вперёд',
		return: 'Возврат на доработку',
		skip: 'Пропуск стадии'
	};

	/** Успех действия без формы; отказ приходит тем же путём, но без `ok`. */
	const notice = $derived(
		actionResult !== null && 'ok' in actionResult ? actionResult.message : null
	);
	const refusal = $derived(
		actionResult !== null && !('ok' in actionResult) && 'message' in actionResult
			? actionResult
			: null
	);

	let stageOpen = $state(false);
	let transitionOpen = $state(false);
	let applyOpen = $state(false);
	let discardOpen = $state(false);
	let discardForm = $state<HTMLFormElement | null>(null);
	let removing = $state<StageView | null>(null);
	let removeOpen = $state(false);
	let removeTarget = $state('');

	const {
		form: stageData,
		errors: stageErrors,
		enhance: stageEnhance,
		submitting: stageSubmitting
	} = superForm(
		untrack(() => data.stageForm),
		{
			// Чек-лист — список пунктов, а не строка: форма уходит целиком,
			// как описано в схеме, без разбора полей по именам.
			dataType: 'json',
			validators: zod4Client(stageFormSchema),
			onUpdated: ({ form }) => {
				if (form.message) {
					toast.success(String(form.message));
					stageOpen = false;
				}
			}
		}
	);

	const {
		form: transitionData,
		errors: transitionErrors,
		enhance: transitionEnhance,
		submitting: transitionSubmitting
	} = superForm(
		untrack(() => data.transitionForm),
		{
			validators: zod4Client(transitionFormSchema),
			onUpdated: ({ form }) => {
				if (form.message) {
					toast.success(String(form.message));
					transitionOpen = false;
				}
			}
		}
	);

	/**
	 * Ключ новой стадии правили руками: тогда название его больше не
	 * переписывает. Пока не правили — ключ следует за названием.
	 */
	let keyEdited = $state(false);

	/**
	 * Ключи, которые новой стадии предлагать нельзя: стадии черновика и ключи,
	 * снятые прошлыми применениями, — они заняты навсегда.
	 */
	const takenStageKeys = $derived(
		new Set([...(shown?.stages ?? []).map((stage) => stage.key), ...detail.retiredStageKeys])
	);

	function renameStage(next: string) {
		$stageData.name = next;

		if ($stageData.originalKey === '' && !keyEdited) {
			$stageData.key = keyFromName(next, STAGE_KEY_STYLE, takenStageKeys);
		}
	}

	/** Стадия в форме: пусто — заводится новая и встаёт в конец цепочки. */
	function openStage(stage: StageView | null) {
		keyEdited = false;
		$stageData = {
			originalKey: stage?.key ?? '',
			position: stage?.position ?? (shown?.stages.length ?? 0) + 1,
			key: stage?.key ?? '',
			name: stage?.name ?? '',
			category: stage?.category ?? 'contact',
			slaDays: stage?.slaDays ?? 7,
			// Пусто — тишину по делу не подсвечивать.
			staleAfterDays: stage?.staleAfterDays ?? null,
			requiresResult: stage?.requiresResult ?? false,
			requiresConfirmation: stage?.requiresConfirmation ?? false,
			requiresLmsData: stage?.requiresLmsData ?? false,
			// Пустая строка — «отметки не требуется»: пустой выбор в списке не
			// отличить от невыбранного.
			requiresDocumentMark: stage?.requiresDocumentMark ?? '',
			// Пустая строка — отметка на любом документе дела.
			requiresDocumentTemplate: stage?.requiresDocumentTemplate ?? '',
			// Ни одного назначения — итог группы любого назначения.
			lmsGroupPurposes: [...(stage?.lmsGroupPurposes ?? [])],
			// Пустая строка — «никого не уведомлять», по той же причине.
			onEnterNotify: stage?.onEnterNotify ?? '',
			isFinal: stage?.isFinal ?? false,
			// Пустые строки формы — «нет»: без пояснения, ручная отметка, без кнопки.
			checklist: (stage?.checklist ?? []).map((item) => ({
				key: item.key,
				label: item.label,
				required: item.required,
				help: item.help ?? '',
				rule: item.completion?.kind === 'fact' ? item.completion.rule : ('' as const),
				action: item.action ?? ''
			}))
		};
		$stageErrors = {};
		openChecklistItem = null;
		stageOpen = true;
	}

	function openTransition(
		transition: {
			id: string;
			fromStageId: string;
			toStageId: string;
			kind: StageTransitionKind;
			requiredPermissionKey: string;
			requiresReason: boolean;
		} | null
	) {
		const fromKey = transition === null ? '' : (stageKeys.get(transition.fromStageId) ?? '');
		const toKey = transition === null ? '' : (stageKeys.get(transition.toStageId) ?? '');

		$transitionData = {
			originalFromKey: fromKey,
			originalToKey: toKey,
			fromStageKey: fromKey,
			toStageKey: toKey,
			kind: transition?.kind ?? 'forward',
			requiredPermissionKey: transition?.requiredPermissionKey ?? 'stages.transition',
			requiresReason: transition?.requiresReason ?? false
		};
		$transitionErrors = {};
		transitionOpen = true;
	}

	function askRemove(stage: StageView) {
		removing = stage;
		// Пусто — цель по умолчанию: предыдущая сохранившаяся стадия. Выбор
		// стоит рядом с числом тех, кто на удаляемой стадии сейчас.
		removeTarget = '';
		removeOpen = true;
	}

	/** Сколько незавершённых взаимодействий стоит на стадии прямо сейчас. */
	function standingOn(key: string): number {
		return data.preview?.rows.find((row) => row.stageKey === key)?.interactions ?? 0;
	}

	/**
	 * Пункты чек-листа свёрнуты в строки, раскрыт один: так список читается
	 * по названиям, а поля видны только у пункта, который правят.
	 */
	let openChecklistItem = $state<number | null>(null);

	/** Новый пункт чек-листа: ключ ему соберёт сервер из названия. */
	function addChecklistItem() {
		$stageData.checklist = [
			...$stageData.checklist,
			{ key: '', label: '', required: false, help: '', rule: '', action: '' }
		];
		openChecklistItem = $stageData.checklist.length - 1;
	}

	function removeChecklistItem(index: number) {
		$stageData.checklist = $stageData.checklist.filter((_, position) => position !== index);
		if (openChecklistItem === index) {
			openChecklistItem = null;
		} else if (openChecklistItem !== null && openChecklistItem > index) {
			openChecklistItem -= 1;
		}
	}

	function checklistSummary(item: { rule: string; action: string }): string {
		const rule = offeredChecklistRules().find((candidate) => candidate.key === item.rule);
		const action = offeredChecklistActions().find((candidate) => candidate.key === item.action);
		return [
			rule ? `Данными: ${rule.label}` : 'Отметкой человека',
			action ? `кнопка «${action.label}»` : 'без кнопки'
		].join(' · ');
	}

	/**
	 * Отправка действий без формы-обёртки superforms: ответ остаётся на месте,
	 * а в адресе не застревает `?/createDraft`. Диалог, из которого ушла
	 * форма, закрывается после ответа — и при успехе, и при отказе: отказ
	 * показывается над разделами.
	 */
	function submitThen(close: () => void): SubmitFunction {
		return () =>
			async ({ update }) => {
				await update();
				close();
			};
	}

	/**
	 * Стадии, на которых карточка показывает панель системы обучения, — её
	 * видно не на всём пути, и состав карточки говорит об этом заранее.
	 */
	const lmsStageNames = $derived(
		(detail.active?.stages ?? [])
			.filter((stage) => stage.requiresLmsData)
			.map((stage) => stage.name)
	);

	const stageOptions = $derived(
		(shown?.stages ?? []).map((stage) => ({
			value: stage.key,
			label: `${stageNumbers.get(stage.id)}. ${stage.name}`
		}))
	);

	/**
	 * Куда можно перенести записи удаляемой стадии: все остальные стадии, с
	 * номерами, которые у них будут после удаления, — без дыры на месте
	 * удаляемой.
	 */
	const removeTargets = $derived(
		(shown?.stages ?? [])
			.filter((stage) => stage.key !== removing?.key)
			.map((stage, index) => ({
				value: stage.key,
				label: `${index + 1}. ${stage.name}`
			}))
	);

	/**
	 * Пространства, которым процесс назначен. Это и есть ответ на вопрос «чью
	 * работу я сейчас меняю»: публикация переносит незавершённые взаимодействия
	 * всех этих пространств разом, и сказать об этом надо до применения, а не
	 * числом в отчёте после.
	 */
	const appliedIn = $derived(detail.workspaces);

	/** Сколько стадий черновик меняет относительно действующего процесса. */
	const changedStages = $derived(
		(data.preview?.rows ?? []).filter((row) => row.change !== 'kept').length
	);

	function toggle<T>(list: T[], item: T, on: boolean): T[] {
		return on
			? [...list.filter((value) => value !== item), item]
			: list.filter((value) => value !== item);
	}

	const days = (count: number) => pluralize(count, ['день', 'дня', 'дней']);
</script>

<svelte:head><title>{workflow.name} — процесс — Альма CRM</title></svelte:head>

{#snippet numberField({
	name,
	label,
	description,
	value,
	errors,
	required = false,
	onchange
}: {
	name: string;
	label: string;
	description?: string;
	value: number | null;
	errors: string[] | undefined;
	required?: boolean;
	onchange: (next: number | null) => void;
})}
	<FormField {name} {label} {description} {errors} {required}>
		{#snippet control({ id, describedBy, invalid })}
			<!-- Пустое поле — это `null`, а не ноль: ноль здесь означал бы настоящее
				значение, и схема отказывает пустому обязательному полю словами. -->
			<Input
				{id}
				{name}
				type="number"
				inputmode="numeric"
				value={value ?? ''}
				aria-invalid={invalid}
				aria-describedby={describedBy}
				oninput={(event) => {
					const next = event.currentTarget.valueAsNumber;

					onchange(Number.isNaN(next) ? null : next);
				}}
			/>
		{/snippet}
	</FormField>
{/snippet}

{#snippet checkboxField({
	name,
	label,
	checked,
	onchange
}: {
	name: string;
	label: string;
	checked: boolean;
	onchange: (next: boolean) => void;
})}
	<Label class="flex items-center gap-2 font-normal">
		<Checkbox {name} {checked} onCheckedChange={(next) => onchange(next === true)} />
		{label}
	</Label>
{/snippet}

<Flash
	messages={{
		created:
			'Процесс заведён пустым. Нажмите «Описать процесс»: в черновике добавьте стадии и переходы и примените его',
		copied:
			'Процесс заведён копией и уже действует. Назначьте его пространству, а стадии правьте черновиком изменений'
	}}
/>

{#if notice}
	<Alert.Root>
		<Alert.Description>{notice}</Alert.Description>
	</Alert.Root>
{/if}

{#if refusal}
	<Alert.Root variant="destructive">
		<Alert.Title>Действие не выполнено</Alert.Title>
		<Alert.Description>
			{refusal.message}
			{#if refusal.issues && refusal.issues.length > 0}
				<ul class="mt-1 list-inside list-disc">
					{#each refusal.issues as issue (issue)}
						<li>{issue}</li>
					{/each}
				</ul>
			{/if}
		</Alert.Description>
	</Alert.Root>
{/if}

<!-- Панель состояния: что действует, есть ли черновик и что будет при его
	применении. Стоит над разделами и видна из любого из них — решение
	«применить ко всем» не должно зависеть от того, какой раздел открыт. -->
<Card.Root class="gap-3 py-4">
	<Card.Header class="px-4">
		<!-- Название процесса стоит в заголовке страницы и в крошках, поэтому
			панель отвечает не «какой процесс», а «что с ним сейчас». -->
		<Card.Title class="flex flex-wrap items-center gap-2">
			Процесс
			{#if detail.active === null}
				<StatusBadge tone="danger">Процесс не описан</StatusBadge>
			{:else}
				<StatusBadge tone="success">Действует</StatusBadge>
			{/if}
			{#if draft !== null}
				<StatusBadge tone="warning">Черновик изменений</StatusBadge>
			{/if}
		</Card.Title>
		<Card.Description>
			{#if detail.active === null && !editable}
				Стадий ещё нет. Нажмите «Описать процесс»: откроется черновик, в нём добавьте стадии и
				переходы и примените его. Пока стадий нет, создать взаимодействие в пространстве с этим
				процессом нельзя.
			{:else if detail.active === null}
				Черновик первой редакции: добавьте стадии по порядку — шаги вперёд между соседними система
				поставит сама — и примените. Дел на процессе ещё нет, переносить при применении некого.
			{:else if editable}
				Стадии и переходы правятся в черновике — копии действующего процесса. На работу он не
				влияет, пока его не применят.
			{:else}
				Стадии и переходы действующего процесса открыты только на чтение — чтобы изменить их,
				создайте черновик. Состав карточки правится сразу, без черновика.
			{/if}
		</Card.Description>
		<Card.Action>
			<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
			<div data-tour="process-group-draft" class="flex flex-wrap items-center gap-2 sm:justify-end">
				<Button variant="ghost" size="sm" href={resolve('/(app)/settings/workflows')}>
					<ArrowLeftIcon aria-hidden="true" />
					К списку
				</Button>
				<Button
					variant="ghost"
					size="sm"
					href="/audit?type=stages.process_published&type=stages.process_migrated"
				>
					<HistoryIcon aria-hidden="true" />
					Изменения процесса
				</Button>
				{#if draft === null}
					<form method="POST" action="?/createDraft" use:enhance>
						<Button type="submit" size="sm">
							<PencilIcon aria-hidden="true" />
							{detail.active === null ? 'Описать процесс' : 'Черновик изменений'}
						</Button>
					</form>
				{:else}
					<!-- Отмена черновика уничтожает всю подготовленную правку и вернуть
						её нечем: спрашиваем так же, как перед применением ко всем. -->
					<form method="POST" action="?/discardDraft" bind:this={discardForm} use:enhance>
						<Button type="button" variant="outline" size="sm" onclick={() => (discardOpen = true)}>
							Отменить черновик
						</Button>
					</form>
					<Button size="sm" onclick={() => (applyOpen = true)} disabled={detail.issues.length > 0}>
						<UploadIcon aria-hidden="true" />
						Применить ко всем
					</Button>
				{/if}
			</div>
		</Card.Action>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3 px-4">
		<dl class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
			<div class="flex flex-wrap items-center gap-1.5">
				<dt class="text-muted-foreground">Где применяется:</dt>
				<dd class="flex flex-wrap items-center gap-1">
					{#if appliedIn.length === 0}
						<span class="text-muted-foreground">
							ни одному пространству не назначен — назначение в разделе «Пространства»
						</span>
					{:else}
						{#each appliedIn as space (space.key)}
							<StatusBadge tone="neutral">{space.name}</StatusBadge>
						{/each}
					{/if}
				</dd>
			</div>
			<div class="flex items-center gap-1.5">
				<dt class="text-muted-foreground">Стадий в действующем:</dt>
				<dd class="font-medium">{formatNumber(workflow.stageCount)}</dd>
			</div>
			<div class="flex items-center gap-1.5">
				<dt class="text-muted-foreground">Незавершённых взаимодействий:</dt>
				<dd class="font-medium">{formatNumber(workflow.activeInteractions)}</dd>
			</div>
		</dl>

		{#if editable && data.preview !== null}
			<!-- Последствия черновика в одну строку: сколько переедет и сколько
				стадий меняется. Полный разбор — в разделе «Изменения» и ещё раз
				перед применением. -->
			<div
				class="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm"
			>
				<span>
					Изменённых стадий: <strong>{formatNumber(changedStages)}</strong>
				</span>
				<span>
					Переедут на другую стадию: <strong>{formatNumber(data.preview.affected)}</strong>
				</span>
				<Button variant="link" size="sm" class="h-auto px-0" onclick={() => (tab = 'changes')}>
					Что изменится
				</Button>
			</div>
		{/if}

		{#if editable && detail.issues.length > 0}
			<Alert.Root variant="destructive">
				<Alert.Title>Что мешает применить черновик</Alert.Title>
				<Alert.Description>
					<ul class="list-inside list-disc">
						{#each detail.issues as issue (issue)}
							<li>{issue}</li>
						{/each}
					</ul>
				</Alert.Description>
			</Alert.Root>
		{/if}
	</Card.Content>
</Card.Root>

<Tabs.Root bind:value={tab}>
	<Tabs.List variant="line" aria-label="Разделы процесса">
		<Tabs.Trigger value="stages">Стадии и переходы</Tabs.Trigger>
		<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`):
			раздел закрыт по умолчанию, поэтому подсказка указывает на его вкладку. -->
		<Tabs.Trigger value="card" data-tour="process-group-card">Состав карточки</Tabs.Trigger>
		<Tabs.Trigger value="changes">
			Изменения
			{#if editable}
				<StatusBadge tone="warning">черновик</StatusBadge>
			{/if}
		</Tabs.Trigger>
	</Tabs.List>

	<Tabs.Content value="stages" class="flex flex-col gap-4 pt-2">
		{#if shown === null}
			<EmptyState
				title="В процессе нет ни одной стадии"
				description="Нажмите «Описать процесс» вверху: откроется черновик, и в нём можно добавить первую стадию."
			/>
		{:else}
			<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
			<Card.Root data-tour="process-group-stages">
				<Card.Header>
					<Card.Title>Стадии</Card.Title>
					<Card.Description>
						{editable
							? 'Строка открывает форму стадии. Порядок, норматив и требования к шагу вперёд правятся в черновике.'
							: 'Порядок стадий, нормативы и что требуется на шаге вперёд.'}
					</Card.Description>
					{#if editable}
						<Card.Action>
							<Button size="sm" onclick={() => openStage(null)}>
								<PlusIcon aria-hidden="true" />
								Добавить стадию
							</Button>
						</Card.Action>
					{/if}
				</Card.Header>
				<Card.Content class="flex flex-col gap-4">
					{#if shown.stages.length === 0}
						<EmptyState
							title="Стадий пока нет"
							description="Добавьте первую стадию — без неё процесс нельзя применить."
						/>
					{:else}
						<!-- Цепочка целиком и без состояния — та же полоса, что в карточке
							взаимодействия, пока стадии ещё никто не проходил: отрезок на
							стадию во всю ширину, без прокрутки. Названия с номерами — в
							таблице ниже. -->
						<StageStrip
							stages={shown.stages.map((stage, index) => ({
								id: stage.id,
								position: index + 1,
								name: stage.name,
								state: 'pending' as const,
								note: null
							}))}
						/>
						<div class="overflow-x-auto">
							<Table.Root>
								<Table.Header>
									<Table.Row class="hover:bg-transparent">
										<Table.Head class="w-10 text-right">№</Table.Head>
										<Table.Head>Стадия</Table.Head>
										<Table.Head class="w-24 text-right">Норматив</Table.Head>
										<!-- «Без событий» и чек-лист уезжают строкой под название, пока окно
											уже 1536: на экране в 1280–1366 точек стадия, её норматив и
											требования к переходу обязаны помещаться без горизонтальной
											прокрутки (`docs/design.md`, «Приоритет колонок»). -->
										<Table.Head class="hidden w-28 text-right 2xl:table-cell"
											>Без событий</Table.Head
										>
										<Table.Head>Требования и уведомление</Table.Head>
										<Table.Head class="hidden 2xl:table-cell">Чек-лист</Table.Head>
										{#if editable}
											<Table.Head class="w-12"><span class="sr-only">Удаление</span></Table.Head>
										{/if}
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each shown.stages as stage (stage.id)}
										<!-- В черновике строка открывает форму стадии. Нажатие ловит сама
											строка, а кнопка с названием нужна клавиатуре: её нажатие
											всплывает сюда же. -->
										<Table.Row
											class={editable ? 'cursor-pointer' : undefined}
											onclick={editable ? () => openStage(stage) : undefined}
										>
											<Table.Cell class="text-right align-top text-muted-foreground">
												{stageNumbers.get(stage.id)}
											</Table.Cell>
											<Table.Cell class="align-top whitespace-normal">
												<span class="flex flex-wrap items-center gap-2">
													{#if editable}
														<button
															type="button"
															class="rounded-sm text-left font-medium text-link focus-ring hover:text-link-hover hover:underline"
														>
															{stage.name}
														</button>
													{:else}
														<span class="font-medium">{stage.name}</span>
													{/if}
													{#if stage.isFinal}
														<StatusBadge tone="accent">Финальная</StatusBadge>
													{/if}
												</span>
												<!-- Смысловая группа и ключ — сведения для настройки, не для
													чтения цепочки: мелко и после названия. Ключ — последним. -->
												<span class="mt-0.5 block text-xs text-muted-foreground">
													{STAGE_CATEGORY_LABELS[stage.category]}<span class="2xl:hidden"
														>{stage.staleAfterDays === null
															? ''
															: ` · без событий ${days(stage.staleAfterDays)}`}{stage.checklist
															.length === 0
															? ''
															: ` · чек-лист: ${pluralize(stage.checklist.length, ['пункт', 'пункта', 'пунктов'])}`}</span
													>
													· ключ <span class="font-mono text-faint">{stage.key}</span>
												</span>
											</Table.Cell>
											<Table.Cell class="text-right align-top">{days(stage.slaDays)}</Table.Cell>
											<Table.Cell class="hidden text-right align-top 2xl:table-cell">
												{#if stage.staleAfterDays === null}
													<span class="text-faint">—</span>
												{:else}
													{days(stage.staleAfterDays)}
												{/if}
											</Table.Cell>
											<Table.Cell class="align-top whitespace-normal">
												<StageRequirements {stage} />
											</Table.Cell>
											<Table.Cell class="hidden align-top whitespace-normal 2xl:table-cell">
												{#if stage.checklist.length === 0}
													<span class="text-faint">—</span>
												{:else}
													<ul class="flex flex-col gap-0.5">
														{#each stage.checklist as item (item.key)}
															<li class="text-xs">
																{item.label}
																{#if item.completion?.kind === 'fact'}
																	<span
																		class="text-muted-foreground"
																		title="Закрывается данными дела, а не отметкой">(данные)</span
																	>
																{/if}
																{#if item.required}
																	<span class="text-danger" title="Обязательный пункт">*</span>
																{/if}
															</li>
														{/each}
													</ul>
												{/if}
											</Table.Cell>
											{#if editable}
												<Table.Cell class="align-top">
													<Button
														variant="ghost"
														size="icon-sm"
														aria-label="Удалить стадию «{stage.name}»"
														title="Удалить стадию"
														onclick={(event: MouseEvent) => {
															// Строка под кнопкой открывает форму стадии.
															event.stopPropagation();
															askRemove(stage);
														}}
													>
														<Trash2Icon aria-hidden="true" />
													</Button>
												</Table.Cell>
											{/if}
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>

			<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
			<Card.Root data-tour="process-group-transitions">
				<Card.Header>
					<Card.Title>Переходы</Card.Title>
					<Card.Description>
						Ветвление — это несколько шагов вперёд с одной стадии; отдельной «развилки» в процессе
						нет. Пара «откуда — куда» уникальна, поэтому пропуск описывается перешагиванием.
					</Card.Description>
					{#if editable}
						<Card.Action>
							<Button
								size="sm"
								onclick={() => openTransition(null)}
								disabled={shown.stages.length < 2}
							>
								<PlusIcon aria-hidden="true" />
								Добавить переход
							</Button>
						</Card.Action>
					{/if}
				</Card.Header>
				<Card.Content>
					{#if shown.transitions.length === 0}
						<EmptyState
							title="Переходов пока нет"
							description="Пока с первой стадии некуда идти, процесс нельзя применить."
						/>
					{:else}
						<div class="overflow-x-auto">
							<Table.Root>
								<Table.Header>
									<Table.Row class="hover:bg-transparent">
										<Table.Head>Откуда</Table.Head>
										<Table.Head>Куда</Table.Head>
										<Table.Head class="w-48">Вид</Table.Head>
										<Table.Head>Требуемое право</Table.Head>
										<Table.Head class="w-32">Причина</Table.Head>
										{#if editable}
											<Table.Head class="w-40"></Table.Head>
										{/if}
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each orderedTransitions as transition (transition.id)}
										<Table.Row>
											<Table.Cell class="whitespace-normal">
												{stageNames.get(transition.fromStageId) ?? '—'}
											</Table.Cell>
											<Table.Cell class="whitespace-normal">
												{stageNames.get(transition.toStageId) ?? '—'}
											</Table.Cell>
											<Table.Cell class="whitespace-normal">
												{TRANSITION_KIND_LABELS[transition.kind]}
											</Table.Cell>
											<Table.Cell class="whitespace-normal">
												<!-- Код права, которого нет в каталоге, никому переход не
													разрешает: тогда вместо названия виден сам код. -->
												{permissionLabels.get(transition.requiredPermissionKey) ??
													transition.requiredPermissionKey}
											</Table.Cell>
											<Table.Cell class="whitespace-normal">
												{#if transition.requiresReason}
													<StatusBadge tone="warning">Обязательна</StatusBadge>
												{:else}
													<span class="text-faint">не нужна</span>
												{/if}
											</Table.Cell>
											{#if editable}
												<Table.Cell class="whitespace-normal">
													<span class="flex flex-wrap gap-1">
														<Button
															variant="outline"
															size="sm"
															onclick={() => openTransition(transition)}
														>
															Изменить
														</Button>
														<!-- Переход — это одна строка настройки, и возвращается он тем
															же диалогом, которым заводился: подтверждать тут нечего. -->
														<form method="POST" action="?/deleteTransition" use:enhance>
															<input
																type="hidden"
																name="fromStageKey"
																value={stageKeys.get(transition.fromStageId) ?? ''}
															/>
															<input
																type="hidden"
																name="toStageKey"
																value={stageKeys.get(transition.toStageId) ?? ''}
															/>
															<Button type="submit" variant="outline" size="sm">Удалить</Button>
														</form>
													</span>
												</Table.Cell>
											{/if}
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}
	</Tabs.Content>

	<Tabs.Content value="card" class="pt-2">
		<Card.Root>
			<Card.Header>
				<Card.Title>Карточка взаимодействия</Card.Title>
				<Card.Description>
					Какие панели стоят в карточке и какие документы в ней собираются по шаблону. Сторона и её
					условия есть всегда и зависят от контрагента: у вуза — договор, продукты и лицензии, у
					физического лица — программа, поток и оплата, у юридического — договор и слушатели. Стадий
					эти настройки не касаются.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<!-- Панель состояния говорит о черновике стадий; здесь черновика нет,
					и это сказано прямо над формой, а не в конце абзаца. -->
				<InlineHint tone="info">
					Настройки карточки сохраняются сразу, без черновика, и действуют во всех пространствах
					процесса.
				</InlineHint>
				<!-- Якорь в адресе действия возвращает на этот раздел после сохранения. -->
				<ProcessCardForm card={data.card} action="?/card" lmsStages={lmsStageNames} />
			</Card.Content>
		</Card.Root>
	</Tabs.Content>

	<Tabs.Content value="changes" class="pt-2">
		<Card.Root>
			<Card.Header>
				<Card.Title>Черновик и применение</Card.Title>
				<Card.Description>
					{#if editable}
						«Применить ко всем» перенесёт на новую структуру все незавершённые взаимодействия
						{appliedIn.length === 0
							? 'тех пространств, которым процесс назначен,'
							: 'всех пространств, где он применяется,'} одной операцией: стадии сопоставляются по ключу,
						а тем, чья стадия исчезла, нужно правило переноса. Числа ниже справочные: пока их читают,
						работа идёт, и окончательные пишутся в журнал при применении.
					{:else}
						Черновика нет. Стадии и переходы действующего процесса открыты только на чтение: по ним
						идут взаимодействия и с них сняты слепки пройденных стадий. Черновик изменений создаётся
						копией кнопкой вверху, а прошлые применения — в журнале «Изменения процесса».
					{/if}
				</Card.Description>
			</Card.Header>
			{#if editable && data.preview !== null}
				<Card.Content>
					<ProcessPreview preview={data.preview} />
				</Card.Content>
			{/if}
		</Card.Root>
	</Tabs.Content>
</Tabs.Root>

<FormDialog
	bind:open={stageOpen}
	width="2xl"
	title={$stageData.originalKey === '' ? 'Добавить стадию' : 'Стадия процесса'}
	description="Название и норматив видят все, кто ведёт дела; позиция задаёт место в цепочке, номера расставятся по порядку сами."
>
	{#if $stageErrors._errors}
		<Alert.Root variant="destructive" class="mb-4">
			<Alert.Description>
				<ul class="list-inside list-disc">
					{#each $stageErrors._errors as issue (issue)}
						<li>{issue}</li>
					{/each}
				</ul>
			</Alert.Description>
		</Alert.Root>
	{/if}

	<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
	<form
		id="stage-form"
		method="POST"
		action="?/stage"
		use:stageEnhance
		novalidate
		class="flex flex-col gap-form"
	>
		<input type="hidden" name="originalKey" value={$stageData.originalKey} />

		<FieldInput
			name="name"
			label="Название"
			description="Что на этой стадии делают, а не на каком участке процесса она стоит."
			required
			bind:value={() => $stageData.name, renameStage}
			errors={$stageErrors.name}
		/>
		<FormGrid>
			{@render numberField({
				name: 'slaDays',
				label: 'Норматив, дней',
				description: 'Из него считается срок стадии.',
				value: $stageData.slaDays,
				errors: $stageErrors.slaDays,
				required: true,
				onchange: (next) => ($stageData.slaDays = next)
			})}
			{@render numberField({
				name: 'staleAfterDays',
				label: 'Без событий, дней',
				description:
					'Когда подсветить тишину по делу; пусто — не подсвечивать. Считается от последнего события.',
				value: $stageData.staleAfterDays,
				errors: $stageErrors.staleAfterDays,
				onchange: (next) => ($stageData.staleAfterDays = next)
			})}
		</FormGrid>
		<FormGrid>
			{@render numberField({
				name: 'position',
				label: 'Позиция в процессе',
				description: 'Пусто — в конец цепочки.',
				value: $stageData.position,
				errors: $stageErrors.position,
				onchange: (next) => ($stageData.position = next)
			})}
			<FieldSelect
				name="category"
				label="Смысловая группа"
				required
				options={STAGE_CATEGORIES.map((category) => ({
					value: category,
					label: STAGE_CATEGORY_LABELS[category]
				}))}
				bind:value={$stageData.category}
				errors={$stageErrors.category}
			/>
		</FormGrid>
		<fieldset class="flex min-w-0 flex-col gap-form">
			<legend class="mb-3 text-sm font-medium">Что требуется на шаге вперёд</legend>
			<div class="flex flex-col gap-form">
				{@render checkboxField({
					name: 'requiresResult',
					label: 'Записан результат стадии',
					checked: $stageData.requiresResult,
					onchange: (next) => ($stageData.requiresResult = next)
				})}
				{@render checkboxField({
					name: 'requiresConfirmation',
					label: 'Есть подтверждение: файл, отметка или запись системы обучения',
					checked: $stageData.requiresConfirmation,
					onchange: (next) => ($stageData.requiresConfirmation = next)
				})}
				{@render checkboxField({
					name: 'requiresLmsData',
					label: 'Получены данные системы обучения по взаимодействию',
					checked: $stageData.requiresLmsData,
					onchange: (next) => {
						$stageData.requiresLmsData = next;
						// Без данных обучения сужать нечего: отмеченные назначения
						// ушли бы с формой и получили бы отказ.
						if (!next) {
							$stageData.lmsGroupPurposes = [];
						}
					}
				})}
			</div>
			<FieldSelect
				name="requiresDocumentMark"
				label="Отметка по документу дела"
				description="Стадию закрывает сам документ: отметка ответственного её не заменяет."
				options={[
					{ value: '', label: 'Не требуется' },
					...DOCUMENT_STATUS_FACTS.map((fact) => ({
						value: fact,
						label: DOCUMENT_STATUS_FACT_LABELS[fact]
					}))
				]}
				bind:value={$stageData.requiresDocumentMark}
				errors={$stageErrors.requiresDocumentMark}
			/>
			<FieldSelect
				name="requiresDocumentTemplate"
				label="На каком документе"
				description="Отметка на документе другого шаблона стадию не закрывает. Отметку, поставленную до входа на стадию, система засчитывает: без шаблона стадию закроет и документ, утверждённый на прошлых стадиях."
				options={[
					{ value: '', label: 'Любой документ дела' },
					...DOCUMENT_TEMPLATE_KEYS.map((template) => ({
						value: template,
						label: DOCUMENT_TEMPLATE_LABELS[template]
					}))
				]}
				bind:value={$stageData.requiresDocumentTemplate}
				errors={$stageErrors.requiresDocumentTemplate}
			/>
			{#if $stageData.requiresLmsData}
				<fieldset class="flex min-w-0 flex-col gap-form">
					<legend class="mb-3 text-sm">Итог каких групп засчитывается</legend>
					{#each LEARNING_PURPOSES as purpose (purpose)}
						<Label class="flex items-center gap-2 font-normal">
							<Checkbox
								name="lmsGroupPurposes"
								value={purpose}
								checked={$stageData.lmsGroupPurposes.includes(purpose)}
								onCheckedChange={(next) =>
									($stageData.lmsGroupPurposes = toggle(
										$stageData.lmsGroupPurposes,
										purpose,
										next === true
									))}
							/>
							{LEARNING_PURPOSE_LABELS[purpose]}
						</Label>
					{/each}
					<span class="text-xs text-muted-foreground">
						Ни одного не отмечено — засчитывается группа любого назначения.
					</span>
					{#if $stageErrors.lmsGroupPurposes?._errors}
						<span class="text-xs text-danger"
							>{$stageErrors.lmsGroupPurposes._errors.join('; ')}</span
						>
					{/if}
				</fieldset>
			{/if}
		</fieldset>
		<FieldSelect
			name="onEnterNotify"
			label="При входе уведомить"
			description="Письмо уходит, когда дело переходит на стадию или начинается с неё. Того, кто сам перевёл дело, система не уведомляет; перенос при публикации процесса уведомлений не даёт."
			options={[
				{ value: '', label: 'Никого' },
				...STAGE_ENTER_NOTIFY_TARGETS.map((target) => ({
					value: target,
					label: STAGE_ENTER_NOTIFY_LABELS[target]
				}))
			]}
			bind:value={$stageData.onEnterNotify}
			errors={$stageErrors.onEnterNotify}
		/>
		<fieldset class="flex min-w-0 flex-col gap-form">
			<legend class="mb-3 text-sm font-medium">Место в процессе</legend>
			{@render checkboxField({
				name: 'isFinal',
				label: 'Финальная: с неё взаимодействие завершают, а не идут дальше',
				checked: $stageData.isFinal,
				onchange: (next) => ($stageData.isFinal = next)
			})}
		</fieldset>
		<!-- Чек-лист — список пунктов: название, обязательность, пояснение, чем
			закрывается и кнопка рядом. Ключ пункта собирает сервер из названия и
			больше не меняет: по нему в идущих делах хранятся отметки. -->
		<fieldset class="flex min-w-0 flex-col gap-3">
			<legend class="mb-1 text-sm font-medium">Чек-лист</legend>
			<p class="text-xs text-muted-foreground">
				Что проверить на стадии. Обязательный пункт не пускает дело дальше, пока его не отметят —
				или, если его закрывают данные дела, пока данных нет: галочкой такой пункт не закрыть.
				Кнопка рядом с пунктом открывает форму карточки, где делают работу, но сама пункт не
				закрывает.
			</p>
			{#if $stageErrors.checklist?._errors}
				<span class="text-xs text-danger">{$stageErrors.checklist._errors.join('; ')}</span>
			{/if}
			{#each $stageData.checklist as item, index (index)}
				{@const itemErrors = $stageErrors.checklist?.[index]}
				{@const expanded = openChecklistItem === index}
				<!-- Свёрнутый пункт — строка с названием и сводкой; раскрытый — поля
					пункта. Пункт с ошибкой подсвечен и в свёрнутом виде. -->
				<div
					class={[
						'min-w-0 rounded-lg border',
						itemErrors ? 'border-destructive' : 'border-border',
						expanded && 'bg-surface-muted/40'
					]}
				>
					<div class="flex items-center gap-1 pr-1">
						<button
							type="button"
							class="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-left focus-ring transition-colors hover:bg-surface-muted/60"
							aria-expanded={expanded}
							aria-controls="checklist-item-{index}"
							onclick={() => (openChecklistItem = expanded ? null : index)}
						>
							<ChevronDownIcon
								aria-hidden="true"
								class={[
									'size-4 shrink-0 text-muted-foreground transition-transform',
									!expanded && '-rotate-90'
								]}
							/>
							<span class="flex min-w-0 flex-1 flex-col gap-0.5">
								<span class="flex min-w-0 items-center gap-2">
									<span class="truncate text-sm font-medium">
										{index + 1}. {item.label.trim() || 'Новый пункт'}
									</span>
									{#if item.required}
										<StatusBadge tone="info">Обязательный</StatusBadge>
									{/if}
								</span>
								<span class="truncate text-xs text-muted-foreground">{checklistSummary(item)}</span>
							</span>
						</button>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Убрать пункт {index + 1}"
							title="Убрать пункт"
							onclick={() => removeChecklistItem(index)}
						>
							<XIcon aria-hidden="true" />
						</Button>
					</div>
					{#if expanded}
						<div
							id="checklist-item-{index}"
							class="flex min-w-0 flex-col gap-form border-t border-border px-3 pt-4 pb-4"
						>
							<FieldInput
								name="checklist-label-{index}"
								label="Название пункта"
								required
								placeholder="Например: подтверждён контакт ответственного лица"
								bind:value={$stageData.checklist[index].label}
								errors={itemErrors?.label}
							/>
							<Label class="flex items-center gap-2 font-normal">
								<Checkbox
									checked={item.required}
									onCheckedChange={(next) => ($stageData.checklist[index].required = next === true)}
								/>
								Обязательный: без него дело дальше не пойдёт
							</Label>
							<FieldInput
								name="checklist-help-{index}"
								label="Пояснение"
								placeholder="Что значит сделать пункт: например, «выберите у стороны подразделение»"
								bind:value={$stageData.checklist[index].help}
								errors={itemErrors?.help}
							/>
							<FieldSelect
								name="checklist-rule-{index}"
								label="Чем закрывается"
								options={[
									{ value: '', label: 'Отметкой человека' },
									...offeredChecklistRules().map((rule) => ({
										value: rule.key,
										label: `Данными: ${rule.label}`
									}))
								]}
								bind:value={$stageData.checklist[index].rule}
								errors={itemErrors?.rule}
							/>
							<FieldSelect
								name="checklist-action-{index}"
								label="Кнопка рядом с пунктом"
								options={[
									{ value: '', label: 'Без кнопки' },
									...offeredChecklistActions().map((action) => ({
										value: action.key,
										label: action.label
									}))
								]}
								bind:value={$stageData.checklist[index].action}
								errors={itemErrors?.action}
							/>
						</div>
					{/if}
				</div>
			{/each}
			<div>
				<Button variant="outline" size="sm" onclick={addChecklistItem}>
					<PlusIcon aria-hidden="true" />
					Добавить пункт
				</Button>
			</div>
		</fieldset>

		<!-- Ключ — техническое имя стадии: по нему хранятся отметки чек-листа,
			слепки пройденных стадий и сопоставление при изменении процесса. Людям,
			ведущим дела, он не виден, поэтому стоит последним. -->
		<fieldset class="flex min-w-0 flex-col gap-form border-t border-border pt-4">
			<legend class="sr-only">Технические сведения</legend>
			{#if $stageData.originalKey === ''}
				<FieldInput
					name="key"
					label="Ключ"
					description="Собирается из названия; поправьте, если хотите. Латиницей и навсегда: по нему сопоставляются записи при изменении процесса."
					required
					bind:value={
						() => $stageData.key,
						(next) => {
							keyEdited = true;
							$stageData.key = next;
						}
					}
					errors={$stageErrors.key}
				/>
			{:else}
				<!-- Ключ существующей стадии не правится: смена ключа неотличима от
					«удалили одну стадию и завели другую», а последствия у этих
					действий разные. Поле не показываем вовсе — отключённое поле
					выглядит как «сейчас нельзя», а здесь нельзя всегда. -->
				<input type="hidden" name="key" value={$stageData.key} />
				<KeyValue>
					<KeyValueRow label="Ключ стадии — не меняется">
						<span class="font-mono text-muted-foreground">{$stageData.key}</span>
					</KeyValueRow>
				</KeyValue>
			{/if}
		</fieldset>
	</form>

	{#snippet footer({ close })}
		<!-- Кнопки стоят вне формы и названы ею атрибутом `form`: панель прибита
			к нижнему краю слоя, а прокручивается только тело диалога. -->
		<FormActions
			form="stage-form"
			submitting={$stageSubmitting}
			submitLabel={$stageData.originalKey === '' ? 'Добавить стадию' : 'Сохранить стадию'}
			oncancel={close}
			class="border-t-0 pt-0"
		/>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={transitionOpen}
	width="lg"
	title={$transitionData.originalFromKey === '' ? 'Добавить переход' : 'Переход процесса'}
	description="Возврат и пропуск требуют объяснения: это отступление от плана, и без причины история стадий не расскажет, почему процесс пошёл не по порядку."
>
	{#if $transitionErrors._errors}
		<Alert.Root variant="destructive" class="mb-4">
			<Alert.Description>
				<ul class="list-inside list-disc">
					{#each $transitionErrors._errors as issue (issue)}
						<li>{issue}</li>
					{/each}
				</ul>
			</Alert.Description>
		</Alert.Root>
	{/if}

	<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
	<form
		id="transition-form"
		method="POST"
		action="?/transition"
		use:transitionEnhance
		novalidate
		class="flex flex-col gap-form"
	>
		<input type="hidden" name="originalFromKey" value={$transitionData.originalFromKey} />
		<input type="hidden" name="originalToKey" value={$transitionData.originalToKey} />

		<FieldSelect
			name="fromStageKey"
			label="Откуда"
			required
			options={stageOptions}
			placeholder="Выберите стадию"
			bind:value={$transitionData.fromStageKey}
			errors={$transitionErrors.fromStageKey}
		/>
		<FieldSelect
			name="toStageKey"
			label="Куда"
			required
			options={stageOptions}
			placeholder="Выберите стадию"
			bind:value={$transitionData.toStageKey}
			errors={$transitionErrors.toStageKey}
		/>
		<FieldSelect
			name="kind"
			label="Вид перехода"
			required
			options={STAGE_TRANSITION_KINDS.map((kind) => ({
				value: kind,
				label: TRANSITION_KIND_LABELS[kind]
			}))}
			bind:value={$transitionData.kind}
			errors={$transitionErrors.kind}
		/>
		<FieldSelect
			name="requiredPermissionKey"
			label="Требуемое право"
			required
			options={data.permissions.map((permission) => ({
				value: permission.key,
				label: `${permission.label} (${permission.key})`
			}))}
			placeholder="Выберите право"
			bind:value={$transitionData.requiredPermissionKey}
			errors={$transitionErrors.requiredPermissionKey}
		/>
		{@render checkboxField({
			name: 'requiresReason',
			label: 'Причина обязательна',
			checked: $transitionData.requiresReason,
			onchange: (next) => ($transitionData.requiresReason = next)
		})}
	</form>

	{#snippet footer({ close })}
		<FormActions
			form="transition-form"
			submitting={$transitionSubmitting}
			submitLabel={$transitionData.originalFromKey === ''
				? 'Добавить переход'
				: 'Сохранить переход'}
			oncancel={close}
			class="border-t-0 pt-0"
		/>
	{/snippet}
</FormDialog>

<!-- Удаление стадии — это и решение о том, куда переедут те, кто на ней стоит:
	два диалога подряд разнесли бы одно решение на два шага, и о втором забыли бы. -->
<FormDialog
	bind:open={removeOpen}
	width="lg"
	title="Удалить стадию «{removing?.name ?? ''}»?"
	description="Стадия, её чек-лист и переходы, которые её касаются, исчезнут из черновика. Ключ «{removing?.key ??
		''}» останется занятым навсегда: создать под ним другую стадию будет нельзя."
>
	<form
		id="remove-stage-form"
		method="POST"
		action="?/deleteStage"
		use:enhance={submitThen(() => (removeOpen = false))}
		class="flex flex-col gap-form"
	>
		<input type="hidden" name="key" value={removing?.key ?? ''} />

		<InlineHint tone="info">
			Если в стадию вёл один шаг вперёд и из неё выходил один, их заменит прямой шаг — цепочка не
			порвётся. Ручные ветвления вокруг стадии система не перестраивает.
		</InlineHint>

		<InlineHint tone={standingOn(removing?.key ?? '') > 0 ? 'warning' : 'info'}>
			Сейчас на этой стадии стоит незавершённых взаимодействий: {formatNumber(
				standingOn(removing?.key ?? '')
			)}. При применении черновика они переедут на выбранную стадию, а прежняя запись закроется
			исходом «перенесена».
		</InlineHint>

		<FieldSelect
			name="targetStageKey"
			label="Куда перенести записи"
			description="Пусто — предыдущая сохранившаяся стадия, а у первой — следующая."
			options={removeTargets}
			placeholder="По умолчанию"
			bind:value={removeTarget}
		/>
	</form>

	{#snippet footer({ close })}
		<FormActions
			form="remove-stage-form"
			submitLabel="Удалить стадию"
			oncancel={close}
			class="border-t-0 pt-0"
		/>
	{/snippet}
</FormDialog>

<!-- Применение ко всем: сначала числа, потом подтверждение. Предпросмотр
	справочен — пока его читают, КАМы работают, и расхождение чисел операцию не
	отменяет; фактические числа считает транзакция и пишет в журнал. -->
<FormDialog
	bind:open={applyOpen}
	width="xl"
	title={detail.active === null ? 'Применить процесс?' : 'Применить изменения ко всем?'}
	description={detail.active === null
		? 'Стадии и переходы черновика станут действующим процессом: в пространствах с ним можно будет заводить взаимодействия. Дел на процессе ещё нет — переносить некого.'
		: 'Изменение применится сразу ко всем незавершённым взаимодействиям всех пространств, которым назначен этот процесс. Записи сопоставляются по ключу стадии; переедут только те, чья стадия исчезла.'}
>
	{#if data.preview !== null}
		<ProcessPreview preview={data.preview} />
	{/if}

	<form
		id="publish-process-form"
		method="POST"
		action="?/publish"
		use:enhance={submitThen(() => (applyOpen = false))}
	></form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button variant="outline" type="button" onclick={close}>Отмена</Button>
			<Button type="submit" form="publish-process-form">Применить ко всем</Button>
		</div>
	{/snippet}
</FormDialog>

<ConfirmDialog
	bind:open={discardOpen}
	title="Отменить черновик изменений?"
	description="Черновик со всеми правками — стадиями, переходами и правилами переноса — исчезнет. Восстановить его нечем: следующий заводится заново копией действующего процесса."
	confirmLabel="Отменить черновик"
	cancelLabel="Оставить черновик"
	tone="danger"
	onconfirm={() => discardForm?.requestSubmit()}
/>
