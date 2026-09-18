<script lang="ts">
	import { formatDayAndMonth } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import PageHeader from '$lib/components/page-header.svelte';
	import ActivityFeed from '$lib/components/home/activity-feed.svelte';
	import HomeSection from '$lib/components/home/section.svelte';
	import NeedsAction from '$lib/components/home/needs-action.svelte';
	import PortfolioBar from '$lib/components/home/portfolio-bar.svelte';
	import StatTiles from '$lib/components/home/stat-tiles.svelte';
	import WaitingList from '$lib/components/home/waiting-list.svelte';
	import { interactionsHref } from '$lib/components/home/links';
	import { AUDIT_EVENT_LABELS } from './audit/labels';
	import { STAGE_CATEGORY_LABELS } from './interactions/filters';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const overview = $derived(data.overview);
	const today = $derived(formatDayAndMonth(overview.generatedAt));
</script>

<svelte:head>
	<title>Сводка — LCT CRM</title>
</svelte:head>

<PageHeader title="Сводка" description="Что требует внимания сегодня, {today}">
	{#snippet actions()}
		<Button variant="outline" href={interactionsHref({ status: 'active', mine: true })}>
			Мои взаимодействия
		</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<StatTiles counters={overview.counters} />

	<!-- `data-tour` — метка для подсказок первого входа: по ней тур находит
		блок, о котором говорит его шаг (`$lib/onboarding/steps`). -->
	<div data-tour="home-portfolio">
		<HomeSection
			title="Где стоит портфель"
			description="Активные взаимодействия по группам стадий процесса"
		>
			<PortfolioBar distribution={overview.distribution} labels={STAGE_CATEGORY_LABELS} />
		</HomeSection>
	</div>

	<div data-tour="home-needs-action">
		<HomeSection
			title="Требуют действия"
			description={overview.needsAction.basis === 'mine'
				? 'Ваши взаимодействия: сначала просроченные, затем с помехами и с близким сроком'
				: 'Просроченные взаимодействия области доступа'}
		>
			<NeedsAction
				tasks={overview.needsAction.tasks}
				basis={overview.needsAction.basis}
				now={overview.generatedAt}
			/>
		</HomeSection>
	</div>

	<div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
		<HomeSection title="Ждём вуз" description="Стадии, часы которых остановлены ожиданием">
			<WaitingList items={overview.waiting} now={overview.generatedAt} />
		</HomeSection>

		<HomeSection title="Недавняя активность" description="Последние события по взаимодействиям">
			<ActivityFeed items={overview.activity} labels={AUDIT_EVENT_LABELS} />
		</HomeSection>
	</div>
</div>
