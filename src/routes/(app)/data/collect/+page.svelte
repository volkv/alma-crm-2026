<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import Header from '$lib/components/header.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import PeriodSelect from '$lib/components/stats/period-select.svelte';
	import { measureText } from '$lib/components/stats/labels';
	import { STAT_PERIOD_KIND_LABELS } from '$lib/contracts/stats';
	import { formatDate, formatDateTime, formatNumber, pluralize } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let submitting = $state(false);

	const preview = $derived(data.preview);

	function submit() {
		submitting = true;

		return async ({ update }: { update: () => Promise<void> }) => {
			submitting = false;
			await update();
		};
	}
</script>

<svelte:head><title>Сборка из результатов групп — LCT CRM</title></svelte:head>

<Header
	title="Сборка из результатов групп"
	description="Результаты, которые система обучения прислала по учебным группам, складываются в снимок за период. В показатели он попадёт после подтверждения — как любая выгрузка."
/>

<Breadcrumbs
	items={[
		{ label: 'Данные об обучении', href: resolve('/(app)/data') },
		{ label: 'Сборка из результатов групп' }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	{#if form?.message}
		<Alert.Root variant="destructive">
			<TriangleAlertIcon aria-hidden="true" />
			<Alert.Title>{form.message}</Alert.Title>
			{#if form.issues.length > 0}
				<Alert.Description>
					<ul class="list-inside list-disc">
						{#each form.issues as issue (issue)}
							<li>{issue}</li>
						{/each}
					</ul>
				</Alert.Description>
			{/if}
		</Alert.Root>
	{/if}

	<div class="flex flex-wrap items-center gap-3" data-tour="data-collect-period">
		<PeriodSelect periods={data.periods} />
	</div>

	<InlineHint tone="info">
		<span>
			Группа попадает в период по дате старта, и у неё учитывается один результат — последний.
			Завершившие берутся только из итогового результата. Снимок собирается полным: повторная сборка
			того же периода при подтверждении замещает прежнюю, а не складывается с ней.
		</span>
	</InlineHint>

	<div class="grid gap-3 sm:grid-cols-4" data-tour="data-collect-totals">
		<div class="rounded-lg border border-border bg-surface p-4">
			<p class="text-xs text-muted-foreground">Учебных групп</p>
			<p class="text-xl font-semibold">{formatNumber(preview.totals.groups)}</p>
		</div>
		<div class="rounded-lg border border-border bg-surface p-4">
			<p class="text-xs text-muted-foreground">С результатом</p>
			<p class="text-xl font-semibold">{formatNumber(preview.totals.withResult)}</p>
		</div>
		<div class="rounded-lg border border-border bg-surface p-4">
			<p class="text-xs text-muted-foreground">Слушателей</p>
			<p class="text-xl font-semibold">{measureText(preview.totals.enrolled)}</p>
		</div>
		<div class="rounded-lg border border-border bg-surface p-4">
			<p class="text-xs text-muted-foreground">Завершили</p>
			<p class="text-xl font-semibold">{measureText(preview.totals.completed)}</p>
		</div>
	</div>

	{#if preview.skipped.withoutProgram > 0 || preview.skipped.withoutOrganization > 0}
		<InlineHint tone="warning">
			<span>
				Не попадут в снимок:
				{#if preview.skipped.withoutProgram > 0}
					{pluralize(preview.skipped.withoutProgram, ['группа', 'группы', 'групп'])} без программы (заведены
					до того, как группа стала её закреплять){preview.skipped.withoutOrganization > 0
						? ';'
						: '.'}
				{/if}
				{#if preview.skipped.withoutOrganization > 0}
					{pluralize(preview.skipped.withoutOrganization, ['группа', 'группы', 'групп'])} по взаимодействию
					без основной стороны.
				{/if}
			</span>
		</InlineHint>
	{/if}

	<div
		class="overflow-x-auto rounded-lg border border-border bg-surface"
		data-tour="data-collect-rows"
	>
		{#if preview.rows.length === 0}
			<EmptyState
				icon={LayersIcon}
				title="Собирать нечего"
				description="За период нет учебных групп с программой и вузом. Выберите другой период."
			/>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Организация</Table.Head>
						<Table.Head>Программа</Table.Head>
						<Table.Head class="text-right">Потоки</Table.Head>
						<Table.Head class="text-right">Зачислено</Table.Head>
						<Table.Head class="text-right">Завершили</Table.Head>
						<Table.Head>Учебные группы</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each preview.rows as row (`${row.organizationId}-${row.programId}`)}
						<Table.Row>
							<Table.Cell class="font-medium">{row.organizationName}</Table.Cell>
							<Table.Cell>
								<span class="flex min-w-0 flex-col">
									<span class="max-w-72 truncate" title={row.programName}>{row.programName}</span>
									<span class="text-xs text-muted-foreground">{row.programCode}</span>
								</span>
							</Table.Cell>
							<Table.Cell class="text-right">{formatNumber(row.streams)}</Table.Cell>
							<Table.Cell class="text-right">{measureText(row.enrolled)}</Table.Cell>
							<Table.Cell class="text-right">{measureText(row.completed)}</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground">
								{row.groupLabels.join(', ')}
								{#if row.withResult < row.streams}
									<span class="block">
										без результата: {formatNumber(row.streams - row.withResult)}
									</span>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</div>

	<div
		class="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
		data-tour="data-collect-build"
	>
		{#if preview.replaces.length > 0}
			<p class="text-sm">
				После подтверждения новый снимок заместит текущий того же периода:
				{#each preview.replaces as replaced, index (replaced.snapshotId)}
					<a
						class="underline underline-offset-2 focus-ring"
						href={resolve('/(app)/data/[id=uuid]', { id: replaced.snapshotId })}
					>
						{replaced.fileName ?? 'сборка без файла'}{replaced.confirmedAt
							? `, подтверждён ${formatDateTime(replaced.confirmedAt)}`
							: ''}</a
					>{index < preview.replaces.length - 1 ? '; ' : '.'}
				{/each}
			</p>
		{:else}
			<p class="text-sm text-muted-foreground">
				Текущего снимка результатов LMS за {STAT_PERIOD_KIND_LABELS[
					preview.period.periodKind
				].toLowerCase()}
				{formatDate(preview.period.periodStart)} — {formatDate(preview.period.periodEnd)} нет: новый станет
				первым.
			</p>
		{/if}

		<form method="POST" action="?/build" use:enhance={submit}>
			<input type="hidden" name="periodKind" value={preview.period.periodKind} />
			<input type="hidden" name="periodStart" value={preview.period.periodStart} />
			<input type="hidden" name="periodEnd" value={preview.period.periodEnd} />
			<Button type="submit" disabled={submitting || preview.rows.length === 0}>
				<LayersIcon aria-hidden="true" />
				Собрать снимок
			</Button>
		</form>
		<p class="text-xs text-muted-foreground">
			Снимок откроется на шаге проверки: там его подтверждают или отклоняют с причиной.
		</p>
	</div>
</div>
