<script lang="ts" module>
	import type { BoardCardState, BoardTransitionOption } from '$lib/contracts/interactions';

	/**
	 * Полоса слева повторяет цвет стадии на ленте (`StageTimeline`): одно и то же
	 * состояние обязано выглядеть одинаково в списке, в карточке и на доске.
	 */
	const accents: Record<BoardCardState, string> = {
		current: 'border-l-primary',
		overdue: 'border-l-danger',
		paused: 'border-l-border-strong',
		blocked: 'border-l-warning'
	};

	/** Как состояние называется словами — теми же, что на ленте и в списке. */
	const stateTitles: Record<BoardCardState, string> = {
		current: 'в срок',
		overdue: 'просрочена',
		paused: 'на паузе',
		blocked: 'с помехой'
	};

	/** Подпись перехода — та же, что на кнопках карточки взаимодействия. */
	export function transitionLabel(option: BoardTransitionOption): string {
		if (option.kind === 'forward') {
			return `Перейти: ${option.toStageName}`;
		}

		return option.kind === 'return'
			? `Вернуть: ${option.toStageName}`
			: `Пропустить до: ${option.toStageName}`;
	}
</script>

<script lang="ts">
	import BuildingIcon from '@lucide/svelte/icons/building';
	import EllipsisVerticalIcon from '@lucide/svelte/icons/ellipsis-vertical';
	import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import { resolve } from '$app/paths';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import SlaChip from '$lib/components/sla-chip.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { InteractionBoardCard } from '$lib/contracts/interactions';
	import { cn } from '$lib/utils';

	/**
	 * Взаимодействие на доске: по чему его узнают и из-за чего берутся за него
	 * сейчас — организация, программы, ответственный и срок стадии.
	 *
	 * Двигают карточку двумя способами, и оба ведут к одной и той же команде
	 * сервера: перетаскиванием в другую колонку и меню «Перевести». Меню — не
	 * дубль ради полноты, а единственный способ сделать то же самое с
	 * клавиатуры.
	 */
	let {
		card,
		workspace,
		/** Есть ли право двигать стадии: без него карточка не перетаскивается. */
		canTransition,
		dragging = false,
		onmove,
		ondragstart,
		ondragend
	}: {
		card: InteractionBoardCard;
		/** Ключ пространства: карточка открывается его адресом. */
		workspace: string;
		canTransition: boolean;
		/** Эту карточку сейчас тащат. */
		dragging?: boolean;
		onmove: (option: BoardTransitionOption) => void;
		ondragstart: () => void;
		ondragend: () => void;
	} = $props();

	const draggable = $derived(canTransition && card.transitions.length > 0);

	function start(event: DragEvent) {
		if (event.dataTransfer === null) {
			return;
		}

		// Опознавательный знак для браузера: без данных перетаскивание в части
		// браузеров не начинается вовсе. Что именно двигают, страница помнит
		// сама — событие `drop` приходит уже с готовым состоянием.
		event.dataTransfer.setData('text/plain', card.id);
		event.dataTransfer.effectAllowed = 'move';
		ondragstart();
	}
</script>

<li
	class={cn(
		'flex flex-col gap-2 rounded-lg border border-l-4 border-border bg-surface p-2.5 shadow-xs',
		accents[card.state],
		draggable && 'cursor-grab active:cursor-grabbing',
		dragging && 'opacity-50'
	)}
	data-slot="board-card"
	data-card-state={card.state}
	draggable={draggable ? 'true' : 'false'}
	ondragstart={start}
	{ondragend}
>
	<div class="flex items-start gap-1">
		<a
			href={resolve('/(app)/w/[workspace]/interactions/[id=uuid]', { workspace, id: card.id })}
			class="line-clamp-2 min-w-0 flex-1 font-medium focus-ring hover:underline"
			title="{card.title} — стадия {stateTitles[card.state]}"
		>
			{card.title}
		</a>

		{#if card.transitions.length > 0}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-xs"
							aria-label="Перевести на другую стадию"
						>
							<EllipsisVerticalIcon aria-hidden="true" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-64">
					<DropdownMenu.Group>
						<DropdownMenu.GroupHeading>Перевести в…</DropdownMenu.GroupHeading>
						{#each card.transitions as option (option.toStageId)}
							<!-- Недоступный переход остаётся в меню с причиной: пункт,
								который исчез, не объясняет ничего. Приговор считает
								сервер — здесь он только показан. -->
							<DropdownMenu.Item
								disabled={!option.allowed}
								onSelect={() => onmove(option)}
								class="flex-col items-start gap-0.5"
							>
								<span>{transitionLabel(option)}</span>
								{#if !option.allowed}
									<span class="text-xs whitespace-normal text-muted-foreground">
										{option.reasons.join('; ')}
									</span>
								{/if}
							</DropdownMenu.Item>
						{/each}
					</DropdownMenu.Group>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}
	</div>

	{#if card.organizationName !== null}
		<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
			<BuildingIcon class="size-3.5 shrink-0" aria-hidden="true" />
			<span class="truncate" title={card.organizationName}>{card.organizationName}</span>
		</p>
	{/if}

	{#if card.offerings.length > 0}
		<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
			<GraduationCapIcon class="size-3.5 shrink-0" aria-hidden="true" />
			<span class="truncate" title={card.offerings.join(', ')}>{card.offerings[0]}</span>
			{#if card.offerings.length > 1}
				<span class="shrink-0 text-faint">+{card.offerings.length - 1}</span>
			{/if}
		</p>
	{/if}

	<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
		<UserRoundIcon class="size-3.5 shrink-0" aria-hidden="true" />
		<span class="truncate">{card.ownerName}</span>
	</p>

	<div class="flex flex-wrap items-center gap-1">
		<!-- Срок и пауза показываются теми же двумя способами, что и в списке:
			на паузе часы стадии стоят, и остаток времени соврал бы. -->
		{#if card.state === 'paused'}
			<StatusBadge tone="neutral" dot title="Часы стадии остановлены">на паузе</StatusBadge>
		{:else if card.dueAt !== null}
			<SlaChip deadline={card.dueAt} />
		{/if}
		{#if card.openBlockers > 0}
			<StatusBadge tone="warning" dot>Помех: {card.openBlockers}</StatusBadge>
		{/if}
	</div>
</li>
