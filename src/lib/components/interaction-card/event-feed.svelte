<script lang="ts">
	import ArrowLeftRightIcon from '@lucide/svelte/icons/arrow-left-right';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import GitCommitVerticalIcon from '@lucide/svelte/icons/git-commit-vertical';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import OctagonAlertIcon from '@lucide/svelte/icons/octagon-alert';
	import PencilLineIcon from '@lucide/svelte/icons/pencil-line';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { formatDateTime } from '$lib/format';
	import type { LucideIcon } from '$lib/icon';
	import { mockAction } from './mock';
	import type { CardEvent, CardEventKind } from './model';

	/**
	 * Всё, что случилось с записью, одной лентой: переходы, комментарии,
	 * документы, помехи, правки плана и обмен с системой обучения. Раньше это
	 * были пять вкладок, и чтобы понять «что было на прошлой неделе», их
	 * открывали по очереди. Фильтр сужает ленту, не пряча её за вкладкой;
	 * комментарий пишется прямо над ней.
	 */
	let {
		events,
		id = 'card-feed',
		initial = 8
	}: {
		events: readonly CardEvent[];
		id?: string;
		/** Сколько событий видно сразу; остальные — по кнопке. */
		initial?: number;
	} = $props();

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

	/** Виды, по которым в ленте хоть что-то есть: пустой фильтр — лишняя кнопка. */
	const present = $derived(
		KINDS.filter((kind) => kind.key === 'all' || events.some((event) => event.kind === kind.key))
	);
	const count = (key: CardEventKind | 'all') =>
		key === 'all' ? events.length : events.filter((event) => event.kind === key).length;
	const filtered = $derived(
		filter === 'all' ? events : events.filter((event) => event.kind === filter)
	);
	const visible = $derived(expanded ? filtered : filtered.slice(0, initial));
</script>

<section class="flex flex-col gap-3" aria-labelledby="{id}-title" data-slot="event-feed">
	<h2 id="{id}-title" class="text-base font-semibold">События</h2>

	<form
		class="flex flex-col gap-2"
		onsubmit={(event) => {
			event.preventDefault();
			mockAction('Отправить комментарий');
		}}
	>
		<label for="{id}-comment" class="sr-only">Комментарий</label>
		<Textarea
			id="{id}-comment"
			rows={2}
			placeholder="Написать комментарий: что узнали, о чём договорились"
			bind:value={draft}
		/>
		<div class="flex justify-end">
			<Button type="submit" size="sm" variant={draft.trim() === '' ? 'outline' : 'default'}>
				Отправить
			</Button>
		</div>
	</form>

	<div class="flex flex-wrap gap-1.5" role="group" aria-label="Какие события показать">
		{#each present as kind (kind.key)}
			<button
				type="button"
				aria-pressed={filter === kind.key}
				class="inline-flex h-7 items-center gap-1 rounded-4xl border px-2.5 text-xs font-medium focus-ring {filter ===
				kind.key
					? 'border-primary-soft-border bg-primary-soft text-primary'
					: 'border-border bg-surface text-muted-foreground hover:bg-surface-muted'}"
				onclick={() => {
					filter = kind.key;
					expanded = false;
				}}
			>
				{kind.label}
				<span class="tabular-nums opacity-70">{count(kind.key)}</span>
			</button>
		{/each}
	</div>

	<ol class="flex flex-col">
		{#each visible as event (event.id)}
			{@const Icon = ICONS[event.kind]}
			<li class="flex gap-3 py-2">
				<span
					class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full {TONE_CLASSES[
						event.tone
					]}"
				>
					<Icon class="size-3.5" aria-hidden="true" />
				</span>
				<div class="min-w-0 flex-1">
					<p class="text-sm break-words">{event.title}</p>
					{#if event.detail}
						<p class="text-sm break-words whitespace-pre-line text-muted-foreground">
							{event.detail}
						</p>
					{/if}
					<p class="mt-0.5 text-xs text-faint">
						<time datetime={new Date(event.at).toISOString()}>{formatDateTime(event.at)}</time
						>{event.author ? ` · ${event.author}` : ''}
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
