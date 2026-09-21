<script lang="ts">
	import MenuIcon from '@lucide/svelte/icons/menu';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import HelpMenu from '$lib/components/onboarding/help-menu.svelte';
	import type { SessionUser } from '$lib/server/auth/types';
	import AppNav from './app-nav.svelte';
	import ThemeToggle from './theme-toggle.svelte';
	import UserMenu from './user-menu.svelte';
	import { search } from './search.svelte';
	import type { NavLink } from './nav-links';

	/**
	 * Нижняя панель телефона: поиск, справка, тема, разделы.
	 *
	 * На узком экране бокового меню нет, а верхняя полоса оболочки убрана —
	 * шапку страницы больше ничто не повторяет. Всё, что не про открытую
	 * страницу, а про систему вокруг неё, собрано здесь: панель висит над
	 * содержимым, не уезжает при прокрутке, и до неё дотягивается большой палец —
	 * низ экрана ближе к руке, чем его верх.
	 *
	 * Разделы — крайними справа: телефон держат правой рукой, и под большой палец
	 * попадает правый край, а меню разделов из четырёх кнопок нажимают чаще всего.
	 *
	 * Ячейки с подписями, а не одни значки: значок «?» и кружок темы узнают по
	 * названию, а не по рисунку, и один раз прочитанная подпись объясняет панель
	 * на все последующие экраны.
	 */
	let {
		links,
		user
	}: {
		links: readonly NavLink[];
		/** `null`, пока не приехала сессия: карточки учётной записи тогда нет. */
		user: SessionUser | null;
	} = $props();

	let navOpen = $state(false);
</script>

<!-- Обёртка во всю ширину, но сквозная для нажатий: панель занимает её
	середину, а по краям под ней остаётся страница, и промах мимо панели обязан
	попадать в содержимое, а не в пустоту.

	Отступ снизу считается с `env(safe-area-inset-bottom)`: на телефонах с
	жестовой полосой панель иначе встаёт прямо на неё. -->
<div
	class="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:hidden"
>
	<nav
		aria-label="Система"
		class="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-surface/90 px-2 py-1.5 shadow-lg backdrop-blur"
	>
		<span class="flex w-16 flex-col items-center gap-0.5">
			<Button
				variant="ghost"
				size="icon-sm"
				class="text-muted-foreground"
				data-tour="search"
				aria-label="Поиск"
				onclick={() => search.show()}
			>
				<SearchIcon aria-hidden="true" />
			</Button>
			<span class="text-[10px] leading-none text-muted-foreground">Поиск</span>
		</span>

		<span class="flex w-16 flex-col items-center gap-0.5">
			<HelpMenu />
			<span class="text-[10px] leading-none text-muted-foreground">Справка</span>
		</span>

		<span class="flex w-16 flex-col items-center gap-0.5" data-tour="theme-toggle">
			<ThemeToggle class="border-0" />
			<span class="text-[10px] leading-none text-muted-foreground">Тема</span>
		</span>

		<Sheet.Root bind:open={navOpen}>
			<Sheet.Trigger>
				{#snippet child({ props })}
					<!-- `data-tour="nav"` стоит и здесь, и на боковом меню: подсказка
						про разделы одна, а показать её надо на том из двух, что сейчас
						на экране (`onboarding-tour.svelte`). -->
					<span class="flex w-16 flex-col items-center gap-0.5" data-tour="nav">
						<Button
							{...props}
							variant="ghost"
							size="icon-sm"
							class="text-muted-foreground"
							aria-label="Разделы"
						>
							<MenuIcon aria-hidden="true" />
						</Button>
						<span class="text-[10px] leading-none text-muted-foreground">Разделы</span>
					</span>
				{/snippet}
			</Sheet.Trigger>
			<Sheet.Content side="left" class="w-64 gap-0 p-0">
				<Sheet.Header class="h-14 shrink-0 justify-center border-b border-border px-4">
					<Sheet.Title class="text-sm font-semibold">LCT CRM</Sheet.Title>
					<Sheet.Description class="sr-only">Разделы системы</Sheet.Description>
				</Sheet.Header>
				<div class="min-h-0 flex-1 overflow-y-auto">
					<AppNav {links} onnavigate={() => (navOpen = false)} />
				</div>
				<!-- Карточка учётной записи повторяет подвал бокового меню: на
					телефоне того меню нет, а выход из системы живёт только в ней. -->
				{#if user}
					<div class="shrink-0 border-t border-border">
						<UserMenu {user} variant="dialog" />
					</div>
				{/if}
			</Sheet.Content>
		</Sheet.Root>
	</nav>
</div>
