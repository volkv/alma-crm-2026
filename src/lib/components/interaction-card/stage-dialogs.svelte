<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FileDropzone from '$lib/components/form/file-dropzone.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import { actionEnhance } from '$lib/components/interactions/action-enhance';
	import {
		blockerReasonLabel,
		BLOCKER_REASONS,
		BLOCKER_REASON_LABELS,
		PAUSE_REASONS,
		PAUSE_REASON_LABELS,
		type InteractionClosingView,
		type InteractionDocumentView,
		type PauseReason,
		type StageEntryView,
		type StageTransitionKind
	} from '$lib/contracts/interactions';
	import { getCardCommands } from './commands.svelte';
	import StaleNotice from '$lib/components/interactions/stale-notice.svelte';

	/**
	 * Диалоги команд по стадии и по записи целиком: переход, пауза, результат,
	 * подтверждение, помеха, завершение и отмена. Открывает их общее состояние команд
	 * карточки — кнопка у условия, пункт меню «Ещё» и главная кнопка ведут в
	 * один и тот же диалог.
	 *
	 * Закрытие с набранным текстом спрашивает подтверждение (`FormDialog`):
	 * `Esc` и клик вне слоя стирали набранное молча.
	 */
	let {
		entry,
		revision,
		documents,
		closing,
		canAttach
	}: {
		/** Текущая запись стадии; `null` — запись закрыта или не стоит на стадии. */
		entry: StageEntryView | null;
		/**
		 * Редакция процесса, по которой отрисована карточка. Едет с каждой
		 * командой перехода и закрытия: если процесс изменили, пока карточка была
		 * открыта, движок откажет словами, а не сдвинет запись по правилам,
		 * которых нет.
		 */
		revision: number;
		documents: readonly InteractionDocumentView[];
		closing: InteractionClosingView;
		/** Есть ли право прикладывать файлы: без него поля вложений нет. */
		canAttach: boolean;
	} = $props();

	const commands = getCardCommands();
	const stageId = $derived(entry?.stageId ?? null);

	/** Открытость диалога по виду команды: закрытие — сброс общего состояния. */
	const opened = (kind: Parameters<typeof commands.is>[0]) => ({
		get: () => commands.is(kind),
		set: (next: boolean) => {
			if (!next) commands.close();
		}
	});

	const transitionOpen = opened('transition');
	const pauseOpen = opened('pause');
	const resultOpen = opened('result');
	const confirmOpen = opened('confirm');
	const raiseOpen = opened('raise-blocker');
	const completeOpen = opened('complete');
	const cancelOpen = opened('cancel');

	const transition = $derived(commands.current?.kind === 'transition' ? commands.current : null);

	/** Куда уходит форма перехода: у каждого вида перехода своё действие. */
	const TRANSITION_ACTIONS: Record<StageTransitionKind, string> = {
		forward: '?/advance',
		return: '?/return',
		skip: '?/skip'
	};

	const TRANSITION_TITLES: Record<StageTransitionKind, string> = {
		forward: 'Перейти на следующую стадию',
		return: 'Вернуть на стадию',
		skip: 'Пропустить стадии'
	};

	const kind = $derived(transition?.transition ?? 'forward');
	/**
	 * Возврат и пропуск требуют объяснения всегда — это отступление от плана;
	 * шаг вперёд — только там, где так настроен процесс.
	 */
	const reasonRequired = $derived(
		transition === null ? false : transition.requiresReason || kind !== 'forward'
	);

	// Поля каждого диалога заводятся чистыми при открытии: прошлый ответ уже
	// уехал на сервер или был отменён.
	let reason = $state('');
	let reasonError = $state<string | null>(null);
	let attached = $state<readonly string[]>([]);
	let pauseReason = $state<PauseReason>(PAUSE_REASONS[0]);
	let pauseNote = $state('');
	let pauseNextAction = $state('');
	let resultText = $state('');
	let confirmKind = $state<ConfirmKind>('mark');
	let confirmDocumentId = $state('');
	let closingText = $state('');
	/** Причина помехи выбирается из справочника: по ней потом считают, на чём встаём. */
	let reasonCode = $state('');
	let blockerDescription = $state('');
	/** По умолчанию помеха запрещает переход — это осознанный выбор снять галочку. */
	let blocksTransition = $state(true);

	/**
	 * Запись стадии, открытая, когда открыли диалог. Замораживается вместе с
	 * полями: карточка может перечитаться, пока человек пишет, и живое `entry`
	 * к моменту отправки указывало бы уже на новую стадию — набранный для
	 * прежней результат лёг бы в неё молча. Сервер сверяет именно эту запись.
	 */
	let entryId = $state(untrack(() => entry?.id ?? null));
	/** Отказ «стадия уже сменилась»: введённое остаётся, карточку перечитывают кнопкой. */
	let conflict = $state<string | null>(null);

	$effect(() => {
		const current = commands.current;

		untrack(() => {
			if (current === null) return;

			entryId = entry?.id ?? null;
			conflict = null;
			reasonCode = '';
			blockerDescription = '';
			blocksTransition = true;
			reason = '';
			reasonError = null;
			attached = [];
			pauseReason = PAUSE_REASONS[0];
			pauseNote = '';
			pauseNextAction = '';
			resultText = entry?.resultText ?? '';
			confirmKind = 'mark';
			confirmDocumentId = '';
			closingText = '';
		});
	});

	/**
	 * Проверка обязательного объяснения — своя, со звёздочкой у поля и
	 * фразой по-русски под ним: нативный пузырь браузера говорит на своём
	 * языке и исчезает сам.
	 */
	function validateReason(): boolean {
		if (reasonRequired && reason.trim() === '') {
			reasonError =
				kind === 'forward'
					? 'Процесс требует сказать, чем закончилась стадия'
					: 'Без причины переход не делается: напишите, что именно пошло не так';

			return false;
		}

		reasonError = null;

		return true;
	}

	/** Чем закрывают стадию; список отправляет выбранное скрытым полем. */
	const CONFIRM_KINDS = [
		{ value: 'mark', label: 'Отметка ответственного' },
		{ value: 'file', label: 'Документ взаимодействия' },
		{ value: 'lms_record', label: 'Ссылка на запись в системе обучения' }
	] as const;

	type ConfirmKind = (typeof CONFIRM_KINDS)[number]['value'];

	const confirmKindLabel = $derived(
		CONFIRM_KINDS.find((item) => item.value === confirmKind)?.label ?? ''
	);
	const confirmDocumentTitle = $derived(
		documents.find((document) => document.id === confirmDocumentId)?.title ?? 'Выберите документ'
	);
	const confirmBlocked = $derived(
		confirmKind === 'file' && (documents.length === 0 || confirmDocumentId === '')
	);

	/** Отправка команды по записи стадии: успех закрывает диалог, 409 остаётся в нём. */
	const entryCommand = actionEnhance({
		onsuccess: () => commands.close(),
		onconflict: (message) => (conflict = message)
	});

	/**
	 * Карточка перечитана: форма переходит на открытую сейчас запись стадии.
	 * Введённое остаётся — отправить его на новую стадию человек решает сам,
	 * видя её название в заголовке диалога.
	 */
	function rebase() {
		entryId = entry?.id ?? null;
		conflict = null;
	}
