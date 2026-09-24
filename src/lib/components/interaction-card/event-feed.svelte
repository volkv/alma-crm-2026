<script lang="ts">
	import ArrowLeftRightIcon from '@lucide/svelte/icons/arrow-left-right';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import GitCommitVerticalIcon from '@lucide/svelte/icons/git-commit-vertical';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import OctagonAlertIcon from '@lucide/svelte/icons/octagon-alert';
	import PencilLineIcon from '@lucide/svelte/icons/pencil-line';
	import { onMount, tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as SegmentedControl from '$lib/components/ui/segmented-control/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { actionEnhance } from '$lib/components/interactions/action-enhance';
	import { mentionToken, splitMentions } from '$lib/contracts/mentions';
	import { formatDateTime } from '$lib/format';
	import type { LucideIcon } from '$lib/icon';
	import { cardLiveUrl, LiveActivity } from './live.svelte';
	import type { CardEvent, CardEventKind } from './model';

	/**
	 * Всё, что случилось с записью, одной лентой: переходы, комментарии,
	 * документы, помехи, правки плана и обмен с системой обучения. Раньше это
	 * были пять вкладок, и чтобы понять «что было на прошлой неделе», их
	 * открывали по очереди. Фильтр сужает ленту, не пряча её за вкладкой;
	 * комментарий пишется прямо над ней.
	 *
	 * В комментарии можно позвать коллегу: «@» открывает подсказку из тех, кто
	 * видит дело. В поле остаётся «@Имя», а на сервер уходит токен с
	 * идентификатором (`$lib/contracts/mentions.ts`): имена совпадают, и
	 * адресатом должен стать тот, кого выбрали, а не тёзка. Подсказке сервер не
	 * верит — каждого адресата он проверяет сам.
	 *
	 * Пока поле не пусто и человек набирает, коллеги в карточке видят «Имя
	 * печатает…» под формой; отправка, очистка поля, пауза в наборе и уход со
	 * страницы это гасят.
	 */
	let {
		events,
		canComment,
		mentionable = [],
		typers = [],
		initial = 8
	}: {
		events: readonly CardEvent[];
		/** Есть ли право писать комментарии: без него формы над лентой нет. */
		canComment: boolean;
		/**
		 * Кого можно упомянуть — те, кто видит дело. Приходит живым составом
		 * карточки; пока его нет, подсказка говорит, что список загружается.
		 */
		mentionable?: readonly { userId: string; name: string }[];
		/** Кто из коллег сейчас набирает комментарий — имена, себя нет. */
		typers?: readonly string[];
		/** Сколько событий видно сразу; остальные — по кнопке. */
		initial?: number;
	} = $props();

	const id = 'card-feed';

	const KINDS: { key: CardEventKind | 'all'; label: string }[] = [
		{ key: 'all', label: 'Все' },
		{ key: 'stage', label: 'Стадии' },
		{ key: 'comment', label: 'Комментарии' },
		{ key: 'document', label: 'Документы' },
		{ key: 'exchange', label: 'Обмен' },
		{ key: 'blocker', label: 'Помехи' },
		{ key: 'plan', label: 'План' }
	];

	const ICONS: Record<CardEventKind, LucideIcon> = {
		stage: GitCommitVerticalIcon,
		comment: MessageSquareIcon,
		document: FileTextIcon,
		exchange: ArrowLeftRightIcon,
		blocker: OctagonAlertIcon,
		plan: PencilLineIcon
	};

	const TONE_CLASSES: Record<CardEvent['tone'], string> = {
		neutral: 'bg-surface-muted text-muted-foreground',
		success: 'bg-success-soft text-success-soft-foreground',
		warning: 'bg-warning-soft text-warning-soft-foreground',
		danger: 'bg-danger-soft text-danger-soft-foreground'
	};

	let filter = $state<CardEventKind | 'all'>('all');
	let expanded = $state(false);
	let draft = $state('');
	/** Ключ повтора: один на черновик, новый — после успешной отправки. */
	let requestKey = $state(crypto.randomUUID());
	/** Выбранные из подсказки: что стоит в поле после «@» → кто это. */
	let chosen = $state<Record<string, string>>({});
	/** Начатое «@…» перед кареткой: откуда и что набрано. */
	let query = $state<{ start: number; text: string } | null>(null);
	let highlighted = $state(0);
	/** Без скрипта поле уходит как есть; со скриптом — с токенами упоминаний. */
	let hydrated = $state(false);
	let textarea = $state<HTMLTextAreaElement | null>(null);

	onMount(() => {
		hydrated = true;
	});

	const liveUrl = $derived(cardLiveUrl(page.params));
	let typing: LiveActivity | null = null;

	$effect(() => {
		const activity = new LiveActivity(liveUrl, 'typing');

		typing = activity;

		return () => activity.stop();
	});

	function onInput(): void {
		trackQuery();

		if (draft.trim() === '') {
			typing?.stop();
		} else {
			typing?.typed();
		}
	}

	const typingLine = $derived(
		typers.length === 0
			? ''
			: typers.length === 1
				? `${typers[0]} печатает…`
				: `${typers[0]} и ещё ${typers.length - 1} печатают…`
	);

	const MAX_SUGGESTIONS = 8;

	const suggestions = $derived.by(() => {
		if (query === null) {
			return [];
		}

		const wanted = query.text.toLowerCase();

		return mentionable
			.filter((person) => person.name.toLowerCase().includes(wanted))
			.slice(0, MAX_SUGGESTIONS);
	});

	/** Кого из выбранных поле всё ещё называет: стёртое «@Имя» — уже не упоминание. */
	const named = $derived(
		Object.entries(chosen).filter(([display]) => draft.includes(`@${display}`))
	);

	/** Текст для сервера: «@Имя» выбранных — токенами, длинные имена первыми. */
	const encoded = $derived(
		[...named]
			.sort(([left], [right]) => right.length - left.length)
			.reduce(
				(text, [display, userId]) => text.split(`@${display}`).join(mentionToken(display, userId)),
				draft
			)
	);

	function trackQuery(): void {
		if (textarea === null) {
			return;
		}

		const before = draft.slice(0, textarea.selectionStart);
		const match = /(^|\s)@([^\s@[\]()]{0,40})$/.exec(before);

		query = match === null ? null : { start: before.length - match[2].length - 1, text: match[2] };
		highlighted = 0;
	}

	/** Подпись в поле: имя, а у тёзки уже выбранного — с номером. */
	function displayFor(person: { userId: string; name: string }): string {
		let display = person.name;
		let suffix = 2;

		while (chosen[display] !== undefined && chosen[display] !== person.userId) {
			display = `${person.name} ${suffix}`;
			suffix += 1;
		}

		return display;
	}

	async function pick(person: { userId: string; name: string }): Promise<void> {
		if (query === null || textarea === null) {
			return;
		}

		const display = displayFor(person);
		const start = query.start;
		const end = start + 1 + query.text.length;
		const insert = `@${display} `;
		const field = textarea;

		chosen = { ...chosen, [display]: person.userId };
		draft = draft.slice(0, start) + insert + draft.slice(end);
		query = null;

		await tick();
		field.focus();
		field.setSelectionRange(start + insert.length, start + insert.length);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (query === null || suggestions.length === 0) {
			if (event.key === 'Escape') {
				query = null;
			}

			return;
		}

		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;

			highlighted = (highlighted + step + suggestions.length) % suggestions.length;
		} else if (event.key === 'Enter' || event.key === 'Tab') {
			event.preventDefault();
			void pick(suggestions[highlighted]);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			query = null;
		}
	}

	function resetDraft(): void {
		draft = '';
		chosen = {};
		query = null;
		requestKey = crypto.randomUUID();
	}

	/** Якорь комментария: на него ведёт колокольчик упоминаний. */
	function anchorOf(event: CardEvent): string | undefined {
		return event.kind === 'comment' ? `comment-${event.id.slice('comment:'.length)}` : undefined;
	}

	// Пришли по ссылке на комментарий — развернуть ленту, если он под кнопкой
	// «Показать ещё», и довести до него: браузер не найдёт якорь, которого ещё
	// нет в разметке.
	// Один раз на адрес: живая карточка перечитывает ленту, и каждое
	// перечитывание возвращало бы экран к комментарию.
	let reached: string | null = null;

	$effect(() => {
		const hash = page.url.hash;

		if (!hash.startsWith('#comment-') || reached === hash) {
			return;
		}

		const target = events.find((event) => `#${anchorOf(event)}` === hash);

		if (target === undefined) {
			return;
		}

		reached = hash;
		filter = 'all';
		expanded = !events.slice(0, initial).includes(target);
		void tick().then(() => document.getElementById(hash.slice(1))?.scrollIntoView());
	});

	/** Виды, по которым в ленте хоть что-то есть: пустой фильтр — лишняя кнопка. */
	const present = $derived(
		KINDS.filter((kind) => kind.key === 'all' || events.some((event) => event.kind === kind.key))
	);
	const count = (key: CardEventKind | 'all') =>
		key === 'all' ? events.length : events.filter((event) => event.kind === key).length;
	function selectKind(key: string) {
		const kind = KINDS.find((candidate) => candidate.key === key);
		if (kind === undefined) throw new Error(`Неизвестный вид события: ${key}`);
		filter = kind.key;
		expanded = false;
	}

	const filtered = $derived(
		filter === 'all' ? events : events.filter((event) => event.kind === filter)
	);
	const visible = $derived(expanded ? filtered : filtered.slice(0, initial));
