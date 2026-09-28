<script lang="ts">
	import UserRoundXIcon from '@lucide/svelte/icons/user-round-x';
	import { MediaQuery } from 'svelte/reactivity';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { NO_OPTION } from '$lib/contracts/common';
	import type { InteractionFilterOption } from '$lib/contracts/interactions';
	import { initials } from '$lib/format';
	import { cn } from '$lib/utils.js';

	/**
	 * Фильтр по ответственным — ряд аватарок среди отборов списка, как в
	 * трекерах задач: нажатие на аватарку добавляет человека в отбор или
	 * снимает его, несколько выбранных работают как «или». Кто не поместился в
	 * ряд, выбирается из меню «+N».
	 *
	 * Текущий пользователь стоит первым всегда — даже когда своих дел у него
	 * в пространстве нет: себя ищут чаще всех, и место в ряду не должно
	 * зависеть от того, что сейчас на доске. Ссылку, как и у
	 * `list-filter.svelte`, собирает вызывающий через `ontoggle`.
	 *
	 * Остальные варианты — только те, у кого в пространстве есть
	 * взаимодействия (`readInteractionFilterOptions`). Когда выбирать не из
	 * кого, кроме одного человека, ряда нет.
	 *
	 * Если в пространстве есть дела без ответственного, в ряду стоит и
	 * «Без ответственного» (значение `none`): разобрать эту очередь — частая
	 * работа руководителя.
	 */
	let {
		options,
		selected,
		currentUser,
		hasUnassigned = false,
		ontoggle
	}: {
		options: readonly InteractionFilterOption[];
		selected: readonly string[];
		currentUser: { id: string; fullName: string } | null;
		hasUnassigned?: boolean;
		ontoggle: (value: string) => void;
	} = $props();

	const UNASSIGNED: InteractionFilterOption = { value: NO_OPTION, label: 'Без ответственного' };

	/**
	 * Сколько аватарок видно в ряду; остальные — в меню «+N». На телефоне ряд
	 * делит первую строку панели с поиском, и больше двух аватарок оставили бы
	 * поиску полоску в пару букв. Граница — `sm` Tailwind, та же, на которой
	 * панель фильтров перестаёт делиться на строки. На сервере ширины экрана
	 * не знают, и до гидратации ряд считается широким.
	 */
	const wide = new MediaQuery('min-width: 640px', true);
	const visibleCount = $derived(wide.current ? 6 : 2);

	const currentUserId = $derived(currentUser?.id ?? null);
	const ordered = $derived([
		...(currentUser === null ? [] : [{ value: currentUser.id, label: currentUser.fullName }]),
		...(hasUnassigned ? [UNASSIGNED] : []),
		...options.filter((option) => option.value !== currentUserId)
	]);
	const visible = $derived(ordered.slice(0, visibleCount));
	const rest = $derived(ordered.slice(visibleCount));
	const restSelected = $derived(rest.filter((option) => selected.includes(option.value)).length);

	/**
	 * Выбранный человек отмечается ободком через зазор, а не заливкой: когда
	 * у аватарки появится фото, заливки под ним видно не будет. Цвет ободка —
	 * цвет выбранного, фиолетовый: оранжевый только у главного действия. Фокус с
	 * клавиатуры рисуется `outline`, а не тенью (`focus-ring`) — иначе он
	 * затирал бы ободок выбора, который тоже тень.
	 *
	 * Кнопка — ровный круг в размер аватарки (`size-8 aspect-square`). На
	 * телефоне зона нажатия растёт до 44 px невидимым `::after`, а не высотой
	 * кнопки: вытянутая кнопка рисовала бы овальный ободок. Поэтому ряд отборов
	 * и не растягивает кнопки с `data-owner-avatar` своим правилом высоты.
	 */
	const OWNER_BUTTON =
		'relative flex size-8 shrink-0 aspect-square items-center justify-center rounded-full ring-2 ring-background transition-transform outline-none hover:z-20 hover:-translate-y-0.5 focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring max-sm:after:absolute max-sm:after:-inset-1.5 max-sm:after:rounded-full';
	const SELECTED = 'z-10 ring-selection-border ring-offset-2 ring-offset-background';

	function caption(option: InteractionFilterOption): string {
		return option.value === currentUserId ? `${option.label} (вы)` : option.label;
	}
</script>

{#if ordered.length > 1}
	<Tooltip.Provider delayDuration={300}>
		<div
			class="flex shrink-0 items-center -space-x-1.5"
			role="group"
			aria-label="Ответственные"
			data-testid="interactions-filter-owner"
			data-tour="interactions-owners"
		>
			{#each visible as option (option.value)}
				{@const active = selected.includes(option.value)}
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								data-owner-avatar
								aria-pressed={active}
								aria-label={caption(option)}
								data-active={active ? 'true' : undefined}
								class={cn(OWNER_BUTTON, active && SELECTED)}
								onclick={() => ontoggle(option.value)}
							>
								<Avatar.Root>
									<Avatar.Fallback
										class={cn(
											'text-xs font-medium',
											option.value === currentUserId && 'bg-selection text-selection-foreground'
										)}
									>
										{#if option.value === NO_OPTION}
											<UserRoundXIcon class="size-4" aria-hidden="true" />
										{:else}
											{initials(option.label)}
										{/if}
									</Avatar.Fallback>
								</Avatar.Root>
							</button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>{caption(option)}</Tooltip.Content>
				</Tooltip.Root>
			{/each}

			{#if rest.length > 0}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								data-owner-avatar
								aria-label="Ещё ответственные: {rest.length}"
								data-active={restSelected > 0 ? 'true' : undefined}
								class={cn(
									OWNER_BUTTON,
									'bg-muted text-xs font-medium text-muted-foreground tabular-nums',
									restSelected > 0 && SELECTED
								)}
							>
								+{rest.length}
							</button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start" class="max-h-96 w-72 overflow-y-auto">
						<DropdownMenu.Group>
							<DropdownMenu.GroupHeading>Ответственные</DropdownMenu.GroupHeading>
							{#each rest as option (option.value)}
								<DropdownMenu.CheckboxItem
									checked={selected.includes(option.value)}
									onCheckedChange={() => ontoggle(option.value)}
									closeOnSelect={false}
								>
									<Avatar.Root size="sm">
										<Avatar.Fallback class="font-medium">
											{#if option.value === NO_OPTION}
												<UserRoundXIcon class="size-3.5" aria-hidden="true" />
											{:else}
												{initials(option.label)}
											{/if}
										</Avatar.Fallback>
									</Avatar.Root>
									<span class="truncate">{option.label}</span>
								</DropdownMenu.CheckboxItem>
							{/each}
						</DropdownMenu.Group>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		</div>
	</Tooltip.Provider>
{/if}
