<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as RadioGroup from '$lib/components/ui/radio-group/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FileInput from '$lib/components/form/file-input.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import WizardSteps from '$lib/components/stats/wizard-steps.svelte';
	import {
		CATALOG_FILE_FORMATS_HINT,
		CATALOG_IMPORT_STATUS_LABELS,
		CATALOG_WIZARD_STEPS,
		DIRECTORY_IMPORT_KINDS,
		DIRECTORY_IMPORT_KIND_HINTS,
		DIRECTORY_IMPORT_KIND_LABELS
	} from '$lib/contracts/directory-import';
	import { formatDateTime, formatNumber } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Отказ возвращает то, что человек уже ввёл: набирать примечание заново
	// из-за неподходящего файла — это наказание за попытку.
	const initial = untrack(() => form?.values ?? { note: '', kind: 'catalog' });

	let note = $state(initial.note);
	let kind = $state(initial.kind === '' ? 'catalog' : initial.kind);
	let submitting = $state(false);

	/** Незавершённую загрузку можно открыть и довести: у шага есть свой адрес. */
	const stepHref = (record: { id: string; status: string }): ResolvedPathname =>
		record.status === 'uploading'
			? resolve('/(app)/organizations/import/[id=uuid]/mapping', { id: record.id })
			: record.status === 'mapped'
				? resolve('/(app)/organizations/import/[id=uuid]/check', { id: record.id })
				: resolve('/(app)/organizations/import/[id=uuid]', { id: record.id });
</script>

<svelte:head><title>Импорт каталога — Альма CRM</title></svelte:head>

<Header
	title="Импорт каталога"
	description="Шаг 1 из 3: что описывает файл и сам файл — каталог вузов или вендоров с контактами по продуктам."
/>

<Breadcrumbs
	items={[
		{ label: 'Организации', href: resolve('/(app)/organizations') },
		{ label: 'Импорт каталога' }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<WizardSteps current={1} steps={CATALOG_WIZARD_STEPS} />

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
		data-tour="organizations-import-form"
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
		<fieldset class="flex flex-col gap-2" data-tour="organizations-import-kind">
			<legend class="mb-2 text-sm font-medium">Что описывает файл</legend>
			<RadioGroup.Root name="kind" bind:value={kind}>
				{#each DIRECTORY_IMPORT_KINDS as option (option)}
					<div class="flex items-start gap-3">
						<RadioGroup.Item value={option} id="kind-{option}" class="mt-0.5" />
						<div class="flex flex-col gap-0.5">
							<Label for="kind-{option}">{DIRECTORY_IMPORT_KIND_LABELS[option]}</Label>
							<p class="text-xs text-muted-foreground">{DIRECTORY_IMPORT_KIND_HINTS[option]}</p>
						</div>
					</div>
				{/each}
			</RadioGroup.Root>
		</fieldset>

		<FileInput
			id="file"
			label="Файл"
			description="{CATALOG_FILE_FORMATS_HINT} — до 25 МиБ. В таблице первая строка — названия колонок; в JSON — массив записей или объект со списком строк."
			accept=".xls,.xlsx,.csv,.json,text/csv,application/json,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
			required
		/>

		<FieldTextarea
			name="note"
			label="Примечание"
			description="Останется в карточке загрузки: откуда файл, за какой период, что в нём особенного."
			bind:value={note}
		/>

		<FormActions {submitting} submitLabel="Дальше: сопоставление колонок" />
	</form>

	<p class="max-w-3xl text-sm text-muted-foreground">
		Каталог заводит недостающие организации, продукты и направления и ведёт договоры, лицензии и
		статусы передачи. Файл вендоров заводит компании-правообладатели и их продукты, а людей из файла
		— контактами вендора по этим продуктам. Уже заведённые вузы, компании и продукты импорт не
		переписывает, а пустая ячейка ничего не стирает — поэтому повторная загрузка того же файла
		отвечает «без изменений». Ничего не записывается, пока вы не подтвердите предпросмотр на третьем
		шаге.
	</p>

	{#if data.imports.length > 0}
		<section class="flex flex-col gap-2" data-tour="organizations-import-history">
			<h2 class="section-title">Последние загрузки</h2>
			<div class="overflow-x-auto rounded-lg border border-border bg-surface">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Файл</Table.Head>
							<Table.Head>Вид</Table.Head>
							<Table.Head>Состояние</Table.Head>
							<Table.Head class="text-right">Строк</Table.Head>
							<Table.Head class="text-right">С ошибками</Table.Head>
							<Table.Head>Кто и когда</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.imports as record (record.id)}
							<Table.Row data-import-id={record.id}>
								<Table.Cell class="max-w-64 truncate font-medium">
									<a class="underline-offset-2 hover:underline" href={stepHref(record)}>
										{record.fileName ?? 'Файл каталога'}
									</a>
								</Table.Cell>
								<Table.Cell class="text-muted-foreground">
									{DIRECTORY_IMPORT_KIND_LABELS[record.kind]}
								</Table.Cell>
								<Table.Cell>
									<StatusBadge
										tone={record.status === 'confirmed'
											? 'success'
											: record.status === 'rejected'
												? 'danger'
												: 'neutral'}
									>
										{CATALOG_IMPORT_STATUS_LABELS[record.status]}
									</StatusBadge>
								</Table.Cell>
								<Table.Cell class="text-right">{formatNumber(record.rowCount)}</Table.Cell>
								<Table.Cell class="text-right">{formatNumber(record.errorCount)}</Table.Cell>
								<Table.Cell class="whitespace-nowrap text-muted-foreground">
									{record.authorName ?? '—'} · {formatDateTime(record.createdAt)}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		</section>
	{/if}
</div>
