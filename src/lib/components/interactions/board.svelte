<script lang="ts">
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import RouteIcon from '@lucide/svelte/icons/route';
	import { enhance } from '$app/forms';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import FilterSelect from '$lib/components/directory/filter-select.svelte';
	import type { FieldOption } from '$lib/components/form/field-select.svelte';
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
	 * Доска взаимодействий: колонка на стадию маршрута, карточка на дело.
	 *
	 * Список отвечает, что с отдельной записью, доска — где стоит работа целиком:
	 * на какой стадии скопились дела и сколько из них просрочено. Данные приходят
	 * готовыми (`$lib/server/interactions/board`), запросов компонент не делает и
	 * доступность перехода не выводит — приговор считает сервер.
	 *
	 * Двигают карточку перетаскиванием или меню на ней; оба пути отправляют одно
	 * и то же действие страницы, а движок решает, состоится ли переход. Отказ
	 * приходит словами в тост, и карточка остаётся там, где стояла.
	 */
	let {
		board,
		/** Право `stages.transition`: без него доска только показывает. */
		canTransition,
		/** Список отобран фильтром — пустота значит разное в двух случаях. */
		isFiltered
	}: {
		board: InteractionBoardView;
		canTransition: boolean;
		isFiltered: boolean;
	} = $props();

	/** Какую карточку сейчас тащат и над какой колонкой держат. */
	let dragged = $state<InteractionBoardCard | null>(null);
	let hovered = $state<string | null>(null);

	/** Собранная команда перехода: ей осталось получить причину или уехать. */
	let pending = $state<{ card: InteractionBoardCard; option: BoardTransitionOption } | null>(null);
	let reasonOpen = $state(false);
	let moveForm = $state<HTMLFormElement | null>(null);

	const routeOptions: FieldOption[] = $derived(
		board.routes.map((route) => ({
			value: route.id,
			label: `${route.name} — версия ${route.version}`
		}))
	);

	/** Стадии, на которые эту карточку разрешает переносить маршрут. */
	const targets = $derived(new Set(dragged?.transitions.map((option) => option.toStageId) ?? []));

	const stageNames = $derived(
		new Map(board.columns.map((column) => [column.stageId, column.name]))
	);

	/** Собранный переход — шаг вперёд: от этого зависят слова в диалоге. */
	const forward = $derived(pending?.option.kind === 'forward');

	async function move(card: InteractionBoardCard, option: BoardTransitionOption) {
		pending = { card, option };

		// Переход, которому маршрут назначил объяснение, спрашивает его до команды,
		// а не показывает отказ после неё. Это и возврат с пропуском, и шаг вперёд
		// там, где процесс требует сказать, чем закончили стадию.
		if (option.requiresReason) {
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
		// будет вовсе. Бросок принимают все колонки, даже те, куда маршрут
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
			toast.error('Такого перехода в маршруте нет', {
				description: `С «${stageNames.get(card.stageId) ?? 'текущей стадии'}» на «${column.name}» маршрут переходов не описывает.`
			});

			return;
		}

		void move(card, option);
	}
</script>

{#if board.routes.length > 1}
	<div class="flex flex-wrap items-center gap-3">
		<FilterSelect
			param="route"
			label="Маршрут"
			options={routeOptions}
			allLabel="Маршрут по умолчанию"
		/>
	</div>
{/if}

{#if board.routeId === null}
	<div class="rounded-lg border border-border bg-surface">
		<EmptyState
			icon={RouteIcon}
			title="Маршрут стадий не настроен"
			description="Доска раскладывает взаимодействия по стадиям маршрута. Пока нет ни одной опубликованной версии процесса, раскладывать не по чему."
		/>
	</div>
{:else if board.total === 0}
	<div class="rounded-lg border border-border bg-surface">
		<EmptyState
			title={isFiltered ? 'Под фильтр ничего не попало' : 'На доске пока пусто'}
			description={isFiltered
				? 'Измените фильтры или вернитесь к списку — доска показывает только те записи, что стоят на стадии маршрута.'
				: 'Доска показывает взаимодействия, которые идут по этому маршруту прямо сейчас. Завершённые на ней не стоят: у них нет текущей стадии.'}
		/>
	</div>
{:else}
	{#if canTransition}
		<InlineHint>
			Карточку можно перетащить в соседнюю колонку — или перевести её пунктом меню на самой
			карточке. Переход выполняет движок: если стадия к нему не готова, карточка останется на месте
			и скажет почему.
		</InlineHint>
	{/if}

	<!-- Колонок четырнадцать, и на телефоне они не поместятся никогда: вбок
		уезжает сама доска, а не документ вокруг неё. -->
	<div class="flex gap-3 overflow-x-auto pb-2" data-slot="interactions-board">
		{#each board.columns as column (column.stageId)}
			<section
				class={cn(
					'flex w-72 shrink-0 flex-col gap-2 rounded-lg border p-2 transition-colors',
					hovered === column.stageId && targets.has(column.stageId)
						? 'border-primary bg-primary-soft'
						: hovered === column.stageId
							? 'border-border-strong bg-surface-muted'
							: dragged !== null && targets.has(column.stageId)
								? 'border-primary-soft-border bg-surface-muted'
								: 'border-border bg-surface-muted'
				)}
				aria-label="Стадия: {column.name}"
				ondragover={(event) => over(event, column)}
				ondragleave={(event) => leave(event, column)}
				ondrop={(event) => drop(event, column)}
			>
				<header class="flex items-start justify-between gap-2">
					<h2 class="min-w-0 text-xs leading-tight font-medium" title={column.name}>
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
					<ul class="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
						{#each column.cards as card (card.id)}
							<BoardCard
								{card}
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
	use:enhance={actionEnhance({
		onsuccess: () => {
			reasonOpen = false;
			pending = null;
		}
	})}
>
	<input type="hidden" name="interactionId" value={pending?.card.id ?? ''} />
	<input type="hidden" name="fromStageId" value={pending?.card.stageId ?? ''} />
	<input type="hidden" name="toStageId" value={pending?.option.toStageId ?? ''} />
	<input type="hidden" name="kind" value={pending?.option.kind ?? ''} />
</form>

<Dialog.Root bind:open={reasonOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{pending === null ? 'Перевести' : transitionLabel(pending.option)}</Dialog.Title
			>
			<Dialog.Description>
				{pending?.card.title ?? ''} — объяснение попадёт в историю взаимодействия.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-1.5">
			<!-- На шаге вперёд объяснение — это комментарий «чем закончили стадию»,
				а не разбор неудачи: спрашивать «что пошло не так» там, где всё
				прошло хорошо, значит сбивать с толку. -->
			<Label for="boardMoveReason">{forward ? 'Комментарий' : 'Причина'}</Label>
			<Textarea
				id="boardMoveReason"
				name="reason"
				form="board-move"
				rows={3}
				required
				placeholder={forward ? 'Чем закончилась стадия' : 'Что именно пошло не так'}
			/>
		</div>

		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (reasonOpen = false)}>Отмена</Button>
			<Button type="submit" form="board-move">Подтвердить</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
