<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import MappingTable from '$lib/components/stats/mapping-table.svelte';
	import WizardSteps from '$lib/components/stats/wizard-steps.svelte';
	import {
		describeStatFile,
		STAT_FIELD_LABELS,
		STAT_FIELDS,
		STAT_FIELD_NONE,
		STAT_PREVIEW_ROWS,
		STAT_SNAPSHOT_MODE_LABELS,
		STAT_SOURCE_LABELS,
		type StatSnapshotListItem
	} from '$lib/contracts/stats';
	import { formatDate, formatNumber, pluralize } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let submitting = $state(false);

	const snapshot: StatSnapshotListItem = $derived(data.snapshot);

	/** Поля строки снимка для общей таблицы сопоставления. */
	const FIELD_OPTIONS = STAT_FIELDS.map((field) => ({
		value: field,
		label: STAT_FIELD_LABELS[field]
	}));
</script>

<svelte:head><title>Сопоставление колонок — LCT CRM</title></svelte:head>

<Header
	title="Сопоставление колонок"
	description="Шаг 2 из 3: какая колонка файла что означает. Предложение помечено значком — меняйте его там, где система ошиблась."
/>

<Breadcrumbs
	items={[
		{ label: 'Данные об обучении', href: resolve('/(app)/data') },
		{ label: 'Сопоставление колонок' }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<WizardSteps current={2} />

	<div class="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
		<span>Источник: {STAT_SOURCE_LABELS[snapshot.source]}</span>
		<span>Режим: {STAT_SNAPSHOT_MODE_LABELS[snapshot.mode]}</span>
		<span>Период: {formatDate(snapshot.periodStart)} — {formatDate(snapshot.periodEnd)}</span>
		<span>В файле: {pluralize(data.preview.totalRows, ['строка', 'строки', 'строк'])}</span>
	</div>

	<!-- Из чего собрана таблица: съехавшие колонки объясняет прочитанный
		разделитель, а недостающие строки — прочитанный лист. -->
	<p class="text-sm text-muted-foreground" data-slot="file-summary">
		Файл «{data.preview.file.fileName}» прочитан как {describeStatFile(data.preview.file)}.
	</p>

	{#each data.preview.warnings as warning (warning)}
		<InlineHint tone="warning">{warning}</InlineHint>
	{/each}

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
			fields={FIELD_OPTIONS}
			noneValue={STAT_FIELD_NONE}
			previewRows={STAT_PREVIEW_ROWS}
		/>

		<p class="text-sm text-muted-foreground">
			Организацию и программу сопоставить обязательно: без них строку не к чему отнести. Организация
			узнаётся и по названию, и по ИНН. Если колонки периода в файле нет, строки получат период
			снимка. Показано {formatNumber(data.preview.headers.length)} колонок.
		</p>

		<FormActions {submitting} submitLabel="Дальше: проверка строк" />
	</form>
</div>