</script>

<svelte:window onpagehide={() => typing?.stop()} />

<!-- `data-tour` — метка подсказок: по ней тур находит ленту событий. -->
<section
	class="flex flex-col gap-3"
	aria-labelledby="{id}-title"
	data-slot="event-feed"
	data-tour="interaction-feed"
>
	<h2 id="{id}-title" class="section-title">События</h2>

	{#if canComment}
		<form
			method="POST"
			action="?/comment"
			use:enhance={actionEnhance({ onsuccess: resetDraft })}
			onsubmit={() => typing?.stop()}
			class="flex flex-col gap-2"
		>
			<label for="{id}-comment" class="sr-only">Текст комментария</label>
			<input type="hidden" name="requestKey" value={requestKey} />
			{#if hydrated}
				<input type="hidden" name="body" value={encoded} />
			{/if}
			<div class="relative">
				<Textarea
					id="{id}-comment"
					name={hydrated ? undefined : 'body'}
					rows={2}
					placeholder="Написать комментарий: что узнали, о чём договорились. «@» — позвать коллегу"
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={query !== null}
					aria-controls="{id}-mentions"
					aria-activedescendant={query !== null && suggestions.length > 0
						? `${id}-mention-${highlighted}`
						: undefined}
					bind:ref={textarea}
					bind:value={draft}
					oninput={onInput}
					onclick={trackQuery}
					onkeydown={onKeydown}
					onblur={() => (query = null)}
				/>
				{#if query !== null}
					<ul
						id="{id}-mentions"
						role="listbox"
						aria-label="Кого упомянуть"
						class="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-surface py-1 text-sm shadow-md"
					>
						{#each suggestions as person, index (person.userId)}
							<li
								id="{id}-mention-{index}"
								role="option"
								aria-selected={index === highlighted}
								class="cursor-pointer px-3 py-1.5 {index === highlighted
									? 'bg-selection text-selection-foreground'
									: 'hover:bg-surface-muted'}"
								onmousedown={(event) => {
									// До `blur` поля: иначе подсказка закроется раньше выбора.
									event.preventDefault();
									void pick(person);
								}}
							>
								{person.name}
							</li>
						{:else}
							<li class="px-3 py-1.5 text-muted-foreground">
								{mentionable.length === 0
									? 'Список тех, кто видит дело, ещё загружается'
									: 'Среди тех, кто видит дело, такого нет'}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="flex items-center justify-between gap-2">
				<p class="min-w-0 truncate text-xs text-muted-foreground">
					{#if named.length > 0}
						Получат уведомление: {named.map(([display]) => display).join(', ')}
					{/if}
				</p>
				<Button type="submit" size="sm" disabled={draft.trim() === ''}>Отправить</Button>
			</div>
		</form>
	{/if}

	{#if typingLine !== ''}
		<p class="text-xs text-muted-foreground" data-slot="feed-typing">{typingLine}</p>
	{/if}

	<SegmentedControl.Root
		size="sm"
		aria-label="Какие события показать"
		value={filter}
		onValueChange={selectKind}
	>
		{#each present as kind (kind.key)}
			<SegmentedControl.Item value={kind.key}>
				{kind.label}
				<span class="tabular-nums opacity-70">{count(kind.key)}</span>
			</SegmentedControl.Item>
		{/each}
	</SegmentedControl.Root>

	<ol class="flex flex-col">
		{#each visible as event (event.id)}
			{@const Icon = ICONS[event.kind]}
			<li class="flex scroll-mt-24 gap-3 py-2" id={anchorOf(event)}>
				<span
					class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full {TONE_CLASSES[
						event.tone
					]}"
				>
					<Icon class="size-3.5" aria-hidden="true" />
				</span>
				<div class="min-w-0 flex-1">
					<p class="text-sm break-words">{event.title}</p>
					{#if event.detail && event.kind === 'comment'}
						<!-- Упоминание — плашкой с именем; токен с идентификатором на
							экран не выходит. -->
						<p class="text-sm break-words whitespace-pre-line text-muted-foreground">
							{#each splitMentions(event.detail) as segment, index (index)}{#if segment.kind === 'mention'}<span
										class="rounded bg-selection px-1 font-medium text-selection-foreground"
										>@{segment.label}</span
									>{:else}{segment.text}{/if}{/each}
						</p>
					{:else if event.detail}
						<p class="text-sm break-words whitespace-pre-line text-muted-foreground">
							{event.detail}
						</p>
					{/if}
					<p class="mt-0.5 text-xs text-faint">
						<time datetime={new Date(event.at).toISOString()}>{formatDateTime(event.at)}</time
						>{event.author ? ` · ${event.author}` : ''}{event.duration
							? ` · ${event.duration}`
							: ''}
					</p>
				</div>
			</li>
		{:else}
			<li class="py-4 text-sm text-muted-foreground">Событий этого вида не было.</li>
		{/each}
	</ol>

	{#if filtered.length > initial}
		<Button
			variant="ghost"
			size="sm"
			class="self-start"
			onclick={() => (expanded = !expanded)}
			aria-expanded={expanded}
		>
			{expanded ? 'Свернуть' : `Показать ещё ${filtered.length - initial}`}
		</Button>
	{/if}
</section>
