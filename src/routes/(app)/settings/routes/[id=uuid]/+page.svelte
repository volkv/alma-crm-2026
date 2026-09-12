<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import CopyPlusIcon from '@lucide/svelte/icons/copy-plus';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import StarIcon from '@lucide/svelte/icons/star';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
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
	import { formatDateTime, formatNumber, pluralize } from '$lib/format';
	import {
		STAGE_CATEGORIES,
		STAGE_TRANSITION_KINDS,
		type StageTransitionKind,
		type StageView
	} from '$lib/contracts/interactions';
	import { STAGE_CATEGORY_LABELS } from '../../../interactions/filters';
	import { CHECKLIST_HINT, formatChecklist, stageFormSchema, transitionFormSchema } from './schema';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	const detail = $derived(data.detail);
	const route = $derived(detail.route);
	const isDraft = $derived(route.publishedAt === null);
	const stageNames = $derived(new Map(route.stages.map((stage) => [stage.id, stage.name])));
	const stageKeys = $derived(new Map(route.stages.map((stage) => [stage.id, stage.key])));

	/**
	 * Что переход значит для процесса. Словарь местный: в карточке
	 * взаимодействия те же виды названы действиями («Вернуть: …»), а здесь —
	 * устройством маршрута, и общего названия у этих двух смыслов нет.
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
	let removing = $state<StageView | null>(null);
	let removeOpen = $state(false);
	let removeForm = $state<HTMLFormElement | null>(null);

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
			position: stage?.position ?? route.stages.length + 1,
			key: stage?.key ?? '',
			name: stage?.name ?? '',
			category: stage?.category ?? 'contact',
			slaDays: stage?.slaDays ?? 7,
			// Ноль в поле означает «стадия не протухает»: в базе это пусто, но
			// пустое числовое поле не отличить от неверно введённого.
			staleAfterDays: stage?.staleAfterDays ?? 0,
			requiresResult: stage?.requiresResult ?? false,
			requiresConfirmation: stage?.requiresConfirmation ?? false,
			checklist: stage === null ? '' : formatChecklist(stage.checklist)
		};
		$stageErrors = {};
		stageOpen = true;
	}

	function openTransition(transition: (typeof route.transitions)[number] | null) {
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
		removeOpen = true;
	}

	/** Пример в поле чек-листа: показывает обе формы записи — обязательную и нет. */
	const CHECKLIST_PLACEHOLDER = [
		'* contact_confirmed: Подтверждён контакт ответственного лица',
		'channel_agreed: Согласован канал связи'
	].join('\n');

	const stageOptions = $derived(
		route.stages.map((stage) => ({ value: stage.key, label: `${stage.position}. ${stage.name}` }))
	);
</script>