</script>

{#snippet staleNotice()}
	{#if conflict !== null}
		<StaleNotice message={conflict} onrefreshed={rebase} />
	{/if}
{/snippet}

<FormDialog
	bind:open={transitionOpen.get, transitionOpen.set}
	title={TRANSITION_TITLES[kind]}
	description="{transition === null
		? ''
		: `Стадия: ${transition.name}.`} Объяснение попадёт в историю взаимодействия."
	dirty={reason.trim() !== '' || attached.length > 0}
	discardDescription="Набранное объяснение и выбранные вложения пропадут: переход не состоится, а текст нигде не сохранится."
>
	<!-- novalidate: проверяет форма и говорит по-русски, а не браузер на своём
		языке (`docs/development.md`, «Формы»). -->
	<form
		id="card-transition-form"
		method="POST"
		action={TRANSITION_ACTIONS[kind]}
		enctype="multipart/form-data"
		novalidate
		use:enhance={actionEnhance({ validate: validateReason, onsuccess: () => commands.close() })}
		class="flex flex-col gap-4"
	>
		<input type="hidden" name="fromStageId" value={stageId} />
		<input type="hidden" name="toStageId" value={transition?.toStageId ?? ''} />
		<input type="hidden" name="revision" value={revision} />

		<!-- На шаге вперёд объяснение — это комментарий «чем закончили стадию»,
			а не разбор неудачи. Необязательность сказана словами. -->
		<FieldTextarea
			name="reason"
			label={kind === 'forward' ? 'Комментарий' : 'Причина'}
			required={reasonRequired}
			description={reasonRequired
				? undefined
				: 'Необязательно, но без него в истории останется переход без причины.'}
			rows={3}
			placeholder={kind === 'forward' ? 'Чем закончилась стадия' : 'Что именно пошло не так'}
			bind:value={reason}
			errors={reasonError === null ? undefined : [reasonError]}
		/>

		{#if canAttach}
			<!-- Файл виден на той стадии, где его приложили: «чем подтверждена
				передача материалов» — вопрос к стадии. -->
			<FileDropzone
				id="card-transition-files"
				name="files"
				label="Вложения"
				multiple
				description="До десяти файлов на переход; они останутся на покидаемой стадии."
				onchoose={(names) => (attached = names)}
			/>
		{/if}
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-transition-form">Подтвердить</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={pauseOpen.get, pauseOpen.set}
	title="Поставить стадию на паузу"
	description="Часы норматива остановятся: ждать ответа и не успеть — разные вещи."
	dirty={pauseNote.trim() !== '' || pauseNextAction.trim() !== ''}
	discardDescription="Набранное о том, чего ждём, пропадёт: стадия останется без паузы."
>
	<form
		id="card-pause-form"
		method="POST"
		action="?/pause"
		use:enhance={entryCommand}
		class="flex flex-col gap-4"
	>
		<input type="hidden" name="stageEntryId" value={entryId} />
		{@render staleNotice()}

		<div class="flex flex-col gap-1.5 text-sm">
			<Label for="card-pause-reason">Причина</Label>
			<Select.Root
				type="single"
				name="reason"
				bind:value={() => pauseReason, (next) => (pauseReason = next as PauseReason)}
			>
				<Select.Trigger id="card-pause-reason" class="w-full">
					{PAUSE_REASON_LABELS[pauseReason]}
				</Select.Trigger>
				<Select.Content>
					{#each PAUSE_REASONS as value (value)}
						<Select.Item {value} label={PAUSE_REASON_LABELS[value]} />
					{/each}
				</Select.Content>
			</Select.Root>
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="card-pause-note">Чего ждём</Label>
			<Textarea
				id="card-pause-note"
				name="note"
				rows={2}
				required
				placeholder="Например: подписи ректора"
				bind:value={pauseNote}
			/>
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="card-pause-next">Следующий шаг</Label>
			<Textarea
				id="card-pause-next"
				name="nextAction"
				rows={2}
				placeholder="Что сделаем, когда дождёмся"
				bind:value={pauseNextAction}
			/>
		</div>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-pause-form">Поставить на паузу</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={resultOpen.get, resultOpen.set}
	title="Результат стадии"
	description={entry === null
		? undefined
		: `Стадия: ${entry.snapshot.name}. Что получилось на ней.`}
	dirty={resultText !== (entry?.resultText ?? '')}
>
	<form
		id="card-result-form"
		method="POST"
		action="?/result"
		use:enhance={entryCommand}
		class="flex flex-col gap-2"
	>
		<input type="hidden" name="stageEntryId" value={entryId} />
		{@render staleNotice()}
		<Label for="card-result-text">Результат стадии</Label>
		<Textarea
			id="card-result-text"
			name="resultText"
			rows={4}
			placeholder="Что получилось на этой стадии"
			bind:value={resultText}
		/>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-result-form">Сохранить результат</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={confirmOpen.get, confirmOpen.set}
	title="Подтвердить стадию"
	description="Подтверждение остаётся в истории стадии: чем именно подтверждено и когда."
>
	<form
		id="card-confirm-form"
		method="POST"
		action="?/confirm"
		use:enhance={entryCommand}
		class="flex flex-col gap-3"
	>
		<input type="hidden" name="stageEntryId" value={entryId} />
		{@render staleNotice()}

		<div class="flex flex-col gap-1.5">
			<Label for="card-confirm-kind">Чем подтверждаем</Label>
			<Select.Root
				type="single"
				name="kind"
				bind:value={() => confirmKind, (next) => (confirmKind = next as ConfirmKind)}
			>
				<Select.Trigger id="card-confirm-kind" class="w-full">{confirmKindLabel}</Select.Trigger>
				<Select.Content>
					{#each CONFIRM_KINDS as item (item.value)}
						<Select.Item value={item.value} label={item.label} />
					{/each}
				</Select.Content>
			</Select.Root>
		</div>

		{#if confirmKind === 'file'}
			<Select.Root type="single" name="documentId" bind:value={confirmDocumentId}>
				<Select.Trigger aria-label="Документ подтверждения" class="w-full">
					<span class="truncate">{confirmDocumentTitle}</span>
				</Select.Trigger>
				<Select.Content>
					{#each documents as document (document.id)}
						<Select.Item value={document.id} label={document.title} />
					{/each}
				</Select.Content>
			</Select.Root>
			{#if documents.length === 0}
				<p class="text-xs text-muted-foreground">
					Документов пока нет — загрузите файл в панели «Документы».
				</p>
			{:else if confirmDocumentId === ''}
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
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-confirm-form" disabled={confirmBlocked}>
				Подтвердить стадию
			</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={raiseOpen.get, raiseOpen.set}
	title="Сообщить о помехе"
	description="Помеха с запретом не пустит запись на следующую стадию, пока её не снимут с объяснением."
	dirty={blockerDescription.trim() !== ''}
>
	<form
		id="card-raise-blocker-form"
		method="POST"
		action="?/raiseBlocker"
		use:enhance={entryCommand}
		class="flex flex-col gap-3"
	>
		<input type="hidden" name="stageEntryId" value={entryId} />
		{@render staleNotice()}
		<div class="flex flex-col gap-1.5">
			<Label for="card-blocker-reason">Причина</Label>
			<Select.Root type="single" name="reasonCode" bind:value={reasonCode}>
				<Select.Trigger id="card-blocker-reason" class="w-full">
					{reasonCode === '' ? 'Выберите причину' : blockerReasonLabel(reasonCode)}
				</Select.Trigger>
				<Select.Content>
					{#each BLOCKER_REASONS as blockerReason (blockerReason)}
						<Select.Item value={blockerReason} label={BLOCKER_REASON_LABELS[blockerReason]} />
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="card-blocker-description">Что мешает</Label>
			<Textarea
				id="card-blocker-description"
				name="description"
				rows={3}
				required
				bind:value={blockerDescription}
			/>
		</div>
		<Label class="flex items-center gap-2 font-normal">
			<Checkbox
				name="blocksTransition"
				value="true"
				checked={blocksTransition}
				onCheckedChange={(next) => (blocksTransition = next === true)}
			/>
			Запрещает переход на следующую стадию
		</Label>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-raise-blocker-form" disabled={reasonCode === ''}>
				Сообщить
			</Button>
		</div>
	{/snippet}
</FormDialog>

<!-- Завершение и отмена спрашивают текст: оба оставляют след в истории, и
	«завершено» без слова об итоге или «отменено» без причины через месяц не
	объяснят ничего. -->
<FormDialog
	bind:open={completeOpen.get, completeOpen.set}
	title="Завершить взаимодействие"
	description={closing.complete.requiresForce
		? 'Взаимодействие не дошло до последней стадии маршрута: закрытие будет досрочным, и итог обязателен.'
		: 'Текущая стадия закроется, новых команд по стадиям не будет. Итог останется в истории.'}
	dirty={closingText.trim() !== ''}
>
	<form
		id="card-complete-form"
		method="POST"
		action="?/complete"
		use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
		class="flex flex-col gap-1.5"
	>
		<input type="hidden" name="revision" value={revision} />
		{#if closing.complete.requiresForce}
			<input type="hidden" name="force" value="true" />
		{/if}
		<Label for="card-complete-summary">
			Итог{closing.complete.requiresForce ? '' : ' (необязательно)'}
		</Label>
		<Textarea
			id="card-complete-summary"
			name="summary"
			rows={3}
			required={closing.complete.requiresForce}
			placeholder="Чем кончилось взаимодействие"
			bind:value={closingText}
		/>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-complete-form">Завершить</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={cancelOpen.get, cancelOpen.set}
	title="Отменить взаимодействие"
	description="Работа по нему прекращается на текущей стадии. Причина попадёт в историю."
	dirty={closingText.trim() !== ''}
>
	<form
		id="card-cancel-form"
		method="POST"
		action="?/cancel"
		use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
		class="flex flex-col gap-1.5"
	>
		<input type="hidden" name="revision" value={revision} />
		<Label for="card-cancel-reason">Причина</Label>
		<Textarea
			id="card-cancel-reason"
			name="reason"
			rows={3}
			required
			placeholder="Почему работа прекращается"
			bind:value={closingText}
		/>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Не отменять</Button>
			<Button type="submit" form="card-cancel-form" variant="destructive">
				Отменить взаимодействие
			</Button>
		</div>
	{/snippet}
</FormDialog>
