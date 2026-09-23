<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import FormField from '$lib/components/form/form-field.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import StageTimeline from '$lib/components/stage-timeline.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatNumber, pluralize } from '$lib/format';
	import {
		DOCUMENT_STATUS_FACTS,
		DOCUMENT_STATUS_FACT_LABELS,
		DOCUMENT_TEMPLATE_KEYS,
		DOCUMENT_TEMPLATE_LABELS,
		type DocumentTemplateKey
	} from '$lib/contracts/documents';
	import {
		CARD_PANELS,
		CARD_PANEL_HINTS,
		CARD_PANEL_LABELS,
		type CardPanel
	} from '$lib/contracts/process-card';
	import {
		STAGE_CATEGORIES,
		STAGE_TRANSITION_KINDS,
		type StageChangeKind,
		type StageTransitionKind,
		type StageView
	} from '$lib/contracts/interactions';
	import { STAGE_CATEGORY_LABELS } from '../../../w/[workspace]/interactions/filters';
	import { CHECKLIST_HINT, formatChecklist, stageFormSchema, transitionFormSchema } from './schema';
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
	 * Что переход значит для процесса. Словарь местный: в карточке
	 * взаимодействия те же виды названы действиями («Вернуть: …»), а здесь —
	 * устройством процесса, и общего названия у этих двух смыслов нет.
	 */
	const TRANSITION_KIND_LABELS: Record<StageTransitionKind, string> = {
		forward: 'Шаг вперёд',
		return: 'Возврат на доработку',
		skip: 'Пропуск стадии'
	};

	/** Что стало со стадией в черновике — словами предпросмотра. */
	const CHANGE_LABELS: Record<StageChangeKind, string> = {
		kept: 'Без изменений',
		renamed: 'Переименована',
		changed: 'Параметры изменены',
		added: 'Новая',
		removed: 'Удалена'
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

	/** Стадия в форме: пусто — заводится новая и встаёт в конец цепочки. */
	function openStage(stage: StageView | null) {
		$stageData = {
			originalKey: stage?.key ?? '',
			position: stage?.position ?? (shown?.stages.length ?? 0) + 1,
			key: stage?.key ?? '',
			name: stage?.name ?? '',
			category: stage?.category ?? 'contact',
			slaDays: stage?.slaDays ?? 7,
			// Ноль в поле означает «стадия не протухает»: в базе это пусто, но
			// пустое числовое поле не отличить от неверно введённого.
			staleAfterDays: stage?.staleAfterDays ?? 0,
			requiresResult: stage?.requiresResult ?? false,
			requiresConfirmation: stage?.requiresConfirmation ?? false,
			requiresLmsData: stage?.requiresLmsData ?? false,
			// Пустая строка — «отметки не требуется»: пустой выбор в списке не
			// отличить от невыбранного.
			requiresDocumentMark: stage?.requiresDocumentMark ?? '',
			isFinal: stage?.isFinal ?? false,
			checklist: stage === null ? '' : formatChecklist(stage.checklist)
		};
		$stageErrors = {};
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

	/** Пример в поле чек-листа: показывает обе формы записи — обязательную и нет. */
	const CHECKLIST_PLACEHOLDER = [
		'* contact_confirmed: Подтверждён контакт ответственного лица',
		'channel_agreed: Согласован канал связи'
	].join('\n');

	const stageOptions = $derived(
		(shown?.stages ?? []).map((stage) => ({
			value: stage.key,
			label: `${stage.position}. ${stage.name}`
		}))
	);

	/** Куда можно перенести записи удаляемой стадии: все остальные стадии. */
	const removeTargets = $derived(
		(shown?.stages ?? [])
			.filter((stage) => stage.key !== removing?.key)
			.map((stage) => ({ value: stage.key, label: `${stage.position}. ${stage.name}` }))
	);

	/**
	 * Пространства, которым процесс назначен. Это и есть ответ на вопрос «чью
	 * работу я сейчас меняю»: публикация переносит незавершённые взаимодействия
	 * всех этих пространств разом, и сказать об этом надо до применения, а не
	 * числом в отчёте после.
	 */
	const appliedIn = $derived(detail.workspaces);

	/** Строки предпросмотра, на которых что-то меняется; «без изменений» не показываем. */
	const previewRows = $derived((data.preview?.rows ?? []).filter((row) => row.change !== 'kept'));

	/**
	 * Сколько незавершённых взаимодействий увидят изменение своей стадии, никуда
	 * не переезжая: переименование и правка параметров. Переезжающие сюда не
	 * идут — их считает `preview.affected`.
	 */
	/**
	 * Состав карточки в форме — до сохранения. Предпросмотр читает его же:
	 * администратор видит карточку такой, какой она станет, а не какой была.
	 */
	let cardPanels = $state<CardPanel[]>(untrack(() => [...data.card.panels]));
	let cardTemplates = $state<DocumentTemplateKey[]>(untrack(() => [...data.card.templates]));

	// После сохранения форма показывает то, что записано, а не то, что набрали.
	$effect(() => {
		const saved = data.card;

		untrack(() => {
			cardPanels = [...saved.panels];
			cardTemplates = [...saved.templates];
		});
	});

	const cardDirty = $derived(
		JSON.stringify(CARD_PANELS.filter((panel) => cardPanels.includes(panel))) !==
			JSON.stringify(data.card.panels) ||
			JSON.stringify(DOCUMENT_TEMPLATE_KEYS.filter((key) => cardTemplates.includes(key))) !==
				JSON.stringify(data.card.templates)
	);

	function toggle<T>(list: T[], item: T, on: boolean): T[] {
		return on
			? [...list.filter((value) => value !== item), item]
			: list.filter((value) => value !== item);
	}

	const affectedInPlace = $derived(
		previewRows
			.filter((row) => row.change === 'renamed' || row.change === 'changed')
			.reduce((total, row) => total + row.interactions, 0)
	);
</script>

<svelte:head><title>{workflow.name} — процесс — LCT CRM</title></svelte:head>

{#snippet numberField({
	name,
	label,
	description,
	value,
	errors,
	onchange
}: {
	name: string;
	label: string;
	description?: string;
	value: number;
	errors: string[] | undefined;
	onchange: (next: number) => void;
})}
	<FormField {name} {label} {description} {errors} required>
		{#snippet control({ id, describedBy, invalid })}
			<!-- Пустое поле даёт NaN, и схема скажет об этом словами; подменять его
				нулём нельзя — ноль здесь означал бы настоящее значение. -->
			<Input
				{id}
				{name}
				type="number"
				inputmode="numeric"
				{value}
				aria-invalid={invalid}
				aria-describedby={describedBy}
				oninput={(event) => onchange(event.currentTarget.valueAsNumber)}
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

<Card.Root>
	<Card.Header>
		<!-- Название процесса стоит в заголовке страницы и в крошках, поэтому
			карточка отвечает не «какой процесс», а «что с ним сейчас». -->
		<Card.Title>Процесс</Card.Title>
		<Card.Description>
			Что действует сейчас, что готовится к применению и кого это изменение затронет.
		</Card.Description>
		<Card.Action>
			<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
			<div data-tour="process-group-draft" class="flex flex-wrap items-center gap-2">
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
					<form method="POST" action="?/createDraft">
						<Button type="submit" size="sm" disabled={detail.active === null}>
							<PencilIcon aria-hidden="true" />
							Черновик изменений
						</Button>
					</form>
				{:else}
					<!-- Отмена черновика уничтожает всю подготовленную правку и вернуть
						её нечем: спрашиваем так же, как перед применением ко всем. -->
					<form method="POST" action="?/discardDraft" bind:this={discardForm}>
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
	<Card.Content class="flex flex-col gap-4">
		<KeyValue>
			<KeyValueRow label="Где применяется">
				{#if appliedIn.length === 0}
					<span class="text-muted-foreground">
						Ни одному пространству не назначен: правка этого процесса пока ничью работу не меняет.
						Назначение делается в разделе «Пространства».
					</span>
				{:else}
					<span class="flex flex-wrap items-center gap-1">
						{#each appliedIn as space (space.key)}
							<StatusBadge tone="neutral">{space.name}</StatusBadge>
						{/each}
					</span>
				{/if}
			</KeyValueRow>
			<KeyValueRow
				label="Стадий в действующем процессе"
				value={formatNumber(workflow.stageCount)}
			/>
			<KeyValueRow
				label="Незавершённых взаимодействий"
				value={formatNumber(workflow.activeInteractions)}
			/>
			<KeyValueRow label="Состояние">
				<span class="flex flex-wrap items-center gap-1">
					{#if detail.active === null}
						<StatusBadge tone="danger">Процесс не описан</StatusBadge>
					{:else}
						<StatusBadge tone="success">Действует</StatusBadge>
					{/if}
					{#if draft !== null}
						<StatusBadge tone="warning">Черновик изменений</StatusBadge>
					{/if}
				</span>
			</KeyValueRow>
		</KeyValue>

		{#if detail.active === null}
			<InlineHint tone="warning">
				В процессе ещё нет ни одной стадии: заведите черновик, опишите в нём стадии и примените его.
				Пока стадий нет, завести взаимодействие в пространстве с этим процессом нельзя — форма
				откажет словами.
			</InlineHint>
		{:else if editable}
			<InlineHint tone="info">
				Черновик изменений — копия действующего процесса. Пока он не применён, на работу он не
				влияет. «Применить ко всем» перенесёт на новую структуру все незавершённые взаимодействия
				{appliedIn.length === 0
					? 'тех пространств, которым процесс назначен,'
					: 'всех пространств, перечисленных выше,'} одной операцией: стадии сопоставляются по ключу,
				а тем, чья стадия исчезла, нужно правило переноса.
			</InlineHint>
		{:else}
			<InlineHint tone="info">
				Действующий процесс открыт только на чтение: по нему идут взаимодействия и с него сняты
				слепки пройденных стадий. Чтобы изменить его, заведите черновик изменений — он создаётся
				копией.
			</InlineHint>
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

<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
<Card.Root data-tour="process-group-card">
	<Card.Header>
		<Card.Title>Карточка взаимодействия</Card.Title>
		<Card.Description>
			Какие панели стоят в карточке и какие документы в ней собираются по шаблону. Сторона и её
			условия есть всегда и зависят от контрагента: у вуза — договор, продукты и лицензии, у
			физического лица — программа, поток и оплата, у юридического — договор и слушатели. Изменение
			действует сразу во всех пространствах процесса, без черновика: стадий оно не касается.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		<form method="POST" action="?/card" class="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem]">
			<div class="flex flex-col gap-4">
				<fieldset class="flex flex-col gap-2">
					<legend class="mb-2 text-sm font-medium">Панели</legend>
					{#each CARD_PANELS as panel (panel)}
						<Label class="flex items-start gap-2 font-normal">
							<Checkbox
								name="panels"
								value={panel}
								checked={cardPanels.includes(panel)}
								onCheckedChange={(next) => (cardPanels = toggle(cardPanels, panel, next === true))}
								class="mt-0.5"
							/>
							<span class="flex flex-col">
								{CARD_PANEL_LABELS[panel]}
								<span class="text-xs text-muted-foreground">{CARD_PANEL_HINTS[panel]}</span>
							</span>
						</Label>
					{/each}
				</fieldset>
				<fieldset class="flex flex-col gap-2">
					<legend class="mb-2 text-sm font-medium">Шаблоны документов</legend>
					{#each DOCUMENT_TEMPLATE_KEYS as template (template)}
						<Label class="flex items-center gap-2 font-normal">
							<Checkbox
								name="templates"
								value={template}
								checked={cardTemplates.includes(template)}
								onCheckedChange={(next) =>
									(cardTemplates = toggle(cardTemplates, template, next === true))}
							/>
							{DOCUMENT_TEMPLATE_LABELS[template]}
						</Label>
					{/each}
				</fieldset>
				<div>
					<Button type="submit" size="sm" disabled={!cardDirty}>Сохранить состав карточки</Button>
				</div>
			</div>

			<div class="flex flex-col gap-2 rounded-lg border border-border p-3" aria-live="polite">
				<p class="text-xs font-semibold tracking-wide text-faint uppercase">Предпросмотр</p>
				<ol class="flex list-inside list-decimal flex-col gap-1 text-sm">
					<li>Сторона и условия</li>
					{#each CARD_PANELS.filter((panel) => cardPanels.includes(panel)) as panel (panel)}
						<li>{CARD_PANEL_LABELS[panel]}</li>
					{/each}
				</ol>
				<p class="text-xs text-muted-foreground">
					{#if cardTemplates.length === 0}
						Документы по шаблону не собираются.
					{:else}
						По шаблону: {DOCUMENT_TEMPLATE_KEYS.filter((key) => cardTemplates.includes(key))
							.map((key) => DOCUMENT_TEMPLATE_LABELS[key])
							.join(', ')}.
					{/if}
				</p>
			</div>
		</form>
	</Card.Content>
</Card.Root>

{#if shown !== null}
	<Card.Root>
		<Card.Header>
			<Card.Title>Цепочка стадий</Card.Title>
			<Card.Description>
				Так процесс выглядит в карточке взаимодействия. Здесь он показан целиком и без состояния:
				стадии ещё никто не проходил.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if shown.stages.length === 0}
				<EmptyState
					title="В процессе нет ни одной стадии"
					description="Добавьте первую стадию — без неё процесс нельзя применить."
				/>
			{:else}
				<StageTimeline
					stages={shown.stages.map((stage) => ({
						id: stage.id,
						label: stage.name,
						state: 'pending' as const
					}))}
				/>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
	<Card.Root data-tour="process-group-stages">
		<Card.Header>
			<Card.Title>Стадии</Card.Title>
			<Card.Description>
				Ключ стадии живёт дольше её названия: по нему хранятся отметки чек-листа, слепки уже
				пройденных стадий и сопоставление при изменении процесса. Переименование ключа не трогает.
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
		<Card.Content>
			{#if shown.stages.length === 0}
				<EmptyState title="Стадий пока нет" />
			{:else}
				<div class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row class="hover:bg-transparent">
								<Table.Head class="w-12 text-right">№</Table.Head>
								<Table.Head>Ключ</Table.Head>
								<Table.Head>Название</Table.Head>
								<!-- Группа, протухание и чек-лист уезжают под название и под
									«Требует», пока окно уже 1536: на экране в 1280 точек таблице
									остаётся меньше тысячи, и стадия, её норматив и требования к
									переходу обязаны помещаться без горизонтальной прокрутки
									(`docs/design.md`, «Приоритет колонок»). Значения не
									пропадают — они возвращаются строкой под ключевой колонкой. -->
								<Table.Head class="hidden 2xl:table-cell">Группа</Table.Head>
								<Table.Head class="w-20 text-right">Норматив</Table.Head>
								<Table.Head class="hidden w-24 text-right 2xl:table-cell">Протухание</Table.Head>
								<Table.Head>Требует</Table.Head>
								<Table.Head class="hidden 2xl:table-cell">Чек-лист</Table.Head>
								{#if editable}
									<Table.Head class="w-40"></Table.Head>
								{/if}
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each shown.stages as stage (stage.id)}
								<Table.Row>
									<Table.Cell class="text-right">{stage.position}</Table.Cell>
									<Table.Cell class="text-muted-foreground">{stage.key}</Table.Cell>
									<Table.Cell class="font-medium whitespace-normal">
										{stage.name}
										{#if stage.isFinal}
											<StatusBadge tone="accent">Финальная</StatusBadge>
										{/if}
										<span class="block text-xs font-normal text-muted-foreground 2xl:hidden">
											{STAGE_CATEGORY_LABELS[stage.category]}{stage.staleAfterDays === null
												? ''
												: ` · протухание ${pluralize(stage.staleAfterDays, ['день', 'дня', 'дней'])}`}
										</span>
									</Table.Cell>
									<Table.Cell class="hidden whitespace-normal 2xl:table-cell">
										{STAGE_CATEGORY_LABELS[stage.category]}
									</Table.Cell>
									<Table.Cell class="text-right whitespace-normal">
										{pluralize(stage.slaDays, ['день', 'дня', 'дней'])}
									</Table.Cell>
									<Table.Cell class="hidden text-right whitespace-normal 2xl:table-cell">
										{stage.staleAfterDays === null
											? '—'
											: pluralize(stage.staleAfterDays, ['день', 'дня', 'дней'])}
									</Table.Cell>
									<Table.Cell class="whitespace-normal">
										<span class="flex flex-wrap gap-1">
											{#if stage.requiresResult}
												<StatusBadge tone="info">Результат</StatusBadge>
											{/if}
											{#if stage.requiresConfirmation}
												<StatusBadge tone="info">Подтверждение</StatusBadge>
											{/if}
											{#if stage.requiresLmsData}
												<StatusBadge tone="info">Данные обучения</StatusBadge>
											{/if}
											{#if stage.requiresDocumentMark !== null}
												<StatusBadge tone="info">
													Отметка «{DOCUMENT_STATUS_FACT_LABELS[stage.requiresDocumentMark]}»
												</StatusBadge>
											{/if}
											{#if !stage.requiresResult && !stage.requiresConfirmation && !stage.requiresLmsData && stage.requiresDocumentMark === null}
												<span class="text-faint">—</span>
											{/if}
										</span>
										{#if stage.checklist.length > 0}
											<span class="mt-0.5 block text-xs text-muted-foreground 2xl:hidden">
												чек-лист: {pluralize(stage.checklist.length, [
													'пункт',
													'пункта',
													'пунктов'
												])}
											</span>
										{/if}
									</Table.Cell>
									<Table.Cell class="hidden whitespace-normal 2xl:table-cell">
										{#if stage.checklist.length === 0}
											<span class="text-faint">—</span>
										{:else}
											<ul class="flex flex-col gap-0.5">
												{#each stage.checklist as item (item.key)}
													<li class="text-xs">
														{item.label}
														{#if item.required}
															<span class="text-danger" title="Обязательный пункт">*</span>
														{/if}
													</li>
												{/each}
											</ul>
										{/if}
									</Table.Cell>
									{#if editable}
										<Table.Cell class="whitespace-normal">
											<span class="flex flex-wrap gap-1">
												<Button variant="outline" size="sm" onclick={() => openStage(stage)}>
													Изменить
												</Button>
												<Button variant="outline" size="sm" onclick={() => askRemove(stage)}>
													Удалить
												</Button>
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

	<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
	<Card.Root data-tour="process-group-transitions">
		<Card.Header>
			<Card.Title>Переходы</Card.Title>
			<Card.Description>
				Ветвление — это несколько шагов вперёд с одной стадии; отдельной «развилки» в процессе нет.
				Пара «откуда — куда» уникальна, поэтому пропуск описывается перешагиванием. Право берётся из
				каталога: код, которого в нём нет, не разрешает переход никому.
			</Card.Description>
			{#if editable}
				<Card.Action>
					<Button size="sm" onclick={() => openTransition(null)} disabled={shown.stages.length < 2}>
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
							{#each shown.transitions as transition (transition.id)}
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
									<Table.Cell class="max-w-40 break-all whitespace-normal text-muted-foreground">
										{transition.requiredPermissionKey}
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
												<form method="POST" action="?/deleteTransition">
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

<FormDialog
	bind:open={stageOpen}
	width="lg"
	title={$stageData.originalKey === '' ? 'Новая стадия' : 'Стадия процесса'}
	description="Позиция задаёт место в цепочке: номера расставятся по порядку сами. Ключ существующей стадии не меняется — смена ключа означала бы другую работу под прежним именем."
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
		class="flex flex-col gap-4"
	>
		<input type="hidden" name="originalKey" value={$stageData.originalKey} />

		{@render numberField({
			name: 'position',
			label: 'Позиция в процессе',
			value: $stageData.position,
			errors: $stageErrors.position,
			onchange: (next) => ($stageData.position = next)
		})}
		{#if $stageData.originalKey === ''}
			<FieldInput
				name="key"
				label="Ключ"
				description="Латиницей, навсегда: по нему сопоставляются записи при изменении процесса."
				required
				bind:value={$stageData.key}
				errors={$stageErrors.key}
			/>
		{:else}
			<!-- Ключ существующей стадии не правится: смена ключа неотличима от
				«удалили одну стадию и завели другую», а последствия у этих
				действий разные. Поле не показываем вовсе — отключённое поле
				выглядит как «сейчас нельзя», а здесь нельзя всегда. -->
			<input type="hidden" name="key" value={$stageData.key} />
			<KeyValue>
				<KeyValueRow label="Ключ стадии" value={$stageData.key} />
			</KeyValue>
		{/if}
		<FieldInput
			name="name"
			label="Название"
			description="Что на этой стадии делают, а не на каком участке процесса она стоит."
			required
			bind:value={$stageData.name}
			errors={$stageErrors.name}
		/>
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
		{@render numberField({
			name: 'slaDays',
			label: 'Норматив, дней',
			description: 'Из него считается срок стадии.',
			value: $stageData.slaDays,
			errors: $stageErrors.slaDays,
			onchange: (next) => ($stageData.slaDays = next)
		})}
		{@render numberField({
			name: 'staleAfterDays',
			label: 'Протухание, дней',
			description: '0 — стадия не протухает. Считается от последнего события, а не от входа.',
			value: $stageData.staleAfterDays,
			errors: $stageErrors.staleAfterDays,
			onchange: (next) => ($stageData.staleAfterDays = next)
		})}
		<fieldset class="flex flex-col gap-2">
			<legend class="text-sm font-medium">Что требуется на шаге вперёд</legend>
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
				onchange: (next) => ($stageData.requiresLmsData = next)
			})}
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
		</fieldset>
		<fieldset class="flex flex-col gap-2">
			<legend class="text-sm font-medium">Место в процессе</legend>
			{@render checkboxField({
				name: 'isFinal',
				label: 'Финальная: с неё взаимодействие завершают, а не идут дальше',
				checked: $stageData.isFinal,
				onchange: (next) => ($stageData.isFinal = next)
			})}
		</fieldset>
		<FieldTextarea
			name="checklist"
			label="Чек-лист"
			description={CHECKLIST_HINT}
			rows={5}
			placeholder={CHECKLIST_PLACEHOLDER}
			bind:value={$stageData.checklist}
			errors={$stageErrors.checklist}
		/>
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
	title={$transitionData.originalFromKey === '' ? 'Новый переход' : 'Переход процесса'}
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
		class="flex flex-col gap-4"
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
		''}» останется занятым навсегда: завести под ним другую стадию будет нельзя."
>
	<form id="remove-stage-form" method="POST" action="?/deleteStage" class="flex flex-col gap-4">
		<input type="hidden" name="key" value={removing?.key ?? ''} />

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
	title="Применить изменения ко всем?"
	description="Изменение применится сразу ко всем незавершённым взаимодействиям всех пространств, которым назначен этот процесс. Записи сопоставляются по ключу стадии; переедут только те, чья стадия исчезла."
>
	<div class="flex flex-col gap-4">
		{#if data.preview !== null}
			<!-- Два числа, а не одно: «затронуто» на сервере считает только тех, кто
			переезжает на другую стадию, а переименование и правка параметров
			видны всем, кто стоит на изменённой стадии. Одно число рядом с
			«На ней стоит: 3» читалось как ошибка. -->
			<div class="flex flex-col gap-0.5 text-sm">
				<p>
					Переедут на другую стадию: <strong>{formatNumber(data.preview.affected)}</strong>
				</p>
				<p class="text-muted-foreground">
					Увидят изменение своей стадии, оставаясь на ней:
					<strong class="text-foreground">{formatNumber(affectedInPlace)}</strong>
				</p>
			</div>

			{#if previewRows.length === 0}
				<EmptyState
					title="Структура не изменилась"
					description="В черновике нет отличий от действующего процесса."
				/>
			{:else}
				<!-- Карточки, а не таблица: строка диффа с перечнем изменённых
				параметров растягивала таблицу до 1137 px внутри диалога шириной
				624, и колонки «На ней стоит» и «Куда переедут» — те самые числа,
				ради которых предпросмотр и открывают, — уезжали за край. -->
				<ul class="flex flex-col gap-2">
					{#each previewRows as row (row.stageKey)}
						<li class="flex flex-col gap-1.5 rounded-md border border-border p-3">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<span class="font-medium">{row.stageName}</span>
								<StatusBadge tone={row.change === 'removed' ? 'warning' : 'info'}>
									{CHANGE_LABELS[row.change]}
								</StatusBadge>
							</div>

							{#if row.changes.length > 0}
								<ul class="list-inside list-disc text-xs text-muted-foreground">
									{#each row.changes as change (change)}
										<li>{change}</li>
									{/each}
								</ul>
							{/if}

							<div class="flex flex-wrap gap-x-6 gap-y-1 text-xs">
								<span class="text-muted-foreground">
									На ней стоит:
									{#if row.interactions === 0}
										<span class="text-faint">никого нет</span>
									{:else}
										<strong class="text-foreground">{formatNumber(row.interactions)}</strong>
									{/if}
								</span>
								{#if row.change === 'removed'}
									<span class="text-muted-foreground">
										Куда переедут:
										<strong class="text-foreground">
											{row.targetStageName ?? 'предыдущая сохранившаяся стадия'}
										</strong>
									</span>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>

	<form id="publish-process-form" method="POST" action="?/publish"></form>

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
