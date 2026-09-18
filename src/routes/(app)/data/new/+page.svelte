<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import FieldDate from '$lib/components/form/field-date.svelte';
	import FieldSelect, { type FieldOption } from '$lib/components/form/field-select.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FileInput from '$lib/components/form/file-input.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import WizardSteps from '$lib/components/stats/wizard-steps.svelte';
	import {
		STAT_FILE_FORMATS_HINT,
		STAT_PERIOD_KINDS,
		STAT_PERIOD_KIND_LABELS,
		STAT_SNAPSHOT_MODES,
		STAT_SNAPSHOT_MODE_HINTS,
		STAT_SNAPSHOT_MODE_LABELS,
		STAT_SOURCES,
		STAT_SOURCE_LABELS,
		type StatSnapshotMode
	} from '$lib/contracts/stats';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const SOURCE_OPTIONS: readonly FieldOption[] = STAT_SOURCES.map((source) => ({
		value: source,
		label: STAT_SOURCE_LABELS[source]
	}));

	const MODE_OPTIONS: readonly FieldOption[] = STAT_SNAPSHOT_MODES.map((mode) => ({
		value: mode,
		label: STAT_SNAPSHOT_MODE_LABELS[mode]
	}));

	const PERIOD_KIND_OPTIONS: readonly FieldOption[] = STAT_PERIOD_KINDS.map((kind) => ({
		value: kind,
		label: STAT_PERIOD_KIND_LABELS[kind]
	}));

	// Отказ возвращает то, что человек уже ввёл: заполнять форму заново из-за
	// неверной даты — это наказание за опечатку. До первой отправки значения
	// приходят из загрузчика.
	const initial = untrack(() => form?.values ?? data.values);

	let source = $state(initial.source);
	let mode = $state(initial.mode);
	let periodKind = $state(initial.periodKind);
	let periodStart = $state(initial.periodStart);
	let periodEnd = $state(initial.periodEnd);
	let note = $state(initial.note);
	let submitting = $state(false);
</script>

<svelte:head><title>Загрузка данных — LCT CRM</title></svelte:head>

<PageHeader
	title="Загрузка данных"
	description="Шаг 1 из 3: файл выгрузки, её источник, режим и отчётный период."
	breadcrumbs={[{ label: 'Данные об обучении', href: resolve('/(app)/data') }]}
/>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<WizardSteps current={1} />

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
		enctype="multipart/form-data"
		class="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
		novalidate
		use:enhance={() => {
			submitting = true;

			return async ({ update }) => {
				submitting = false;
				await update();
			};
		}}
	>
		<FileInput
			id="file"
			label="Файл выгрузки"
			description="{STAT_FILE_FORMATS_HINT} — до 25 МиБ. В таблице первая строка — названия колонок; в JSON — массив записей или объект со списком строк."
			accept=".xls,.xlsx,.csv,.json,text/csv,application/json,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
			required
		/>

		<div class="grid gap-4 sm:grid-cols-2">
			<FieldSelect
				name="source"
				label="Источник"
				options={SOURCE_OPTIONS}
				bind:value={source}
				required
			/>
			<FieldSelect
				name="mode"
				label="Режим"
				options={MODE_OPTIONS}
				description={STAT_SNAPSHOT_MODE_HINTS[mode as StatSnapshotMode]}
				bind:value={mode}
				required
			/>
		</div>

		<div class="grid gap-4 sm:grid-cols-3">
			<FieldSelect
				name="periodKind"
				label="Вид периода"
				options={PERIOD_KIND_OPTIONS}
				bind:value={periodKind}
				required
			/>
			<FieldDate
				name="periodStart"
				label="Период с"
				max={periodEnd}
				bind:value={periodStart}
				required
			/>
			<FieldDate name="periodEnd" label="по" min={periodStart} bind:value={periodEnd} required />
		</div>

		<FieldTextarea
			name="note"
			label="Примечание"
			description="Останется в карточке снимка: откуда файл, кто его прислал, что в нём особенного."
			bind:value={note}
		/>

		<FormActions {submitting} submitLabel="Дальше: сопоставление колонок" />
	</form>

	<p class="text-sm text-muted-foreground">
		Файл сохраняется как есть и остаётся неизменяемым: по нему всегда видно, из чего получились
		показатели. Отменить загрузку можно на третьем шаге — снимок будет отклонён с объяснением.
	</p>
</div>
