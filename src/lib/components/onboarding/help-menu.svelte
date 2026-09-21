<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import CircleQuestionMarkIcon from '@lucide/svelte/icons/circle-question-mark';
	import CompassIcon from '@lucide/svelte/icons/compass';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { pluralize } from '$lib/format';
	import { screenForPath } from '$lib/onboarding/screens';
	import { getOnboardingTour } from '$lib/onboarding/tour.svelte';
	import { search } from '$lib/components/app-shell/search.svelte';

	/**
	 * Значок «?»: подсказки и справка с любого экрана.
	 *
	 * Стоит в подвале меню разделов, а на телефоне — в нижней панели, рядом с
	 * поиском и темой, и не зависит от страницы под ним — это и есть обещание
	 * самодокументированной системы: что бы человек ни открыл, объяснение
	 * находится в одном и том же месте, а не там, где его успели положить.
	 *
	 * Точка-напоминание горит, пока подсказки этого экрана на этом устройстве не
	 * смотрели. Признак лежит в браузере, и до гидратации его не прочитать,
	 * поэтому тур до тех пор отвечает «смотрели»: точка, мелькнувшая на долю
	 * секунды после загрузки страницы, — не напоминание, а рябь.
	 */

	const tour = getOnboardingTour();

	let open = $state(false);

	/** Экран реестра, на котором человек стоит; `null` — экран вне подсказок. */
	const screen = $derived(screenForPath(page.url.pathname));
	const screenSteps = $derived(screen === null ? 0 : tour.screenLength(screen));
	const unseen = $derived(screen !== null && !tour.screenSeen(screen.id));

	// Образцы записей спрашиваются, когда меню открыли: числа шагов полного тура
	// зависят от того, какие карточки этой сессии разрешено открыть.
	$effect(() => {
		if (open) {
			tour.prepare();
		}
	});
</script>

<DropdownMenu.Root bind:open>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon-sm"
				class="relative text-muted-foreground"
				aria-label="Подсказки и справка"
				data-tour="help-menu"
			>
				<CircleQuestionMarkIcon aria-hidden="true" />
				{#if unseen}
					<span
						class="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
						aria-hidden="true"
					></span>
				{/if}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-72">
		{#if screen !== null}
			<DropdownMenu.Label>Этот экран: {screen.title}</DropdownMenu.Label>
			<DropdownMenu.Item onSelect={() => tour.startScreen(screen, page.url.pathname)}>
				<CompassIcon aria-hidden="true" />
				<span class="min-w-0 flex-1 truncate">Подсказки по этому экрану</span>
				<span class="shrink-0 text-xs text-faint">
					{pluralize(screenSteps, ['шаг', 'шага', 'шагов'])}
				</span>
			</DropdownMenu.Item>
		{/if}

		{#if tour.fullLength > 0}
			<DropdownMenu.Item onSelect={() => tour.startFull()}>
				<SparklesIcon aria-hidden="true" />
				<span class="min-w-0 flex-1 truncate">Полный тур по системе</span>
				<span class="shrink-0 text-xs text-faint">
					{pluralize(tour.fullLength, ['шаг', 'шага', 'шагов'])}
				</span>
			</DropdownMenu.Item>
		{/if}

		{#if screen?.help !== undefined}
			{@const article = screen.help}
			<DropdownMenu.Item>
				{#snippet child({ props })}
					<a
						{...props}
						href={resolve('/(app)/help/[section]/[page]', {
							section: article.section,
							page: article.page
						})}
					>
						<FileTextIcon aria-hidden="true" />
						<span class="min-w-0 flex-1 truncate">Статья справки: {article.title}</span>
					</a>
				{/snippet}
			</DropdownMenu.Item>
		{/if}

		<DropdownMenu.Separator />

		<DropdownMenu.Item>
			{#snippet child({ props })}
				<a {...props} href={resolve('/(app)/help')}>
					<BookOpenIcon aria-hidden="true" />
					Все руководства
				</a>
			{/snippet}
		</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={() => search.show()}>
			<SearchIcon aria-hidden="true" />
			<span class="min-w-0 flex-1 truncate">Быстрый поиск</span>
			<kbd class="rounded border border-border bg-surface-muted px-1 font-sans text-[10px]">
				Ctrl+K
			</kbd>
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
