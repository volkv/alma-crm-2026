<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CornerUpLeftIcon from '@lucide/svelte/icons/corner-up-left';
	import SkipForwardIcon from '@lucide/svelte/icons/skip-forward';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import PlayIcon from '@lucide/svelte/icons/play';
	import type { Snippet } from 'svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import SlaChip from '$lib/components/sla-chip.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { anchorHref } from '$lib/components/directory/query';
	import {
		blockerReasonLabel,
		PAUSE_REASONS,
		PAUSE_REASON_LABELS,
		type InteractionSummaryView,
		type PauseReason,
		type StageTransitionKind
	} from '$lib/contracts/interactions';
	import { formatDateTime } from '$lib/format';
	import { actionEnhance } from './action-enhance';

	/**
	 * Четыре вопроса карточки: что происходит, что мешает, кто должен действовать
	 * и что можно сделать прямо сейчас. Приговор по каждому переходу считает
	 * сервер — панель только показывает его и не прячет недоступное: кнопка с
	 * причиной объясняет процесс, отсутствие кнопки не объясняет ничего.
	 */
	let {
		summary,
		currentStageId,
		revision,
		canAttach,
		closing
	}: {
		summary: InteractionSummaryView;
		/** Стадия, с которой отдаются команды; сервер сверит её со своей. */
		currentStageId: string | null;
		/**
		 * Номер редакции процесса, по которой отрисована карточка. Едет с каждой
		 * командой перехода: если процесс изменили, пока карточка была открыта,
		 * движок откажет словами, а не сдвинет запись по правилам, которых нет.
		 */
		revision: number;
		/** Есть ли право прикладывать файлы: без него поля в диалоге нет. */
		canAttach: boolean;
		/**
		 * Команды, которые закрывают взаимодействие целиком. Они не про стадию,
		 * поэтому приезжают снаружи, но стоят там же, где остальные ответы на
		 * вопрос «что могу сейчас».
		 */
		closing?: Snippet;
	} = $props();

	/**
	 * Диалог перехода. Открывается на любом переходе, а не только там, где
	 * процесс требует объяснения: комментарий и вложения доступны всегда — это
	 * то, чем человек объясняет, чем кончилась стадия. Обязателен комментарий
	 * только у перехода с поднятым признаком причины.
	 */
	let reasonDialog = $state<{
		kind: StageTransitionKind;
		toStageId: string;
		name: string;
		requiresReason: boolean;
	} | null>(null);
	let pauseOpen = $state(false);
	// Список причин отправляет выбранное скрытым полем, поэтому в нём всегда
	// что-то выбрано: у нативного списка первый пункт выбран сам.
	let pauseReason = $state<PauseReason>(PAUSE_REASONS[0]);

	const can = (action: string) => summary.canDo.actions.includes(action as 'pause');

	/** Куда уходит форма диалога: у каждого вида перехода своё действие страницы. */
	const REASON_ACTIONS: Record<StageTransitionKind, string> = {
		forward: '?/advance',
		return: '?/return',
		skip: '?/skip'
	};

	const REASON_TITLES: Record<StageTransitionKind, string> = {
		forward: 'Перейти на следующую стадию',
		return: 'Вернуть на стадию',
		skip: 'Пропустить стадии'
	};

	const dialogKind = $derived(reasonDialog?.kind ?? 'return');
	/**
	 * Возврат и пропуск требуют объяснения всегда — это отступление от плана;
	 * шаг вперёд — только там, где так настроен процесс.
	 */
	const reasonRequired = $derived(reasonDialog?.requiresReason ?? dialogKind !== 'forward');
	const reasonLabel = $derived(dialogKind === 'forward' ? 'Комментарий' : 'Причина');

	let reason = $state('');
	let reasonError = $state<string | null>(null);

	function openTransitionDialog(next: NonNullable<typeof reasonDialog>) {
		reason = '';
		reasonError = null;
		reasonDialog = next;
	}

	function closeTransitionDialog() {
		reasonDialog = null;
		reasonError = null;
	}

	/**
	 * Проверка обязательного объяснения — своя, как в формах создания: со
	 * звёздочкой у поля, фразой по-русски под ним и сохранённым вводом. Нативный
	 * пузырь браузера говорит на своём языке, встаёт поверх соседнего блока и
	 * исчезает сам.
	 */
	function validateReason(): boolean {
		if (reasonRequired && reason.trim() === '') {
			reasonError =
				dialogKind === 'forward'
					? 'Процесс требует сказать, чем закончилась стадия'
					: 'Без причины переход не делается: напишите, что именно пошло не так';

			return false;
		}

		reasonError = null;

		return true;
	}

	/** Шаги вперёд с этой стадии: по ним и виден приговор процесса. */
	const forwardOptions = $derived(
		summary.canDo.transitions.filter((option) => option.transition.kind === 'forward')
	);
	const canStepForward = $derived(forwardOptions.some((option) => option.allowed));

	const hardBlockers = $derived(summary.blocking.blockers.filter((item) => item.blocksTransition));
	const softBlockers = $derived(summary.blocking.blockers.filter((item) => !item.blocksTransition));

	/**
	 * Помеха, запрещающая переход, приезжает в причинах отказа одной общей
	 * фразой без описания. Её мы не повторяем: сами помехи перечислены выше
	 * словами того, кто их поднял.
	 */
	const BLOCKERS_REASON = 'Есть открытые помехи, запрещающие переход';

	/**
	 * Что действительно держит взаимодействие: приговор движка по шагу вперёд.
	 * Необязательный пункт чек-листа в него не попадает — он ничего не
	 * запрещает, и в списке помех ему не место.
	 */
	const blockingReasons = $derived.by(() => {
		if (forwardOptions.length === 0 || canStepForward) return [];

		return [...new Set(forwardOptions.flatMap((option) => option.reasons))].filter(
			(text) => text !== BLOCKERS_REASON
		);
	});

	/** Незакрытое, что переходу не мешает: его показывают отдельно и иначе. */
	const notDoneYet = $derived([
		...summary.blocking.openChecklist.filter((item) => !item.required).map((item) => item.label),
		...softBlockers.map((item) => `${blockerReasonLabel(item.reasonCode)}: ${item.description}`)
	]);

	const nothingBlocks = $derived(hardBlockers.length === 0 && blockingReasons.length === 0);

	/**
	 * Дорога к чек-листу: из панели к самому списку пунктов, а не «поищите
	 * ниже». Вкладка живёт в адресе, поэтому ссылка — обычная ссылка, а якорь
	 * доводит до самой карточки чек-листа.
	 */
	const checklistHref = $derived(anchorHref(page.url, 'tab', 'work', 'stage-checklist'));
	const hasChecklist = $derived(summary.blocking.openChecklist.length > 0);
