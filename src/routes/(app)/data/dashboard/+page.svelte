<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { tableHref } from '$lib/components/data-table/query';
	import EmptyState from '$lib/components/empty-state.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import Section from '$lib/components/home/section.svelte';
	import DashboardTiles from '$lib/components/stats/dashboard-tiles.svelte';
	import PeriodSelect from '$lib/components/stats/period-select.svelte';
	import RankingList from '$lib/components/stats/ranking-list.svelte';
	import SectionTabs from '$lib/components/stats/section-tabs.svelte';
	import { measureText } from '$lib/components/stats/labels';
	import {
		coverageShare,
		statPeriodKey,
		STAT_PROGRAM_GROUP_LABELS,
		STAT_SNAPSHOT_MODE_LABELS,
		STAT_SOURCE_LABELS,
		type StatDashboardOrganizationRow,
		type StatDashboardSortKey
	} from '$lib/contracts/stats';
	import { formatDate, formatDateTime, formatNumber } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const dashboard = $derived(data.dashboard);
	const periodKey = $derived(dashboard === null ? '' : statPeriodKey(dashboard.period));

	/**
	 * Ссылки на соседние экраны с тем же периодом. Путь собирает `resolve`, а
	 * строку запроса приходится дописывать руками: её типа в `ResolvedPathname`
	 * нет — так же сделано в ссылках со сводки (`components/home/links.ts`).
	 */
	function withPeriod(path: ResolvedPathname, params: Record<string, string>): ResolvedPathname {
		const query = new URLSearchParams({ period: periodKey, ...params });

		return `${path}?${query.toString()}` as ResolvedPathname;
	}

	/** Ссылка на выгрузку: тот же период, что и на экране. */
	const exportHref = $derived(withPeriod(resolve('/(app)/data/export'), {}));

	/** Сколько программ показывает дашборд: это верхушка рейтинга, а не отчёт. */
	const TOP_PROGRAMS = 5;

	/** Весь рейтинг за тот же период. */
	const rankingHref = $derived(withPeriod(resolve('/(app)/data/ranking'), {}));

	/**
	 * Ссылка на тот же экран с другим порядком строк: повторный выбор той же
	 * колонки переворачивает порядок.
	 */
	function sortHref(key: StatDashboardSortKey): ResolvedPathname {
		const descending = data.sortBy === key ? data.sortDirection !== 'desc' : key !== 'organization';

		return tableHref(page.url, { sortBy: key, sortDirection: descending ? 'desc' : 'asc' });
	}

	function share(row: StatDashboardOrganizationRow): number | null {
		return coverageShare(row.coveragePlan, row.coverageFact);
	}
</script>

