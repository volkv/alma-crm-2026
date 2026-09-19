<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import { cn } from '$lib/utils';

	/**
	 * Три взгляда на данные об обучении: загрузки, показатели и портфель
	 * периода.
	 *
	 * Это ссылки, а не состояние экрана: у каждого взгляда свой адрес, и
	 * открытый дашборд можно послать коллеге. Отчётный период переезжает вместе
	 * с переходом — вопрос «за какой год» не должен задаваться дважды подряд.
	 */
	const period = $derived(page.url.searchParams.get('period'));

	function withPeriod(path: ResolvedPathname): ResolvedPathname {
		// Путь собрал `resolve` ниже; строку запроса приходится дописывать
		// руками — её типа в `ResolvedPathname` нет (так же сделано в
		// `components/home/links.ts`).
		return period === null
			? path
			: (`${path}?period=${encodeURIComponent(period)}` as ResolvedPathname);
	}

	const tabs = $derived([
		{ href: resolve('/(app)/data'), label: 'Снимки', carriesPeriod: false },
		{ href: resolve('/(app)/data/indicators'), label: 'Показатели', carriesPeriod: true },
		{ href: resolve('/(app)/data/dashboard'), label: 'Дашборд', carriesPeriod: true }
	]);
</script>

<!-- `data-tour` — метка подсказок: полосу разделов показывают шаги всех трёх
	экранов данных об обучении (`$lib/onboarding/screens`). -->
<nav
	class="-mx-1 overflow-x-auto px-1 py-0.5"
	aria-label="Разделы данных об обучении"
	data-tour="data-sections"
>
	<div class="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-[3px]">
		{#each tabs as tab (tab.href)}
			{@const active = page.url.pathname === tab.href}
			<a
				href={tab.carriesPeriod ? withPeriod(tab.href) : tab.href}
				aria-current={active ? 'page' : undefined}
				class={cn(
					'inline-flex items-center rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap text-muted-foreground focus-ring hover:text-foreground',
					active && 'bg-surface text-foreground shadow-xs'
				)}
			>
				{tab.label}
			</a>
		{/each}
	</div>
</nav>