</script>

{#snippet transitionFace(kind: StageTransitionKind, text: string)}
	{#if kind === 'forward'}
		<ArrowRightIcon aria-hidden="true" />
	{:else if kind === 'return'}
		<CornerUpLeftIcon aria-hidden="true" />
	{:else}
		<SkipForwardIcon aria-hidden="true" />
	{/if}
	<span class="min-w-0">{text}</span>
{/snippet}

<!--
	Четыре вопроса стоят сеткой 2×2, а не в строку из четырёх колонок: в строке
	каждая панель получала четверть ширины ноутбука, название перехода не
	помещалось в кнопку, а высоту всем четырём задавала самая длинная — три
	карточки из четырёх наполовину пустые. `items-start` оставляет каждой высоту
	по её содержимому.
-->
<div class="grid items-start gap-4 md:grid-cols-2">
	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Что происходит</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			{#if summary.happening.stage === null}
				<p class="text-sm text-muted-foreground">Взаимодействие не стоит ни на одной стадии.</p>
			{:else}
				<p class="text-sm font-medium">{summary.happening.stage.name}</p>
				<div class="flex flex-wrap items-center gap-2">
					{#if summary.happening.isPaused}
						<StatusBadge tone="neutral" dot>На паузе</StatusBadge>
					{:else if summary.happening.dueAt}
						<SlaChip deadline={summary.happening.dueAt} />
					{/if}
				</div>
				{#if summary.happening.pause !== null}
					<p class="text-xs text-muted-foreground">
						{PAUSE_REASON_LABELS[summary.happening.pause.reason]}: {summary.happening.pause.note}
					</p>
					<p class="text-xs text-faint">
						с {formatDateTime(summary.happening.pause.startedAt)}
					</p>
				{/if}
				{#if summary.happening.nextAction}
					<p class="text-xs text-muted-foreground">
						Следующий шаг: {summary.happening.nextAction}
					</p>
				{/if}
			{/if}
		</Card.Content>
	</Card.Root>

	<!--
		Мешает только то, что действительно запрещает переход: открытые помехи с
		запретом и приговор движка по шагу вперёд. Незакрытый необязательный
		пункт чек-листа переходу не мешает, и в одном списке с ними он врал —
		кнопка «Перейти» при этом оставалась доступной.
	-->
	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Что мешает</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			{#if nothingBlocks}
				<p class="text-sm text-muted-foreground">
					{canStepForward ? 'Ничего не мешает: шаг вперёд доступен.' : 'Ничего не мешает.'}
				</p>
			{/if}

			{#each hardBlockers as blocker (blocker.id)}
				<p class="text-sm">
					<StatusBadge tone="danger" dot>{blockerReasonLabel(blocker.reasonCode)}</StatusBadge>
					<span class="ml-1">{blocker.description}</span>
				</p>
			{/each}

			{#if blockingReasons.length > 0}
				<ul class="list-inside list-disc text-sm">
					{#each blockingReasons as text (text)}
						<li>{text}</li>
					{/each}
				</ul>
			{/if}

			{#if notDoneYet.length > 0}
				<div class="flex flex-col gap-1 border-t border-border pt-2">
					<p class="text-xs font-medium text-muted-foreground">
						Ещё не сделано — переходу не мешает
					</p>
					<ul class="list-inside list-disc text-xs text-muted-foreground">
						{#each notDoneYet as text (text)}
							<li>{text}</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if hasChecklist}
				<a
					class="self-start rounded-sm text-xs text-primary underline-offset-4 focus-ring hover:underline"
					href={checklistHref}
				>
					Открыть чек-лист стадии
				</a>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Кто должен действовать</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			{#if summary.whoActs.waitingParty !== null}
				<p class="text-sm font-medium">{summary.whoActs.waitingParty.organizationName}</p>
				<p class="text-xs text-muted-foreground">Ход за участником: часы стадии остановлены.</p>
			{:else if summary.whoActs.responsibleUser !== null}
				<p class="text-sm font-medium">{summary.whoActs.responsibleUser.name}</p>
				<p class="text-xs text-muted-foreground">Ответственный за текущую стадию.</p>
			{:else}
				<p class="text-sm text-muted-foreground">Ответственный не назначен.</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Что могу сейчас</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			{#each summary.canDo.transitions as option (option.transition.id)}
				{@const label =
					option.transition.kind === 'forward'
						? `Перейти: ${option.toStage.name}`
						: option.transition.kind === 'return'
							? `Вернуть: ${option.toStage.name}`
							: `Пропустить до: ${option.toStage.name}`}
				<div class="flex flex-col gap-1">
					<!-- Любой переход открывает диалог: комментарий и вложения — то, чем
						объясняют, чем кончилась стадия, и на шаге вперёд они нужны так
						же, как на возврате. Первичный цвет — только тому, что
						действительно можно нажать. -->
					<Button
						type="button"
						size="sm"
						variant={option.transition.kind === 'forward' && option.allowed ? 'default' : 'outline'}
						class="h-auto min-h-7 w-full min-w-0 justify-start py-1 text-left whitespace-normal"
						disabled={!option.allowed}
						onclick={() =>
							openTransitionDialog({
								kind: option.transition.kind,
								toStageId: option.toStage.id,
								name: option.toStage.name,
								requiresReason: option.transition.requiresReason
							})}
					>
						{@render transitionFace(option.transition.kind, label)}
					</Button>
					{#if !option.allowed}
						<!-- Причины целиком, а не первая из них: недоступный переход
							объясняется рядом с кнопкой, и остальные условия человеку
							нужны так же, как первое. -->
						<p class="text-xs text-muted-foreground">{option.reasons.join('; ')}</p>
					{/if}
				</div>
			{/each}

			{#if can('pause')}
				<Button
					type="button"
					size="sm"
					variant="outline"
					class="w-full justify-start"
					onclick={() => (pauseOpen = true)}
				>
					<PauseIcon aria-hidden="true" />
					Поставить на паузу
				</Button>
			{/if}

			{#if can('resume')}
				<form method="POST" action="?/resume" use:enhance={actionEnhance()}>
					<input type="hidden" name="fromStageId" value={currentStageId} />
					<Button type="submit" size="sm" variant="outline" class="w-full justify-start">
						<PlayIcon aria-hidden="true" />
						Снять паузу
					</Button>
				</form>
			{/if}

			{@render closing?.()}
		</Card.Content>
	</Card.Root>
</div>

<Dialog.Root
	open={reasonDialog !== null}
	onOpenChange={(open) => {
		if (!open) closeTransitionDialog();
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{REASON_TITLES[dialogKind]}</Dialog.Title>
			<Dialog.Description>
				{reasonDialog === null ? '' : `Стадия: ${reasonDialog.name}.`} Объяснение попадёт в историю взаимодействия.
			</Dialog.Description>
		</Dialog.Header>

		<!-- novalidate: проверяет форма и говорит по-русски, а не браузер на своём
			языке (`docs/development.md`, «Формы»). -->
		<form
			method="POST"
			action={REASON_ACTIONS[dialogKind]}
			enctype="multipart/form-data"
			novalidate
			use:enhance={actionEnhance({
				validate: validateReason,
				onsuccess: () => (reasonDialog = null)
			})}
			class="flex flex-col gap-4"
		>
			<input type="hidden" name="fromStageId" value={currentStageId} />
			<input type="hidden" name="toStageId" value={reasonDialog?.toStageId ?? ''} />
			<input type="hidden" name="revision" value={revision} />

			<!-- На шаге вперёд объяснение — это комментарий «чем закончили стадию»,
				а не разбор неудачи. -->
			<FieldTextarea
				name="reason"
				label={reasonLabel}
				required={reasonRequired}
				rows={3}
				placeholder={dialogKind === 'forward'
					? 'Чем закончилась стадия'
					: 'Что именно пошло не так'}
				bind:value={reason}
				errors={reasonError === null ? undefined : [reasonError]}
			/>

			{#if canAttach}
				<div class="flex flex-col gap-1.5">
					<!-- Файл виден на той стадии, где его приложили, а не общим списком
						по взаимодействию: «чем подтверждена передача материалов» —
						вопрос к стадии. Здесь нативный выбор файлов, а не наш
						`FileInput`: тот показывает один файл, а вложений к переходу
						бывает несколько. -->
					<Label for="transitionFiles">Вложения</Label>
					<input
						id="transitionFiles"
						name="files"
						type="file"
						multiple
						class="text-sm file:mr-2 file:rounded-md file:border file:border-input file:bg-background file:px-2 file:py-1 file:text-sm"
					/>
					<p class="text-xs text-muted-foreground">
						До десяти файлов на переход; они останутся на покидаемой стадии.
					</p>
				</div>
			{/if}

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={closeTransitionDialog}>Отмена</Button>
				<Button type="submit">Подтвердить</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={pauseOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Поставить стадию на паузу</Dialog.Title>
			<Dialog.Description>
				Часы норматива остановятся: ждать ответа и не успеть — разные вещи.
			</Dialog.Description>
		</Dialog.Header>

		<form
			method="POST"
			action="?/pause"
			use:enhance={actionEnhance({ onsuccess: () => (pauseOpen = false) })}
			class="flex flex-col gap-4"
		>
			<input type="hidden" name="fromStageId" value={currentStageId} />

			<div class="flex flex-col gap-1.5 text-sm">
				<Label for="pauseReason">Причина</Label>
				<Select.Root
					type="single"
					name="reason"
					bind:value={() => pauseReason, (next) => (pauseReason = next as PauseReason)}
				>
					<Select.Trigger id="pauseReason" class="w-full">
						{PAUSE_REASON_LABELS[pauseReason]}
					</Select.Trigger>
					<Select.Content>
						{#each PAUSE_REASONS as reason (reason)}
							<Select.Item value={reason} label={PAUSE_REASON_LABELS[reason]} />
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="pauseNote">Чего ждём</Label>
				<Textarea
					id="pauseNote"
					name="note"
					rows={2}
					required
					placeholder="Например: подписи ректора"
				/>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="pauseNextAction">Следующий шаг</Label>
				<Textarea
					id="pauseNextAction"
					name="nextAction"
					rows={2}
					placeholder="Что сделаем, когда дождёмся"
				/>
			</div>

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (pauseOpen = false)}>Отмена</Button>
				<Button type="submit">Поставить на паузу</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
