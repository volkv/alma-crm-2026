<script lang="ts">
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import RouteIcon from '@lucide/svelte/icons/route';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type {
		BoardTransitionOption,
		InteractionBoardCard,
		InteractionBoardColumn,
		InteractionBoardView
	} from '$lib/contracts/interactions';
	import { cn } from '$lib/utils';
	import { actionEnhance } from './action-enhance';
	import BoardCard, { transitionLabel } from './board-card.svelte';

	/**
	 * Доска взаимодействий: колонка на стадию действующего процесса, карточка на
	 * дело.
	 *
	 * Список отвечает, что с отдельной записью, доска — где стоит работа целиком:
	 * на какой стадии скопились дела и сколько из них просрочено. Данные приходят
	 * готовыми (`$lib/server/interactions/board`), запросов компонент не делает и
	 * доступность перехода не выводит — приговор считает сервер.
	 *
	 * Двигают карточку перетаскиванием или меню на ней; оба пути отправляют одно
	 * и то же действие страницы, а движок решает, состоится ли переход. Отказ
	 * приходит словами в тост, и карточка остаётся там, где стояла.
	 *
	 * Выбора версии процесса здесь нет: в пространстве действует ровно один
	 * процесс, а какое пространство показать, решает фильтр списка. Номер
	 * действующей редакции едет с командой скрытым полем — не для человека, а
	 * чтобы движок отказал, если процесс изменили, пока доска была открыта.
	 */
	let {
		board,
		/** Право `stages.transition`: без него доска только показывает. */
		canTransition,
		/** Список отобран фильтром — пустота значит разное в двух случаях. */
		isFiltered,
		workspaceKey,
		/**
		 * Процесс пространства: не назначен (`null`) или назначен, но ещё не
		 * описан, — у доски без колонок две разные причины.
		 */
		process,
		/** Право настраивать процесс: ему пустая доска даёт ссылку на исправление. */
		canConfigure
	}: {
		board: InteractionBoardView;
		canTransition: boolean;
		isFiltered: boolean;
		workspaceKey: string;
		process: { key: string; name: string; described: boolean } | null;
		canConfigure: boolean;
	} = $props();

	/** Какую карточку сейчас тащат и над какой колонкой держат. */
	let dragged = $state<InteractionBoardCard | null>(null);
	let hovered = $state<string | null>(null);

	/** Собранная команда перехода: ей осталось получить причину или уехать. */
	let pending = $state<{ card: InteractionBoardCard; option: BoardTransitionOption } | null>(null);
	let reasonOpen = $state(false);
	let moveForm = $state<HTMLFormElement | null>(null);

	/** Полоса колонок — её прокручивают полосой стадий над ней. */
	let columnsEl = $state<HTMLElement | null>(null);

	/**
	 * Переход к колонке из полосы стадий: колонок до четырнадцати, и дальние
	 * без неё достаются только долгой прокруткой вбок. Фокус едет вместе с
	 * прокруткой — с клавиатуры следующий `Tab` попадает в эту колонку, а не
	 * обратно в начало доски.
	 */
	function goToColumn(stageId: string) {
		const section = columnsEl?.querySelector<HTMLElement>(
			`[data-stage-id="${CSS.escape(stageId)}"]`
		);

		if (section === null || section === undefined) {
			throw new Error(`Board column ${stageId} is not rendered`);
		}

		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

		section.scrollIntoView({
			behavior: reduced ? 'auto' : 'smooth',
			block: 'nearest',
			inline: 'start'
		});
		section.focus({ preventScroll: true });
	}

	/**
	 * Полоса стадий крутится вбок без своей полосы прокрутки — третья полоса на
	 * экране рядом с доской и страницей только путала. Что за краем есть ещё
	 * стадии, говорит затухание этого края; гаснет оно, когда край достигнут.
	 */
	let stagesEl = $state<HTMLElement | null>(null);
	let stagesMore = $state({ start: false, end: false });

	function measureStages() {
		if (stagesEl === null) {
			return;
		}

		const { scrollLeft, scrollWidth, clientWidth } = stagesEl;

		stagesMore = {
			start: scrollLeft > 1,
			end: scrollLeft + clientWidth < scrollWidth - 1
		};
	}

	$effect(() => {
		if (stagesEl === null) {
			return;
		}

		const observer = new ResizeObserver(measureStages);

		observer.observe(stagesEl);

		return () => observer.disconnect();
	});

	/** Затухание края полосы стадий: маска, а не накладка, — фон под ней любой. */
	const stagesMask = $derived(
		`linear-gradient(to right, transparent 0, #000 ${stagesMore.start ? '2rem' : '0px'}, #000 calc(100% - ${stagesMore.end ? '2rem' : '0px'}), transparent 100%)`
	);

	/** Стадии, на которые эту карточку разрешает переносить процесс. */
	const targets = $derived(new Set(dragged?.transitions.map((option) => option.toStageId) ?? []));

	const stageNames = $derived(
		new Map(board.columns.map((column) => [column.stageId, column.name]))
	);

	/** Собранный переход — шаг вперёд: от этого зависят слова в диалоге. */
	const forward = $derived(pending?.option.kind === 'forward');

	let reason = $state('');
	let reasonError = $state<string | null>(null);

	/**
	 * Проверка объяснения — своя, как в формах создания: со звёздочкой у поля,
	 * фразой по-русски под ним и сохранённым вводом. Диалог открывается только
	 * там, где процесс объяснения требует, поэтому пустым его оставить нельзя.
	 */
	function validateReason(): boolean {
		if (reason.trim() === '') {
			reasonError = forward
				? 'Процесс требует сказать, чем закончилась стадия'
				: 'Без причины переход не делается: напишите, что именно пошло не так';

			return false;
		}

		reasonError = null;

		return true;
	}

	function closeReason() {
		reasonOpen = false;
		reasonError = null;
	}

	async function move(card: InteractionBoardCard, option: BoardTransitionOption) {
		pending = { card, option };

		// Переход, которому процесс назначил объяснение, спрашивает его до команды,
		// а не показывает отказ после неё. Это и возврат с пропуском, и шаг вперёд
		// там, где процесс требует сказать, чем закончили стадию.
		if (option.requiresReason) {
			reason = '';
			reasonError = null;
			reasonOpen = true;

			return;
		}

		await tick();
		moveForm?.requestSubmit();
	}

	function over(event: DragEvent, column: InteractionBoardColumn) {
		if (dragged === null || dragged.stageId === column.stageId) {
			return;
		}

		// Без `preventDefault` браузер считает зону чужой, и события `drop` не
		// будет вовсе. Бросок принимают все колонки, даже те, куда процесс
		// перехода не описывает: отказ словами объясняет процесс, а мёртвая зона
		// не объясняет ничего.
		event.preventDefault();
		hovered = column.stageId;
	}

	function leave(event: DragEvent, column: InteractionBoardColumn) {
		const host = event.currentTarget;
		const next = event.relatedTarget;

		// Переход между карточками внутри колонки — это тоже `dragleave`;
		// подсветка не должна мигать на каждой из них.
		if (host instanceof Node && next instanceof Node && host.contains(next)) {
			return;
		}

		if (hovered === column.stageId) {
			hovered = null;
		}
	}

	function drop(event: DragEvent, column: InteractionBoardColumn) {
		event.preventDefault();

		const card = dragged;
		dragged = null;
		hovered = null;

		if (card === null || card.stageId === column.stageId) {
			return;
		}

		const option = card.transitions.find((candidate) => candidate.toStageId === column.stageId);

		if (option === undefined) {
			toast.error('Такого перехода в процессе нет', {
				description: `С «${stageNames.get(card.stageId) ?? 'текущей стадии'}» на «${column.name}» процесс переходов не описывает.`
			});

			return;
		}

		void move(card, option);
	}
