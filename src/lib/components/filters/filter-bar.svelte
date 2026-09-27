<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import FunnelXIcon from '@lucide/svelte/icons/funnel-x';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import FilterStrip, { type StripFilter } from './filter-strip.svelte';
	import ListSearch from './list-search.svelte';

	/**
	 * Ряд отборов над списком — один на все экраны со списками: поиск, за ним
	 * фильтры, сброс и то, что относится к виду («Колонки», переключатель).
	 * С `sm` это одна строка: фильтры, которые не поместились, уходят в панель
	 * под воронкой (`filter-strip.svelte`), и строка не переносится. На
	 * телефоне две: поиск (с `lead` рядом) и под ним фильтры с `end`; панель
	 * спрятанных фильтров раскрывается третьей строкой. Цели нажатия на
	 * телефоне — 44 px. Кнопки с `data-owner-avatar` из правила высоты
	 * исключены: растянутая по высоте аватарка превращала круг и ободок выбора
	 * в овал, — зону нажатия они растят сами (`owner-filter.svelte`).
	 *
	 * Сброс снимает весь отбор разом — фильтры и поиск; адрес без отбора
	 * собирает экран (`clearHref`), кнопка есть, только пока есть что снимать.
	 *
	 * `testId` — префикс меток для тестов: `<testId>-search`,
	 * `<testId>-filter-more`, `<testId>-filter-clear`.
	 */
	let {
		search,
		filters,
		testId,
		clearHref,
		lead,
		end,
		...rest
	}: {
		search: { value: string; placeholder: string; onsearch: (value: string) => void };
		filters: readonly StripFilter[];
		testId: string;
		/** Адрес того же списка без отбора; `null` — снимать нечего, кнопки нет. */
		clearHref: string | null;
		/** Что стоит сразу за поиском в его строке: аватарки ответственных. */
		lead?: Snippet;
		/** Что прижато к концу строки: «Колонки», переключатель вида. */
		end?: Snippet;
	} & HTMLAttributes<HTMLDivElement> = $props();
</script>

{#snippet clear()}
	{#if clearHref !== null}
		<Tooltip.Provider delayDuration={300}>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon"
							href={clearHref}
							aria-label="Сбросить фильтры"
							data-testid="{testId}-filter-clear"
						>
							<FunnelXIcon aria-hidden="true" />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Сбросить фильтры</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	{/if}
{/snippet}

<div
	class="flex flex-wrap items-center gap-x-2 gap-y-3 max-sm:[&_a]:min-h-11 max-sm:[&_button:not([data-owner-avatar])]:min-h-11"
	{...rest}
>
	<div class="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:shrink-0">
		<ListSearch
			value={search.value}
			placeholder={search.placeholder}
			testId="{testId}-search"
			onsearch={search.onsearch}
		/>
		{@render lead?.()}
	</div>

	<FilterStrip
		{filters}
		panelId="{testId}-filter-panel"
		moreTestId="{testId}-filter-more"
		trailing={clearHref === null ? undefined : clear}
		{end}
	/>
</div>
