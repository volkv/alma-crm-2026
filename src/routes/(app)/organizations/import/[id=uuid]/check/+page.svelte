<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import CheckIcon from '@lucide/svelte/icons/check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import XIcon from '@lucide/svelte/icons/x';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { filterHref } from '$lib/components/directory/query';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import WizardSteps from '$lib/components/stats/wizard-steps.svelte';
	import {
		CATALOG_ROW_ACTIONS,
		CATALOG_ROW_ACTION_LABELS,
		CATALOG_WIZARD_STEPS,
		DIRECTORY_IMPORT_KIND_SUBJECTS,
		type CatalogRowAction
	} from '$lib/contracts/directory-import';
	import { formatNumber, pluralize } from '$lib/format';
	import RowsTable from '../../rows-table.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const subject = $derived(DIRECTORY_IMPORT_KIND_SUBJECTS[data.record.kind]);
	const title = $derived(`Предпросмотр импорта ${subject}`);

	let submitting = $state(false);

	const applicable = $derived(data.record.createCount + data.record.updateCount);

	const COUNT_OF: Record<CatalogRowAction, (record: typeof data.record) => number> = {
		create: (record) => record.createCount,
		update: (record) => record.updateCount,
		unchanged: (record) => record.unchangedCount,
		error: (record) => record.errorCount
	};

	/** Ссылка на тот же экран с другим фильтром: список — это адрес. */
	const actionHref = (action: CatalogRowAction | null) =>
		filterHref(page.url, 'action', action ?? '');

	function submit() {
		submitting = true;

		return async ({ update }: { update: () => Promise<void> }) => {
			submitting = false;
			await update();
		};
	}
</script>

<svelte:head>
	<title>{title} — Альма CRM</title>
</svelte:head>

<Header
	{title}
	description="Шаг 3 из 3: что импорт сделает с каждой строкой. Пока вы не подтвердили, в справочнике ничего не изменилось."
/>

<Breadcrumbs
	items={[
		{ label: 'Организации', href: resolve('/(app)/organizations') },
		{ label: `Импорт ${subject}`, href: resolve('/(app)/organizations/import') },
		{ label: title }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<WizardSteps current={3} steps={CATALOG_WIZARD_STEPS} />

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

	<div class="grid gap-3 sm:grid-cols-5" data-tour="organizations-import-check-counts">
		<div class="rounded-lg border border-border bg-surface p-4">
			<p class="text-xs text-muted-foreground">Строк в файле</p>
			<p class="text-xl font-semibold" data-slot="count-rows">
				{formatNumber(data.record.rowCount)}
			</p>
		</div>
		{#each CATALOG_ROW_ACTIONS as action (action)}
			<div class="rounded-lg border border-border bg-surface p-4">
				<p class="text-xs text-muted-foreground">{CATALOG_ROW_ACTION_LABELS[action]}</p>
				<p
					class="text-xl font-semibold {action === 'error' && data.record.errorCount > 0
						? 'text-danger'
						: ''}"
					data-slot="count-{action}"
				>
					{formatNumber(COUNT_OF[action](data.record))}
				</p>
			</div>
		{/each}
	</div>

	<div class="flex flex-wrap items-center gap-2">
		<Button
			variant={data.action === null ? 'secondary' : 'outline'}
			size="sm"
			href={actionHref(null)}
		>
			Все строки
		</Button>
		{#each CATALOG_ROW_ACTIONS as action (action)}
			<Button
				variant={data.action === action ? 'secondary' : 'outline'}
				size="sm"
				href={actionHref(action)}
			>
				{CATALOG_ROW_ACTION_LABELS[action]}
			</Button>
		{/each}
		<span class="text-sm text-muted-foreground">
			Показано {pluralize(data.shown, ['строка', 'строки', 'строк'])} из {formatNumber(data.total)}
		</span>
	</div>

	<RowsTable
		rows={data.rows}
		kind={data.record.kind}
		status={data.record.status}
		emptyTitle="Строк нет"
		emptyDescription={data.action === null
			? 'В файле не нашлось ни одной строки данных.'
			: 'Под этот фильтр не подошла ни одна строка.'}
	/>

	<div class="grid gap-4 lg:grid-cols-2" data-tour="organizations-import-check-decide">
		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Применить</Card.Title>
				<Card.Description>
					В справочник уйдут только строки без ошибок — {pluralize(applicable, [
						'строка',
						'строки',
						'строк'
					])}. Строки «без изменений» ничего не записывают, строки с ошибками остаются в загрузке
					вместе с объяснением.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form method="POST" action="?/confirm" use:enhance={submit}>
					<Button type="submit" disabled={submitting}>
						<CheckIcon aria-hidden="true" />
						Применить импорт
					</Button>
					{#if applicable === 0 && data.record.unchangedCount === 0 && data.record.errorCount > 0}
						<p class="mt-2 text-xs text-muted-foreground">
							Все строки с ошибками — применить нечего. Исправьте файл и загрузите его заново или
							отклоните эту загрузку.
						</p>
					{:else if applicable === 0 && data.record.errorCount > 0}
						<p class="mt-2 text-xs text-muted-foreground">
							Менять нечего: строки без ошибок справочник уже описывает, а строки с ошибками не
							применятся. Применение запишет это и закроет загрузку.
						</p>
					{:else if applicable === 0}
						<p class="mt-2 text-xs text-muted-foreground">
							Менять нечего: справочник уже описан этим файлом. Применение запишет это и закроет
							загрузку.
						</p>
					{/if}
				</form>
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Отклонить</Card.Title>
				<Card.Description>
					Загрузка останется в системе вместе со строками и предпросмотром — по ней будет видно, что
					именно не приняли.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form method="POST" action="?/reject" class="flex flex-col gap-form" use:enhance={submit}>
					<div class="flex flex-col gap-field">
						<Label for="reason">Причина</Label>
						<Textarea id="reason" name="reason" rows={2} placeholder="Что не так с файлом" />
					</div>
					<div>
						<Button type="submit" variant="outline" disabled={submitting}>
							<XIcon aria-hidden="true" />
							Отклонить загрузку
						</Button>
					</div>
				</form>
			</Card.Content>
		</Card.Root>
	</div>
</div>
