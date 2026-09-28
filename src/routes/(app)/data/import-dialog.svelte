<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import CreateDialog from '$lib/components/create-dialog/create-dialog.svelte';
	import FieldDate from '$lib/components/form/field-date.svelte';
	import FieldSelect, { type FieldOption } from '$lib/components/form/field-select.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FileDropzone from '$lib/components/form/file-dropzone.svelte';
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
	import type { PageData } from './$types';

	/**
	 * Окно «Загрузка данных» — первый шаг мастера: файл выгрузки, её источник,
	 * режим и отчётный период. После загрузки сервер уводит на второй шаг —
	 * сопоставление колонок нового снимка.
	 *
	 * Закрывается только крестиком: выбранный файл и набранный период не должны
	 * пропадать от случайного клика мимо окна.
	 */
	let {
		open = $bindable(false),
		importForm
	}: {
		open?: boolean;
		importForm: NonNullable<PageData['importForm']>;
	} = $props();

	type Values = (typeof importForm)['values'];
	type Failure = { message: string; issues: string[]; values: Values };

	const FORM_ID = 'data-import-form';

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

	// Начальные значения — подсказка загрузчика (текущий учебный год); они же
	// возвращаются при закрытии окна.
	const defaults = (): Values => ({ ...importForm.values });

	let values = $state<Values>(untrack(defaults));
	let fileChosen = $state(false);
	let failure = $state<Failure | null>(null);
	let submitting = $state(false);
	// Выбор файла живёт в самом `<input type="file">`: забыть его можно, только
	// нарисовав поле заново.
	let generation = $state(0);

	/** Есть ли что терять: крестик тогда спросит подтверждение. */
	const dirty = $derived(
		fileChosen ||
			(Object.keys(values) as (keyof Values)[]).some(
				(key) => values[key] !== importForm.values[key]
			)
	);

	/** Закрытое окно забывает набранное: следующее открытие — новая загрузка. */
	function clear() {
		values = defaults();
		fileChosen = false;
		failure = null;
		generation += 1;
	}
</script>

<CreateDialog
	bind:open
	title="Загрузка данных"
	description="Шаг 1 из 3: файл выгрузки, её источник, режим и отчётный период."
	formId={FORM_ID}
	submitLabel="Дальше: сопоставление колонок"
	{submitting}
	{dirty}
	width="wide"
	onclose={clear}
>
	{#key generation}
		<form
			id={FORM_ID}
			method="POST"
			action="?/importFile"
			enctype="multipart/form-data"
			class="flex flex-col gap-4"
			novalidate
			use:enhance={() => {
				submitting = true;

				return async ({ result, update }) => {
					submitting = false;

					// Отказ показывается в окне, а не на странице под ним: ввод и
					// выбранный файл остаются на месте, исправить можно сразу.
					if (result.type === 'failure') {
						failure = (result.data as Failure | undefined) ?? null;
						return;
					}

					failure = null;
					await update();
				};
			}}
		>
			<WizardSteps current={1} />

			{#if failure !== null}
				<Alert.Root variant="destructive">
					<TriangleAlertIcon aria-hidden="true" />
					<Alert.Title>{failure.message}</Alert.Title>
					{#if failure.issues.length > 0}
						<Alert.Description>
							<ul class="list-inside list-disc">
								{#each failure.issues as issue (issue)}
									<li>{issue}</li>
								{/each}
							</ul>
						</Alert.Description>
					{/if}
				</Alert.Root>
			{/if}

			<FileDropzone
				id="data-import-file"
				name="file"
				label="Файл выгрузки"
				description="{STAT_FILE_FORMATS_HINT} — до 25 МиБ. В таблице первая строка — названия колонок; в JSON — массив записей или объект со списком строк."
				accept=".xls,.xlsx,.csv,.json,text/csv,application/json,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
				required
				onchoose={(names) => (fileChosen = names.length > 0)}
			/>

			<div class="grid gap-4 sm:grid-cols-2">
				<FieldSelect
					name="source"
					label="Источник"
					options={SOURCE_OPTIONS}
					bind:value={values.source}
					required
				/>
				<FieldSelect
					name="mode"
					label="Режим"
					options={MODE_OPTIONS}
					description={STAT_SNAPSHOT_MODE_HINTS[values.mode as StatSnapshotMode]}
					bind:value={values.mode}
					required
				/>
			</div>

			<div class="grid gap-4 sm:grid-cols-3">
				<FieldSelect
					name="periodKind"
					label="Вид периода"
					options={PERIOD_KIND_OPTIONS}
					bind:value={values.periodKind}
					required
				/>
				<FieldDate
					name="periodStart"
					label="Период с"
					max={values.periodEnd}
					bind:value={values.periodStart}
					required
				/>
				<FieldDate
					name="periodEnd"
					label="по"
					min={values.periodStart}
					bind:value={values.periodEnd}
					required
				/>
			</div>

			<FieldTextarea
				name="note"
				label="Примечание"
				description="Останется в карточке снимка: откуда файл, кто его прислал, что в нём особенного."
				bind:value={values.note}
			/>

			<p class="text-sm text-muted-foreground">
				Файл сохраняется как есть и остаётся неизменяемым: по нему всегда видно, из чего получились
				показатели. Отменить загрузку можно на третьем шаге — снимок будет отклонён с объяснением.
			</p>
		</form>
	{/key}
</CreateDialog>
