<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import MappingTable from '$lib/components/stats/mapping-table.svelte';
	import WizardSteps from '$lib/components/stats/wizard-steps.svelte';
	import {
		STAT_SNAPSHOT_MODE_LABELS,
		STAT_SOURCE_LABELS,
		type StatSnapshotListItem
	} from '$lib/contracts/stats';
	import { formatDate, formatNumber, pluralize } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let submitting = $state(false);

	const snapshot: StatSnapshotListItem = $derived(data.snapshot);
</script>

<svelte:head><title>Сопоставление колонок — LCT CRM</title></svelte:head>

<PageHeader
	title="Сопоставление колонок"
	description="Шаг 2 из 3: какая колонка файла что означает. Предложение помечено значком — меняйте его там, где система ошиблась."
	breadcrumbs={[{ label: 'Данные', href: resolve('/(app)/data') }]}
/>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<WizardSteps current={2} />

	<div class="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
		<span>Источник: {STAT_SOURCE_LABELS[snapshot.source]}</span>
		<span>Режим: {STAT_SNAPSHOT_MODE_LABELS[snapshot.mode]}</span>
		<span>Период: {formatDate(snapshot.periodStart)} — {formatDate(snapshot.periodEnd)}</span>
		<span>В файле: {pluralize(data.preview.totalRows, ['строка', 'строки', 'строк'])}</span>
	</div>

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

	<form
		method="POST"
		class="flex flex-col gap-4"
		use:enhance={() => {
			submitting = true;

			return async ({ update }) => {
				submitting = false;
				await update();
			};
		}}
	>
		<MappingTable
			headers={data.preview.headers}
			advice={data.preview.advice}
			mapping={data.preview.mapping}
			sample={data.preview.sample}
		/>

		<p class="text-sm text-muted-foreground">
			Организацию и программу сопоставить обязательно: без них строку не к чему отнести. Организация
			узнаётся и по названию, и по ИНН. Если колонки периода в файле нет, строки получат период
			снимка. Показано {formatNumber(data.preview.headers.length)} колонок.
		</p>

		<FormActions {submitting} submitLabel="Дальше: проверка строк" />
	</form>
</div>