<svelte:head><title>{route.name} — LCT CRM</title></svelte:head>

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
		<Card.Title>{route.name}</Card.Title>
		<Card.Description>
			{route.description ?? 'Версия описания процесса: стадии, нормативы и переходы между ними.'}
		</Card.Description>
		<Card.Action>
			<div class="flex flex-wrap items-center gap-2">
				<Button variant="ghost" size="sm" href={resolve('/settings/routes')}>
					<ArrowLeftIcon aria-hidden="true" />
					К списку
				</Button>
				{#if isDraft}
					<form method="POST" action="?/publish">
						<Button type="submit" size="sm">
							<UploadIcon aria-hidden="true" />
							Опубликовать
						</Button>
					</form>
				{:else}
					{#if !route.isDefault}
						<form method="POST" action="?/setDefault">
							<Button type="submit" variant="outline" size="sm">
								<StarIcon aria-hidden="true" />
								Сделать маршрутом по умолчанию
							</Button>
						</form>
					{/if}
					<form method="POST" action="?/newVersion">
						<Button type="submit" size="sm" disabled={detail.draft !== null}>
							<CopyPlusIcon aria-hidden="true" />
							Новая версия
						</Button>
					</form>
				{/if}
			</div>
		</Card.Action>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		<KeyValue>
			<KeyValueRow label="Ключ маршрута" value={route.key} />
			<KeyValueRow label="Версия" value={route.version} />
			<KeyValueRow label="Состояние">
				<span class="flex flex-wrap items-center gap-1">
					{#if isDraft}
						<StatusBadge tone="warning">Черновик</StatusBadge>
					{:else}
						<StatusBadge tone="success">Опубликован</StatusBadge>
					{/if}
					{#if route.isDefault}
						<StatusBadge tone="accent">По умолчанию</StatusBadge>
					{/if}
				</span>
			</KeyValueRow>
			<KeyValueRow
				label="Опубликован"
				value={route.publishedAt === null ? null : formatDateTime(route.publishedAt)}
			/>
			<KeyValueRow label="Стадий" value={formatNumber(route.stages.length)} />
			<KeyValueRow
				label="Активных взаимодействий"
				value={formatNumber(detail.activeInteractions)}
			/>
		</KeyValue>

		{#if isDraft}
			<InlineHint tone="info">
				Черновик правится целиком и ни на одно взаимодействие не влияет: поставить запись можно
				только на опубликованную версию. После публикации маршрут замораживается — дальше изменения
				оформляются следующей версией.
			</InlineHint>
		{:else}
			<InlineHint tone="warning">
				Опубликованная версия неизменяема: по ней идут взаимодействия и с неё сняты слепки
				пройденных стадий — правка задним числом переписала бы историю. Чтобы изменить процесс,
				заведите новую версию: она заводится копией этой.
			</InlineHint>
			{#if detail.draft !== null}
				<InlineHint tone="warning">
					У маршрута уже есть черновая
					<a
						class="underline underline-offset-4 focus-ring"
						href={resolve('/(app)/settings/routes/[id=uuid]', { id: detail.draft.id })}
					>
						версия {detail.draft.version}
					</a>: доведите её до публикации. Второй черновик одного ключа свести не с чем — обе версии
					опубликуются, и какая из них описывает работу, станет вопросом порядка нажатий.
				</InlineHint>
			{/if}
		{/if}

		{#if isDraft && detail.issues.length > 0}
			<Alert.Root variant="destructive">
				<Alert.Title>Что мешает опубликовать</Alert.Title>
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

<Card.Root>
	<Card.Header>
		<Card.Title>Цепочка стадий</Card.Title>
		<Card.Description>
			Так маршрут выглядит в карточке взаимодействия. Здесь он показан целиком и без состояния:
			стадии ещё никто не проходил.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if route.stages.length === 0}
			<EmptyState
				title="В маршруте нет ни одной стадии"
				description="Добавьте первую стадию — без неё маршрут нельзя опубликовать."
			/>
		{:else}
			<StageTimeline
				stages={route.stages.map((stage) => ({
					id: stage.id,
					label: stage.name,
					state: 'pending' as const
				}))}
			/>
		{/if}
	</Card.Content>
</Card.Root>

<Card.Root>
	<Card.Header>
		<Card.Title>Стадии</Card.Title>
		<Card.Description>
			Ключ стадии живёт дольше её названия: по нему хранятся отметки чек-листа и слепки уже
			пройденных стадий.
		</Card.Description>
		{#if isDraft}
			<Card.Action>
				<Button size="sm" onclick={() => openStage(null)}>
					<PlusIcon aria-hidden="true" />
					Добавить стадию
				</Button>
			</Card.Action>
		{/if}
	</Card.Header>
	<Card.Content>
		{#if route.stages.length === 0}
			<EmptyState title="Стадий пока нет" />
		{:else}
			<div class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head class="w-12 text-right">№</Table.Head>
							<Table.Head>Ключ</Table.Head>
							<Table.Head>Название</Table.Head>
							<Table.Head>Группа</Table.Head>
							<Table.Head class="w-20 text-right">Норматив</Table.Head>
							<Table.Head class="w-24 text-right">Протухание</Table.Head>
							<Table.Head>Требует</Table.Head>
							<Table.Head>Чек-лист</Table.Head>
							{#if isDraft}
								<Table.Head class="w-40"></Table.Head>
							{/if}
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each route.stages as stage (stage.id)}
							<Table.Row>
								<Table.Cell class="text-right">{stage.position}</Table.Cell>
								<Table.Cell class="text-muted-foreground">{stage.key}</Table.Cell>
								<Table.Cell class="font-medium">{stage.name}</Table.Cell>
								<Table.Cell>{STAGE_CATEGORY_LABELS[stage.category]}</Table.Cell>
								<Table.Cell class="text-right">
									{pluralize(stage.slaDays, ['день', 'дня', 'дней'])}
								</Table.Cell>
								<Table.Cell class="text-right">
									{stage.staleAfterDays === null
										? '—'
										: pluralize(stage.staleAfterDays, ['день', 'дня', 'дней'])}
								</Table.Cell>
								<Table.Cell>
									<span class="flex flex-wrap gap-1">
										{#if stage.requiresResult}
											<StatusBadge tone="info">Результат</StatusBadge>
										{/if}
										{#if stage.requiresConfirmation}
											<StatusBadge tone="info">Подтверждение</StatusBadge>
										{/if}
										{#if !stage.requiresResult && !stage.requiresConfirmation}
											<span class="text-faint">—</span>
										{/if}
									</span>
								</Table.Cell>
								<Table.Cell>
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
								{#if isDraft}
									<Table.Cell>
										<span class="flex gap-1">
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

<Card.Root>
	<Card.Header>
		<Card.Title>Переходы</Card.Title>
		<Card.Description>
			Пара «откуда — куда» уникальна, поэтому пропуск стадии описывается перешагиванием, а не вторым
			переходом между теми же стадиями. Право берётся из каталога: код, которого в нём нет, не
			разрешает переход никому.
		</Card.Description>
		{#if isDraft}
			<Card.Action>
				<Button size="sm" onclick={() => openTransition(null)} disabled={route.stages.length < 2}>
					<PlusIcon aria-hidden="true" />
					Добавить переход
				</Button>
			</Card.Action>
		{/if}
	</Card.Header>
	<Card.Content>
		{#if route.transitions.length === 0}
			<EmptyState
				title="Переходов пока нет"
				description="Пока с первой стадии некуда идти, маршрут нельзя опубликовать."
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
							{#if isDraft}
								<Table.Head class="w-40"></Table.Head>
							{/if}
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each route.transitions as transition (transition.id)}
							<Table.Row>
								<Table.Cell>{stageNames.get(transition.fromStageId) ?? '—'}</Table.Cell>
								<Table.Cell>{stageNames.get(transition.toStageId) ?? '—'}</Table.Cell>
								<Table.Cell>{TRANSITION_KIND_LABELS[transition.kind]}</Table.Cell>
								<Table.Cell class="text-muted-foreground">
									{transition.requiredPermissionKey}
								</Table.Cell>
								<Table.Cell>
									{#if transition.requiresReason}
										<StatusBadge tone="warning">Обязательна</StatusBadge>
									{:else}
										<span class="text-faint">не нужна</span>
									{/if}
								</Table.Cell>
								{#if isDraft}
									<Table.Cell>
										<span class="flex gap-1">
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

<Dialog.Root bind:open={stageOpen}>
	<Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>
				{$stageData.originalKey === '' ? 'Новая стадия' : 'Стадия маршрута'}
			</Dialog.Title>
			<Dialog.Description>
				Позиция задаёт место в цепочке: номера расставятся по порядку сами.
			</Dialog.Description>
		</Dialog.Header>

		{#if $stageErrors._errors}
			<Alert.Root variant="destructive">
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
		<form method="POST" action="?/stage" use:stageEnhance novalidate class="flex flex-col gap-4">
			<input type="hidden" name="originalKey" value={$stageData.originalKey} />

			{@render numberField({
				name: 'position',
				label: 'Позиция в маршруте',
				value: $stageData.position,
				errors: $stageErrors.position,
				onchange: (next) => ($stageData.position = next)
			})}
			<FieldInput
				name="key"
				label="Ключ"
				description="Латиницей, навсегда: по нему хранятся отметки чек-листа."
				required
				bind:value={$stageData.key}
				errors={$stageErrors.key}
			/>
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
					label: 'Есть подтверждение: файл, отметка или запись LMS',
					checked: $stageData.requiresConfirmation,
					onchange: (next) => ($stageData.requiresConfirmation = next)
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
			<FormActions
				submitting={$stageSubmitting}
				submitLabel={$stageData.originalKey === '' ? 'Добавить стадию' : 'Сохранить стадию'}
				oncancel={() => (stageOpen = false)}
			/>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={transitionOpen}>
	<Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>
				{$transitionData.originalFromKey === '' ? 'Новый переход' : 'Переход маршрута'}
			</Dialog.Title>
			<Dialog.Description>
				Возврат и пропуск требуют объяснения: это отступление от плана, и без причины история стадий
				не расскажет, почему процесс пошёл не по порядку.
			</Dialog.Description>
		</Dialog.Header>

		{#if $transitionErrors._errors}
			<Alert.Root variant="destructive">
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
			<FormActions
				submitting={$transitionSubmitting}
				submitLabel={$transitionData.originalFromKey === ''
					? 'Добавить переход'
					: 'Сохранить переход'}
				oncancel={() => (transitionOpen = false)}
			/>
		</form>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={removeOpen}
	title="Удалить стадию?"
	description={removing === null
		? undefined
		: `Стадия «${removing.name}» и её чек-лист исчезнут из этой версии. Пока версия не опубликована, ни на одном взаимодействии это не скажется.`}
	confirmLabel="Удалить"
	tone="danger"
	onconfirm={() => removeForm?.requestSubmit()}
/>

<!-- Диалог только подтверждает; отправляет обычная форма — так на сервер приходит
	то же самое, что от любой другой формы раздела. -->
<form method="POST" action="?/deleteStage" bind:this={removeForm} class="hidden">
	<input type="hidden" name="key" value={removing?.key ?? ''} />
</form>