</script>

{#if board.revision === null}
	<div class="rounded-lg border border-border bg-surface">
		{#if process === null}
			<EmptyState
				icon={RouteIcon}
				title="Процесс не назначен"
				description="Доска раскладывает взаимодействия по стадиям действующего процесса. Пока пространству не назначен процесс, раскладывать не по чему — и создать здесь запись тоже нельзя: стадии, на которую её поставить, не существует.{canConfigure
					? ''
					: ' Назначает процесс администратор.'}"
			>
				{#snippet action()}
					{#if canConfigure}
						<Button
							variant="outline"
							href={resolve('/(app)/settings/workspaces/[key]', { key: workspaceKey })}
						>
							Назначить процесс
						</Button>
					{/if}
				{/snippet}
			</EmptyState>
		{:else}
			<EmptyState
				icon={RouteIcon}
				title="Процесс не описан"
				description="Пространству назначен процесс «{process.name}», но стадий в нём ещё нет: раскладывать не по чему, и создать дело нельзя — стадии, на которую его поставить, не существует.{canConfigure
					? ''
					: ' Описывает процесс администратор.'}"
			>
				{#snippet action()}
					{#if canConfigure}
						<Button
							variant="outline"
							href={resolve('/(app)/settings/workflows/[key]', { key: process.key })}
						>
							Описать процесс
						</Button>
					{/if}
				{/snippet}
			</EmptyState>
		{/if}
	</div>
{:else if board.total === 0}
	<div class="rounded-lg border border-border bg-surface">
		<EmptyState
			title={isFiltered ? 'Под фильтр ничего не попало' : 'На доске пока пусто'}
			description={isFiltered
				? 'Измените фильтры или вернитесь к списку — доска показывает только те записи, что стоят на стадии процесса.'
				: 'Доска показывает взаимодействия, которые идут по этому процессу прямо сейчас. Завершённые на ней не стоят: у них нет текущей стадии.'}
		/>
	</div>
{:else}
	<!-- Пояснение, полоса стадий и сама доска — отдельные куски, и разделяет их
		этот контейнер: страница ставит доску в обычный блок, и без него они
		слипались в сплошную стену над колонками. С `sm` он забирает у страницы
		остаток высоты экрана и отдаёт его колонкам. -->
	<div class="flex flex-col gap-3 sm:min-h-0 sm:flex-1 sm:gap-2">
		<!-- С `sm` полоса стадий и пояснение стоят одной строкой: над колонками
			остаётся один ряд, а не два. Раскрытое пояснение ложится поверх доски, а
			не сдвигает её — иначе от одного щелчка доска уезжала вниз за край
			экрана. На телефоне пояснение стоит над полосой, как раньше. -->
		<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
			<!-- Пояснение — одна строка: как переводить карточку, узнают один раз, и
				абзац над колонками каждый день отнимал у доски место. -->
			{#if canTransition}
				<details class="group relative text-sm text-muted-foreground sm:order-last sm:shrink-0">
					<summary
						class="flex w-fit cursor-pointer list-none items-center gap-1 rounded focus-ring hover:text-foreground sm:text-xs [&::-webkit-details-marker]:hidden"
					>
						Как перевести карточку
						<ChevronDownIcon
							class="size-4 shrink-0 transition-transform group-open:rotate-180"
							aria-hidden="true"
						/>
					</summary>
					<p
						class="mt-1 max-w-prose text-xs sm:absolute sm:top-full sm:right-0 sm:z-30 sm:w-80 sm:rounded-md sm:border sm:border-border sm:bg-surface sm:p-3 sm:text-foreground sm:shadow-md"
					>
						Колонки — стадии процесса «{board.workspaceName}». Перетащите карточку в другую колонку
						или выберите стадию в меню «⋮» на самой карточке — меню работает и с клавиатуры. Переход
						выполняет движок: если стадия к нему не готова, карточка останется на месте и скажет
						почему.
					</p>
				</details>
			{:else}
				<p
					class="text-sm text-muted-foreground sm:order-last sm:max-w-64 sm:shrink-0 sm:truncate sm:text-xs"
					title="Колонки — стадии процесса «{board.workspaceName}»"
				>
					Колонки — стадии процесса «{board.workspaceName}».
				</p>
			{/if}

			<!-- Полоса стадий: весь процесс одной строкой со счётчиками, нажатие —
				переход к колонке. Кнопки, а не ссылки: адрес от перехода не меняется. -->
			<nav
				bind:this={stagesEl}
				aria-label="Стадии доски"
				class="-mx-1 flex min-w-0 [scrollbar-width:none] gap-1.5 overflow-x-auto px-1 py-0.5 sm:flex-1 [&::-webkit-scrollbar]:hidden"
				style:mask-image={stagesMask}
				onscroll={measureStages}
			>
				{#each board.columns as column (column.stageId)}
					<button
						type="button"
						class="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-xs focus-ring transition-colors hover:bg-surface-muted max-sm:min-h-11"
						aria-label="{column.name}: {column.count}{column.overdue > 0
							? `, просрочено ${column.overdue}`
							: ''}"
						onclick={() => goToColumn(column.stageId)}
					>
						<span class="max-w-40 truncate">{column.name}</span>
						<span
							class={cn(
								'tabular-nums',
								column.count === 0 ? 'text-faint' : 'font-medium text-muted-foreground'
							)}>{column.count}</span
						>
						{#if column.overdue > 0}
							<StatusBadge tone="danger" dot>{column.overdue}</StatusBadge>
						{/if}
					</button>
				{/each}
			</nav>
		</div>

		<!-- Колонок четырнадцать, и на экран они не поместятся никогда: вбок
			уезжает сама доска, а не документ вокруг неё. С `sm` доска занимает
			ровно остаток экрана под отборами (`flex-1 min-h-0` по всей цепочке от
			оболочки): полоса прокрутки вбок стоит у нижнего края экрана, а не под
			последней карточкой самой длинной колонки, и заголовки колонок остаются
			над карточками при прокрутке вниз. Полоса окрашена заметнее обычной —
			это главный способ добраться до дальних стадий мышью. На совсем низком
			экране доска не ужимается ниже 18rem — тогда докручивается страница. -->
		<div
			bind:this={columnsEl}
			class="flex [scrollbar-color:var(--color-border-strong)_transparent] gap-3 overflow-auto pb-2 sm:min-h-72 sm:flex-1"
			data-slot="interactions-board"
		>
			{#each board.columns as column (column.stageId)}
				<section
					data-stage-id={column.stageId}
					tabindex="-1"
					class={cn(
						'flex w-72 shrink-0 flex-col gap-2 rounded-lg border p-2 focus-ring transition-colors',
						hovered === column.stageId && targets.has(column.stageId)
							? 'border-link bg-selection'
							: hovered === column.stageId
								? 'border-border-strong bg-surface-muted'
								: dragged !== null && targets.has(column.stageId)
									? 'border-selection-border bg-surface-muted'
									: 'border-border bg-surface-muted'
					)}
					aria-label="Стадия: {column.name}"
					ondragover={(event) => over(event, column)}
					ondragleave={(event) => leave(event, column)}
					ondrop={(event) => drop(event, column)}
				>
					<!-- `leading-5` равен высоте плашки со счётчиком: первая строка
					названия и цифры справа тогда стоят на одной линии, а не расходятся
					на пару пикселей, когда название переносится на две строки.

					Высота у всех заголовков одна — две строки: короткое и длинное
					название иначе сдвигали первые карточки соседних колонок на разную
					высоту. Заголовок липнет к верху доски; фон он наследует от колонки,
					чтобы подсветка броска не обрывалась под ним. -->
					<header
						class="sticky top-0 z-10 -mx-2 -mt-2 flex items-start justify-between gap-2 rounded-t-lg bg-inherit px-2 pt-2 pb-1"
					>
						<h2
							class="line-clamp-2 min-h-10 min-w-0 text-sm leading-5 font-semibold"
							title={column.name}
						>
							{column.name}
						</h2>
						<span class="flex shrink-0 items-center gap-1">
							<StatusBadge tone="neutral" title="Взаимодействий на стадии">
								{column.count}
							</StatusBadge>
							{#if column.overdue > 0}
								<StatusBadge tone="danger" dot title="Из них просрочено">
									{column.overdue}
								</StatusBadge>
							{/if}
						</span>
					</header>

					{#if column.cards.length === 0}
						<p
							class="rounded-md border border-dashed border-border px-2 py-8 text-center text-xs text-faint"
						>
							Здесь пусто
						</p>
					{:else}
						<!-- Высота колонки — по карточкам в ней: вертикально крутится
						вся доска (на телефоне — страница), одна полоса на все колонки.
						Своя полоса внутри колонки прятала карточки за краем в
						четырнадцати местах сразу. -->
						<ul class="flex flex-col gap-2">
							{#each column.cards as card (card.id)}
								<BoardCard
									{card}
									workspace={board.workspaceKey ?? ''}
									{canTransition}
									dragging={dragged?.id === card.id}
									onmove={(option) => void move(card, option)}
									ondragstart={() => (dragged = card)}
									ondragend={() => {
										dragged = null;
										hovered = null;
									}}
								/>
							{/each}
						</ul>
					{/if}

					{#if column.count > column.cards.length}
						<p class="text-center text-xs text-muted-foreground">
							Показаны {column.cards.length} из {column.count}: сузьте фильтр или откройте список.
						</p>
					{/if}
				</section>
			{/each}
		</div>
	</div>
{/if}

<!--
	Одна форма на оба способа перевода. Поля в ней скрыты, а причину пишут в
	диалоге: поле с атрибутом `form` принадлежит этой же форме, где бы оно ни
	стояло в разметке, — второй формы с теми же полями быть не должно.
-->
<form
	id="board-move"
	method="POST"
	action="?/transition"
	class="hidden"
	bind:this={moveForm}
	novalidate
	use:enhance={actionEnhance({
		validate: () => !reasonOpen || validateReason(),
		onsuccess: () => {
			reasonOpen = false;
			reasonError = null;
			pending = null;
		}
	})}
>
	<input type="hidden" name="interactionId" value={pending?.card.id ?? ''} />
	<input type="hidden" name="fromStageId" value={pending?.card.stageId ?? ''} />
	<input type="hidden" name="toStageId" value={pending?.option.toStageId ?? ''} />
	<input type="hidden" name="kind" value={pending?.option.kind ?? ''} />
	<input type="hidden" name="revision" value={board.revision ?? ''} />
</form>

<!--
	Закрытие с набранной причиной спрашивает подтверждение: `Esc` и клик вне
	слоя — это «уйти», а не «отменить ввод», и текст пропадал молча.
-->
<FormDialog
	bind:open={() => reasonOpen, (open) => (open ? (reasonOpen = true) : closeReason())}
	title={pending === null ? 'Перевести' : transitionLabel(pending.option)}
	description="{pending?.card.title ?? ''} — объяснение попадёт в историю взаимодействия."
	dirty={reason.trim() !== ''}
	discardTitle="Закрыть без сохранения?"
	discardDescription="Набранная причина пропадёт: перевод не состоится, а текст нигде не сохранится."
>
	<!-- На шаге вперёд объяснение — это комментарий «чем закончили стадию»,
		а не разбор неудачи: спрашивать «что пошло не так» там, где всё
		прошло хорошо, значит сбивать с толку. -->
	<FieldTextarea
		name="reason"
		label={forward ? 'Комментарий' : 'Причина'}
		form="board-move"
		required
		rows={3}
		placeholder={forward ? 'Чем закончилась стадия' : 'Что именно пошло не так'}
		bind:value={reason}
		errors={reasonError === null ? undefined : [reasonError]}
	/>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="board-move">Подтвердить</Button>
		</div>
	{/snippet}
</FormDialog>