{#snippet sortHead(key: StatDashboardSortKey, label: string, alignEnd: boolean)}
	<Table.Head class={alignEnd ? 'text-right' : ''}>
		<a
			href={sortHref(key)}
			class="inline-flex items-center gap-1 rounded-sm focus-ring hover:text-foreground"
			data-sort={key}
		>
			{label}
			{#if data.sortBy === key}
				{#if data.sortDirection === 'desc'}
					<ChevronDownIcon class="size-3.5" aria-hidden="true" />
				{:else}
					<ChevronUpIcon class="size-3.5" aria-hidden="true" />
				{/if}
			{/if}
		</a>
	</Table.Head>
{/snippet}

<svelte:head><title>Дашборд данных — Альма CRM</title></svelte:head>

<Header
	title="Дашборд данных"
	description="Портфель обучения за один отчётный период: сколько программ и вузов, сколько заявок и обучающихся и из каких загрузок это сложилось."
>
	{#snippet actions()}
		{#if dashboard !== null}
			<Button variant="outline" href={exportHref} data-testid="export-report">
				<DownloadIcon aria-hidden="true" />
				Выгрузить отчёт (xlsx)
			</Button>
		{/if}
	{/snippet}
</Header>

<Breadcrumbs
	items={[
		{ label: 'Данные об обучении', href: resolve('/(app)/data') },
		{ label: 'Дашборд данных' }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<SectionTabs />

	{#if dashboard === null}
		<div class="rounded-xl border border-border bg-surface">
			<EmptyState
				icon={DatabaseIcon}
				title="Показывать пока нечего"
				description="Дашборд считается по подтверждённым снимкам: до подтверждения числа остаются черновиком и в портфель не попадают."
			>
				{#snippet action()}
					{#if data.canImport}
						<Button href={resolve('/(app)/data/new')}>Загрузить файл</Button>
					{:else}
						<Button variant="outline" href={resolve('/(app)/data')}>К снимкам данных</Button>
					{/if}
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-3" data-tour="data-dashboard-period">
			<PeriodSelect periods={data.periods} />
			<span class="text-sm text-muted-foreground">
				{#if dashboard.updatedAt === null}
					Подтверждённых снимков за период нет
				{:else}
					Данные актуальны на {formatDateTime(dashboard.updatedAt)}
				{/if}
			</span>
		</div>

		{#if dashboard.totals.programCount === 0}
			<InlineHint tone="info">
				За период {formatDate(dashboard.period.start)} — {formatDate(dashboard.period.end)} в вашей области
				доступа нет ни одной подтверждённой строки. Выберите другой период или загрузите данные.
			</InlineHint>
		{/if}

		<DashboardTiles totals={dashboard.totals} />

		<div class="grid gap-4 xl:grid-cols-2">
			<Section
				title="Топ программ по рейтингу"
				description="По фактам системы за тот же период: заявки с сайта, потоки, обучающиеся и завершившие. Формула — гипотеза команды, веса настраиваются."
			>
				{#snippet action()}
					<Button variant="outline" size="sm" href={rankingHref}>Весь рейтинг</Button>
				{/snippet}

				<RankingList
					entries={dashboard.ranking.programs}
					limit={TOP_PROGRAMS}
					hrefOf={(id) => resolve('/(app)/programs/[id=uuid]', { id })}
					emptyTitle="Ранжировать нечего"
					emptyDescription="За период в вашей области нет ни заявок с сайта, ни учебных групп с программой."
				/>
			</Section>

			<Section
				title="Программы по уровню"
				description="Школьная профориентация и вузовский набор — разные задачи, и в одно число они не складываются."
			>
				{#if dashboard.groups.length === 0}
					<EmptyState
						title="Разбивки нет"
						description="За выбранный период нет подтверждённых строк ни по одной программе."
					/>
				{:else}
					<div class="overflow-x-auto">
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head>Группа</Table.Head>
									<Table.Head class="text-right">Программ</Table.Head>
									<Table.Head class="text-right">Заявки</Table.Head>
									<Table.Head class="text-right">Зачислено</Table.Head>
									<Table.Head class="text-right">Потоки</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each dashboard.groups as group (group.group)}
									<Table.Row data-group={group.group}>
										<Table.Cell class="font-medium">
											{STAT_PROGRAM_GROUP_LABELS[group.group]}
										</Table.Cell>
										<Table.Cell class="text-right">{formatNumber(group.programCount)}</Table.Cell>
										<Table.Cell class="text-right">{measureText(group.applications)}</Table.Cell>
										<Table.Cell class="text-right">{measureText(group.enrolled)}</Table.Cell>
										<Table.Cell class="text-right">{measureText(group.parallelStreams)}</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>
				{/if}
			</Section>
		</div>

		<Section
			title="Распределение по вузам и площадкам"
			description="Строка на организацию: столько программ, заявок и обучающихся приходится на неё за период."
		>
			{#if data.organizations.length === 0}
				<EmptyState
					title="Распределять нечего"
					description="За выбранный период нет подтверждённых строк ни по одной организации."
				/>
			{:else}
				<div class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								{@render sortHead('organization', 'Организация', false)}
								{@render sortHead('programs', 'Программ', true)}
								{@render sortHead('applications', 'Заявки', true)}
								{@render sortHead('enrolled', 'Обучающиеся', true)}
								{@render sortHead('coverage', 'Охват, %', true)}
								<Table.Head class="text-right">Охват, план и факт</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.organizations as row (row.organizationId)}
								<Table.Row data-organization={row.organizationId}>
									<Table.Cell>
										<a
											href={resolve('/(app)/organizations/[id=uuid]', { id: row.organizationId })}
											class="font-medium underline-offset-2 focus-ring hover:underline"
										>
											{row.organizationName}
										</a>
									</Table.Cell>
									<Table.Cell class="text-right">{formatNumber(row.programCount)}</Table.Cell>
									<Table.Cell class="text-right">{measureText(row.applications)}</Table.Cell>
									<Table.Cell class="text-right">{measureText(row.enrolled)}</Table.Cell>
									<Table.Cell class="text-right">
										{@const percent = share(row)}
										{percent === null ? '—' : `${formatNumber(percent)} %`}
									</Table.Cell>
									<Table.Cell class="text-right text-muted-foreground">
										{measureText(row.coveragePlan)} / {measureText(row.coverageFact)}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
		</Section>

		<Section
			data-tour="data-dashboard-origin"
			title="Происхождение"
			description="Из каких загрузок сложилась картина периода. Актуальность — это подтверждение импорта, а не момент загрузки файла."
		>
			{#if dashboard.sources.length === 0}
				<EmptyState
					title="Подтверждённых загрузок нет"
					description="Числа появляются после того, как снимок подтвердили: до этого они остаются черновиком."
				/>
			{:else}
				<div class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Источник</Table.Head>
								<Table.Head>Режим</Table.Head>
								<Table.Head>Файл</Table.Head>
								<Table.Head>Загрузил</Table.Head>
								<Table.Head>Подтверждён</Table.Head>
								<Table.Head class="text-right">Строк в периоде</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each dashboard.sources as source (source.snapshotId)}
								<Table.Row>
									<Table.Cell>
										<a
											href={resolve('/(app)/data/[id=uuid]', { id: source.snapshotId })}
											class="font-medium underline-offset-2 focus-ring hover:underline"
										>
											{STAT_SOURCE_LABELS[source.source]}
										</a>
									</Table.Cell>
									<Table.Cell>{STAT_SNAPSHOT_MODE_LABELS[source.mode]}</Table.Cell>
									<Table.Cell class="max-w-64 truncate" title={source.fileName ?? undefined}>
										{source.fileName ?? '—'}
									</Table.Cell>
									<Table.Cell>{source.authorName ?? '—'}</Table.Cell>
									<Table.Cell>
										{source.confirmedAt === null ? '—' : formatDateTime(source.confirmedAt)}
									</Table.Cell>
									<Table.Cell class="text-right">{formatNumber(source.rowCount)}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
		</Section>
	{/if}
</div>
