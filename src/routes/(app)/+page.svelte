<script lang="ts">
	import { formatDayAndMonth } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import Header from '$lib/components/header.svelte';
	import ActivityFeed from '$lib/components/home/activity-feed.svelte';
	import HomeSection from '$lib/components/home/section.svelte';
	import DayCounters from '$lib/components/home/day-counters.svelte';
	import MyDay from '$lib/components/home/my-day.svelte';
	import PortfolioBar from '$lib/components/home/portfolio-bar.svelte';
	import StatTiles from '$lib/components/home/stat-tiles.svelte';
	import { interactionsHref } from '$lib/components/home/links';
	import { MY_DAY_BASIS_LABELS } from '$lib/contracts/my-day';
	import { AUDIT_EVENT_LABELS } from './audit/labels';
	import { STAGE_CATEGORY_LABELS } from './w/[workspace]/interactions/filters';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const overview = $derived(data.overview);
	const myDay = $derived(data.myDay);
	const today = $derived(formatDayAndMonth(overview.generatedAt));
</script>

<svelte:head>
	<title>Сводка — Альма CRM</title>
</svelte:head>

<Header
	title="Сводка"
	description="Что требует внимания сегодня, {today}. {MY_DAY_BASIS_LABELS[myDay.basis]}"
>
	{#snippet actions()}
		<Button variant="outline" href={interactionsHref({ status: 'active', owner: data.user?.id })}>
			Мои взаимодействия
		</Button>
	{/snippet}
</Header>

<!-- Первый экран ноутбука (1366×768) держит счётчики всех разделов «Моего
	дня» и первые его карточки; портфель и лента стоят справа, вторым планом.
	Уже ноутбука колонка справа уезжает под «Мой день».

	`data-tour` — метка подсказок: по ней тур находит блок, о котором говорит
	его шаг (`$lib/onboarding/screens`). -->
<div class="grid gap-4 p-4 sm:px-9 sm:py-6 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
	<!-- Счётчики — во всю ширину: семь подписей в колонке рядом с портфелем
		обрезались бы до первых букв. -->
	<div class="xl:col-span-2" data-tour="home-my-day">
		<h2 class="sr-only">Мой день</h2>
		<DayCounters sections={myDay.sections} />
	</div>

	<div class="min-w-0">
		<MyDay sections={myDay.sections} />
	</div>

	<div class="grid min-w-0 gap-4 lg:grid-cols-2 xl:grid-cols-1">
		<HomeSection
			title="Портфель"
			description="Активные взаимодействия по группам стадий процесса"
			data-tour="home-portfolio"
		>
			<StatTiles counters={overview.counters} />
			<PortfolioBar distribution={overview.distribution} labels={STAGE_CATEGORY_LABELS} />
		</HomeSection>

		<HomeSection title="Недавняя активность" description="Последние события по взаимодействиям">
			<ActivityFeed items={overview.activity} labels={AUDIT_EVENT_LABELS} />
		</HomeSection>
	</div>
</div>
