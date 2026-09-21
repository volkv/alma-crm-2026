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
		CATALOG_FIELDS,
		CATALOG_FIELD_HINTS,
		CATALOG_FIELD_LABELS,
		CATALOG_FIELD_NONE,
		CATALOG_PREVIEW_ROWS,
		CATALOG_WIZARD_STEPS
	} from '$lib/contracts/directory-import';
	import { describeStatFile } from '$lib/contracts/stats';
	import { formatNumber, pluralize } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let submitting = $state(false);

	/**
	 * Поля строки каталога для общей таблицы сопоставления. Вместе с допущением:
	 * колонка ложится на поле не буквально, и «срок — это 31 декабря названного
	 * года» человек обязан прочитать здесь, а не узнать из предпросмотра.
	 */
	const FIELD_OPTIONS = CATALOG_FIELDS.map((field) => ({
		value: field,
		label: CATALOG_FIELD_LABELS[field],
		hint: CATALOG_FIELD_HINTS[field]
	}));

	/**
	 * Предложение по колонке в том виде, в каком его показывает таблица: пары
	 * «колонка → поле» превращаются в список, чтобы значок «Предложено» стоял и у
	 * колонок, которым предложить нечего.
	 */
	const advice = $derived(
		data.preview.headers.map((column) => ({
			column,
			field: data.preview.advice[column] ?? null
		}))
	);
</script>

<svelte:head><title>Сопоставление колонок каталога — LCT CRM</title></svelte:head>

<Header
	title="Сопоставление колонок"
	description="Шаг 2 из 3: какая колонка файла что означает. Предложение помечено значком — меняйте его там, где система ошиблась."
/>

<Breadcrumbs
	items={[
		{ label: 'Организации', href: resolve('/(app)/organizations') },
		{ label: 'Импорт каталога', href: resolve('/(app)/organizations/import') },
		{ label: 'Сопоставление колонок' }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<WizardSteps current={2} steps={CATALOG_WIZARD_STEPS} />

	<div class="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
		<span>В файле: {pluralize(data.preview.totalRows, ['строка', 'строки', 'строк'])}</span>
		<span>Колонок: {formatNumber(data.preview.headers.length)}</span>
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
			{advice}
			mapping={data.preview.mapping}
			sample={data.preview.sample}
			fields={FIELD_OPTIONS}
			noneValue={CATALOG_FIELD_NONE}
			previewRows={CATALOG_PREVIEW_ROWS}
		/>

		<p class="text-sm text-muted-foreground">
			Учебное заведение и продукт сопоставить обязательно: без них строку не к чему отнести. Что
			означает каждое поле, написано под выбранным значением. Три колонки рабочей таблицы ложатся не
			на справочник, а на записи вокруг него: менеджер — на ответственного за вуз, контакты — на
			людей вуза с основанием обработки, комментарий — на примечание карточки.
		</p>

		<FormActions {submitting} submitLabel="Дальше: предпросмотр" />
	</form>
</div>
