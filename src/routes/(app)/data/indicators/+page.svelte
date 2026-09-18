<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import ChartNoAxesColumnIcon from '@lucide/svelte/icons/chart-no-axes-column';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FilterSelect from '$lib/components/directory/filter-select.svelte';
	import { filterHref } from '$lib/components/directory/query';
	import EmptyState from '$lib/components/empty-state.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import ScoreBreakdown from '$lib/components/stats/score-breakdown.svelte';
	import SectionTabs from '$lib/components/stats/section-tabs.svelte';
	import { measureText } from '$lib/components/stats/labels';
	import type { FieldOption } from '$lib/components/form/field-select.svelte';
	import {
		statPeriodKey,
		STAT_PERIOD_KIND_LABELS,
		type StatIndicatorRow
	} from '$lib/contracts/stats';
	import { formatDate, formatNumber } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const PERIOD_OPTIONS: readonly FieldOption[] = $derived(
		data.periods.map((period) => ({
			value: statPeriodKey(period),
			label: `${STAT_PERIOD_KIND_LABELS[period.kind]}: ${formatDate(period.start)} — ${formatDate(period.end)}`
		}))
	);

	const PROGRAM_OPTIONS: readonly FieldOption[] = $derived(
		data.filters.programs.map((program) => ({ value: program.id, label: program.label }))
	);

	const ORGANIZATION_OPTIONS: readonly FieldOption[] = $derived(
		data.filters.organizations.map((organization) => ({
			value: organization.id,
			label: organization.label
		}))
	);

	const columns: ColumnDef<DataTableFeatures, StatIndicatorRow>[] = [
		{
			id: 'program',
			accessorFn: (row) => row.programName,
			header: 'Программа',
			meta: { title: 'Программа' },
			enableSorting: false,
			enableHiding: false,
			cell: ({ row }) => renderSnippet(programCell, row.original)
		},
		{
			id: 'organization',
			accessorFn: (row) => row.organizationName,
			header: 'Организация',
			meta: { title: 'Организация' },
			enableSorting: false,
			cell: ({ row }) => row.original.organizationName
		},
		{
			id: 'period',
			header: 'Период',
			meta: { title: 'Период' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(periodCell, row.original)
		},
		{
			id: 'applications',
			header: 'Заявки',
			meta: { title: 'Заявки', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => measureText(row.original.applications)
		},
		{
			id: 'enrolled',
			header: 'Зачислено',
			meta: { title: 'Зачислено', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => measureText(row.original.enrolled)
		},
		{
			id: 'parallelStreams',
			header: 'Потоки',
			meta: { title: 'Потоки', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => measureText(row.original.parallelStreams)
		},
		{
			id: 'completed',
			header: 'Завершили',
			meta: { title: 'Завершили', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => measureText(row.original.completed)
		},
		{
			id: 'coveragePlan',
			header: 'Охват, план',
			meta: { title: 'Охват, план', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => measureText(row.original.coveragePlan)
		},
		{
			id: 'coverageFact',
			header: 'Охват, факт',
			meta: { title: 'Охват, факт', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => measureText(row.original.coverageFact)
		},
		{
			id: 'snapshotCount',
			header: 'Снимков',
			meta: { title: 'Снимков', align: 'end' },
			enableSorting: false,
			cell: ({ row }) => formatNumber(row.original.snapshotCount)
		}
	];

	/** Выгрузка — про тот же период, что выбран здесь. */
	const periodKey = $derived(data.selected === null ? '' : statPeriodKey(data.selected));

	const exportHref = $derived(
		periodKey === '' ? undefined : `${resolve('/(app)/data/export')}?period=${periodKey}`
	);

	/** Вкладка живёт в адресе: открытый рейтинг — это ссылка, а не состояние экрана. */
	function selectTab(value: string) {
		return goto(filterHref(page.url, 'tab', value === 'ranking' ? 'ranking' : ''), {
			keepFocus: true,
			noScroll: true
		});
	}
</script>

{#snippet programCell(row: StatIndicatorRow)}
	<span class="flex min-w-0 flex-col">
		<span class="max-w-72 truncate font-medium" title={row.programName}>{row.programName}</span>
		<span class="text-xs text-muted-foreground">{row.programCode}</span>
	</span>
{/snippet}

{#snippet periodCell(row: StatIndicatorRow)}
	<span class="whitespace-nowrap">{formatDate(row.periodStart)} — {formatDate(row.periodEnd)}</span>
{/snippet}

<svelte:head><title>Показатели — LCT CRM</title></svelte:head>

<PageHeader
	title="Показатели"
	description="Считаются по подтверждённым снимкам. Прочерк означает, что данных нет, ноль — что ноль записан в выгрузке."
	breadcrumbs={[{ label: 'Данные об обучении', href: resolve('/(app)/data') }]}
>
	{#snippet actions()}
		<!-- Выгрузка всегда про один период: без выбора кнопка выключена, а
		     причина написана словами ниже, а не спрятана в подсказке мыши. -->
		<Button variant="outline" href={exportHref} disabled={data.selected === null}>
			<DownloadIcon aria-hidden="true" />
			Выгрузить отчёт (xlsx)
		</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<SectionTabs />

	{#if data.periods.length === 0}
		<div class="rounded-lg border border-border bg-surface shadow-xs">
			<EmptyState
				icon={ChartNoAxesColumnIcon}
				title="Показателей пока нет"
				description="Показатель появляется после того, как загруженный снимок подтвердили: до подтверждения числа остаются черновиком."
			>
				{#snippet action()}
					<Button href={resolve('/(app)/data')}>К снимкам данных</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-3">
			<FilterSelect param="period" label="Период" options={PERIOD_OPTIONS} allLabel="Все периоды" />
			<FilterSelect param="programId" label="Программа" options={PROGRAM_OPTIONS} />
			<FilterSelect param="organizationId" label="Организация" options={ORGANIZATION_OPTIONS} />
		</div>

		{#if data.selected === null}
			<p class="text-sm text-muted-foreground">
				Период не выбран: строки показаны как есть, по одной на период. Пересекающиеся периоды не
				складываются — одни и те же обучающиеся посчитались бы дважды. По той же причине выключена и
				выгрузка отчёта: она собирается по одному отчётному периоду.
			</p>
		{/if}

		<Tabs.Root value={data.tab} onValueChange={selectTab}>
			<!-- Две подписи в строку шире телефона: на узком экране список
			     прокручивается сам, а не уносит вправо весь документ (так же
			     сделано на карточке взаимодействия и в `stats/section-tabs`). -->
			<Tabs.List class="max-w-full overflow-x-auto">
				<Tabs.Trigger value="indicators">По программам и организациям</Tabs.Trigger>
				<Tabs.Trigger value="ranking">Рейтинг программ</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="indicators" class="pt-4">
				<DataTable
					{columns}
					rows={data.rows}
					total={data.total}
					getRowId={(row) => `${row.programId}-${row.organizationId}-${row.periodStart}`}
					emptyTitle="Под фильтр ничего не подошло"
					emptyDescription="Снимите фильтр или выберите другой период."
					initialHiddenColumns={['coveragePlan', 'coverageFact', 'snapshotCount']}
				/>
			</Tabs.Content>

			<Tabs.Content value="ranking" class="pt-4">
				{#if data.selected === null}
					<div class="rounded-lg border border-border bg-surface">
						<EmptyState
							title="Выберите период"
							description="Рейтинг считается по одному отчётному периоду: сложить все периоды подряд значит посчитать одних и тех же обучающихся дважды."
						/>
					</div>
				{:else if data.ranking.length === 0}
					<div class="rounded-lg border border-border bg-surface">
						<EmptyState
							title="Ранжировать нечего"
							description="За выбранный период нет подтверждённых данных ни по одной программе."
						/>
					</div>
				{:else}
					<div class="overflow-x-auto rounded-lg border border-border bg-surface">
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head class="w-12 text-right">Место</Table.Head>
									<Table.Head>Программа</Table.Head>
									<Table.Head class="text-right">Балл</Table.Head>
									<Table.Head class="text-right">Организаций</Table.Head>
									<Table.Head class="w-96">Почему</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each data.ranking as item, index (item.programId)}
									<Table.Row>
										<Table.Cell class="text-right text-muted-foreground">{index + 1}</Table.Cell>
										<Table.Cell>
											<span class="flex min-w-0 flex-col">
												<span class="font-medium">{item.programName}</span>
												<span class="text-xs text-muted-foreground">{item.programCode}</span>
											</span>
										</Table.Cell>
										<Table.Cell class="text-right font-medium">
											{formatNumber(item.score)}
										</Table.Cell>
										<Table.Cell class="text-right">
											{formatNumber(item.organizationCount)}
										</Table.Cell>
										<Table.Cell>
											<ScoreBreakdown explanation={item.explanation} />
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>

					<p class="pt-3 text-sm text-muted-foreground">
						Балл — сумма слагаемых в колонке «почему». Веса — гипотеза до технического задания: они
						объявлены в контрактах одним списком и меняются вместе с объяснением.
					</p>
				{/if}
			</Tabs.Content>
		</Tabs.Root>
	{/if}
</div>
