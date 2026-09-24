<script lang="ts">
	import { formatDayAndMonth } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import Header from '$lib/components/header.svelte';
	import ActivityFeed from '$lib/components/home/activity-feed.svelte';
	import HomeSection from '$lib/components/home/section.svelte';
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

<Header title="Сводка" description="Что требует внимания сегодня, {today}">
	{#snippet actions()}
		<Button variant="outline" href={interactionsHref({ status: 'active', mine: true })}>
			Мои взаимодействия
		</Button>
	{/snippet}
</Header>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<!-- `data-tour` — метка подсказок: по ней тур находит блок, о котором
		говорит его шаг (`$lib/onboarding/screens`). -->
	<div data-tour="home-my-day">
		<HomeSection
			title="Мой день"
			description="Что требует внимания сегодня. {MY_DAY_BASIS_LABELS[myDay.basis]}"
		>
			<MyDay sections={myDay.sections} />
		</HomeSection>
	</div>

	<StatTiles counters={overview.counters} />

	<div data-tour="home-portfolio">
		<HomeSection
			title="Где стоит портфель"
			description="Активные взаимодействия по группам стадий процесса"
		>
			<PortfolioBar distribution={overview.distribution} labels={STAGE_CATEGORY_LABELS} />
		</HomeSection>
	</div>

	<HomeSection title="Недавняя активность" description="Последние события по взаимодействиям">
		<ActivityFeed items={overview.activity} labels={AUDIT_EVENT_LABELS} />
	</HomeSection>
</div>
