<script lang="ts">
	import { resolve } from '$app/paths';
	import CircleUserIcon from '@lucide/svelte/icons/circle-user';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { initials } from '$lib/format';
	import { cn } from '$lib/utils';
	import type { SessionUser } from '$lib/server/auth/types';

	/**
	 * Who is signed in, and the way out. Signing out is a POST, not a link: it
	 * changes state, so it must not be reachable by a prefetch or a crawler.
	 *
	 * Карточка стоит в подвале меню разделов и называет имя и роль: на вопрос
	 * «кто я здесь и что мне можно» отвечают вместе, и роль — первое, обо что
	 * спотыкаются, когда экран выглядит не так, как у соседа. Почта
	 * спрашивается реже и нарочно — она внутри, под нажатием.
	 *
	 * Оттуда же открывается «Профиль»: учётная запись человека — не правило
	 * системы, и в ряду настроек ей не место (`$lib/nav`). Ищут её там, где
	 * написано, кто вошёл. Знакомство с системой — в самом меню разделов
	 * («Знакомство с системой»), а тур по экрану — под компасом и значком «?».
	 */
	let {
		user,
		collapsed = false,
		side = 'bottom',
		variant = 'menu'
	}: {
		user: SessionUser;
		/** Свёрнутое меню: остаётся один значок, имя уходит в подпись для читалки. */
		collapsed?: boolean;
		/** С какой стороны от карточки раскрывается список. Только у `menu`. */
		side?: 'top' | 'right' | 'bottom' | 'left';
		/**
		 * Чем открывается карточка. `menu` — выпадающий список у самой карточки:
		 * на мыши это ближайший путь к выходу. `dialog` — окно посреди экрана: на
		 * телефоне карточка стоит в подвале выдвижного меню, и список, прижатый к
		 * нижнему краю, оказывался узкой полосой у границы экрана.
		 */
		variant?: 'menu' | 'dialog';
	} = $props();

	const profileHref = resolve('/(app)/settings/profile');

	// Карточка занимает весь подвал и отступы держит сама: фон, который
	// загорается под курсором и при открытом списке, обязан заливать всю полосу
	// целиком, а не висеть прямоугольником в её середине. Поэтому здесь обычная
	// `button`, а не `Button` продукта: у той рост задан жёстко (`h-control`),
	// отступы его не раздвигают, и карточка сжималась в узкую полоску.
	const triggerClass = $derived(
		cn(
			'flex w-full cursor-pointer items-center gap-2.5 px-3 py-3 text-left text-sm transition-colors focus-ring hover:bg-surface-muted aria-expanded:bg-surface-muted',
			collapsed && 'justify-center px-0'
		)
	);
</script>

{#snippet card()}
	<!-- Значок крупнее малого (32 пк вместо 24), а буквы в нём прежние:
		разница уходит в поля вокруг инициалов — в малом они липли к границе. -->
	<Avatar.Root>
		<Avatar.Fallback class="bg-selection text-xs font-medium text-selection-foreground">
			{initials(user.fullName)}
		</Avatar.Fallback>
	</Avatar.Root>
	{#if collapsed}
		<span class="sr-only">{user.fullName} — учётная запись, роль: {user.roleName}</span>
	{:else}
		<!-- Роль строкой ниже имени и мельче его: она подпись к имени, а не
			второе имя. Обе строки обрезаются по отдельности — длинное имя не
			должно вытеснять роль за край. -->
		<span class="flex min-w-0 flex-1 flex-col text-left">
			<span class="truncate text-sm font-medium">{user.fullName}</span>
			<span class="truncate text-xs text-muted-foreground">{user.roleName}</span>
		</span>
		<ChevronsUpDownIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
	{/if}
{/snippet}

{#if variant === 'dialog'}
	<Dialog.Root>
		<Dialog.Trigger>
			{#snippet child({ props })}
				<button {...props} type="button" class={triggerClass} data-tour="user-menu">
					{@render card()}
				</button>
			{/snippet}
		</Dialog.Trigger>
		<Dialog.Content>
			<Dialog.Header>
				<Dialog.Title>Учётная запись</Dialog.Title>
				<Dialog.Description class="sr-only">Кто вошёл в систему, и выход из неё</Dialog.Description>
			</Dialog.Header>
			<div class="flex items-center gap-3">
				<Avatar.Root size="lg">
					<Avatar.Fallback class="bg-selection text-sm font-medium text-selection-foreground">
						{initials(user.fullName)}
					</Avatar.Fallback>
				</Avatar.Root>
				<div class="min-w-0">
					<p class="truncate text-sm font-medium">{user.fullName}</p>
					<p class="truncate text-xs text-muted-foreground">{user.email}</p>
					<p class="mt-1 text-xs text-faint">Роль: {user.roleName}</p>
				</div>
			</div>
			<Button href={profileHref} variant="outline" class="w-full">
				<CircleUserIcon aria-hidden="true" />
				Профиль
			</Button>
			<form method="POST" action="/logout">
				<Button type="submit" variant="outline" class="w-full">
					<LogOutIcon aria-hidden="true" />
					Выйти
				</Button>
			</form>
		</Dialog.Content>
	</Dialog.Root>
{:else}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<button {...props} type="button" class={triggerClass} data-tour="user-menu">
					{@render card()}
				</button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content {side} align="end" class="w-56">
			<div class="px-2 py-1.5">
				<p class="truncate text-sm font-medium">{user.fullName}</p>
				<p class="truncate text-xs text-muted-foreground">{user.email}</p>
				<p class="mt-1 text-xs text-faint">Роль: {user.roleName}</p>
			</div>
			<DropdownMenu.Separator />
			<DropdownMenu.Item>
				{#snippet child({ props })}
					<a {...props} href={profileHref}>
						<CircleUserIcon aria-hidden="true" />
						Профиль
					</a>
				{/snippet}
			</DropdownMenu.Item>
			<DropdownMenu.Separator />
			<form method="POST" action="/logout">
				<DropdownMenu.Item class="w-full">
					{#snippet child({ props })}
						<button {...props} type="submit">
							<LogOutIcon aria-hidden="true" />
							Выйти
						</button>
					{/snippet}
				</DropdownMenu.Item>
			</form>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
