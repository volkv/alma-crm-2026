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
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { filterHref } from '$lib/components/directory/query';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import RowsTable from '$lib/components/stats/rows-table.svelte';
	import WizardSteps from '$lib/components/stats/wizard-steps.svelte';
	import { STAT_SNAPSHOT_MODE_HINTS } from '$lib/contracts/stats';
	import { formatNumber, pluralize } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let submitting = $state(false);

	const valid = $derived(data.snapshot.rowCount - data.snapshot.errorCount);

	/** Ссылка на тот же экран с другим фильтром: список — это адрес. */
	const issuesHref = (onlyIssues: boolean) => filterHref(page.url, 'issues', onlyIssues ? '1' : '');

	function submit() {
		submitting = true;

		return async ({ update }: { update: () => Promise<void> }) => {
			submitting = false;
			await update();
		};
	}
</script>

<svelte:head><title>Проверка загрузки — LCT CRM</title></svelte:head>

<Header
	title="Проверка загрузки"
	description="Шаг 3 из 3: что разобралось, что нет. Подтверждённый снимок попадает в показатели, отклонённый остаётся в системе с объяснением."
/>

<Breadcrumbs
	items={[
		{ label: 'Данные об обучении', href: resolve('/(app)/data') },
		{ label: 'Проверка загрузки' }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<WizardSteps current={3} />

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

	<div class="grid gap-3 sm:grid-cols-3" data-tour="data-check-counts">
		<div class="rounded-lg border border-border bg-surface p-4">
			<p class="text-xs text-muted-foreground">Строк в файле</p>
			<p class="text-xl font-semibold">{formatNumber(data.snapshot.rowCount)}</p>
		</div>
		<div class="rounded-lg border border-border bg-surface p-4">
			<p class="text-xs text-muted-foreground">Разобрано</p>
			<p class="text-xl font-semibold text-success">{formatNumber(valid)}</p>
		</div>
		<div class="rounded-lg border border-border bg-surface p-4">
			<p class="text-xs text-muted-foreground">С ошибками</p>
			<p
				class="text-xl font-semibold {data.snapshot.errorCount > 0
					? 'text-danger'
					: 'text-muted-foreground'}"
			>
				{formatNumber(data.snapshot.errorCount)}
			</p>
		</div>
	</div>

	<div class="flex flex-wrap items-center gap-2">
		<Button variant={data.onlyIssues ? 'outline' : 'secondary'} size="sm" href={issuesHref(false)}>
			Все строки
		</Button>
		<Button variant={data.onlyIssues ? 'secondary' : 'outline'} size="sm" href={issuesHref(true)}>
			Только с ошибками
		</Button>
		<span class="text-sm text-muted-foreground">
			Показано {pluralize(data.shown, ['строка', 'строки', 'строк'])} из {formatNumber(data.total)}
		</span>
	</div>

	<RowsTable
		rows={data.rows}
		emptyTitle={data.onlyIssues ? 'Ошибок нет' : 'Строк нет'}
		emptyDescription={data.onlyIssues
			? 'Все строки файла разобрались — можно подтверждать.'
			: 'В файле не нашлось ни одной строки данных.'}
	/>

	<div class="grid gap-4 lg:grid-cols-2" data-tour="data-check-decide">
		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Подтвердить</Card.Title>
				<Card.Description>
					{STAT_SNAPSHOT_MODE_HINTS[data.snapshot.mode]} В показатели попадут только разобранные строки
					— {pluralize(valid, ['строка', 'строки', 'строк'])}.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form method="POST" action="?/confirm" use:enhance={submit}>
					<Button type="submit" disabled={submitting || valid === 0}>
						<CheckIcon aria-hidden="true" />
						Подтвердить снимок
					</Button>
					{#if valid === 0}
						<p class="mt-2 text-xs text-muted-foreground">
							Подтверждать нечего: ни одна строка не разобралась.
						</p>
					{/if}
				</form>
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Отклонить</Card.Title>
				<Card.Description>
					Снимок останется в системе вместе со строками и ошибками — по нему будет видно, что именно
					не приняли.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form method="POST" action="?/reject" class="flex flex-col gap-2" use:enhance={submit}>
					<Label for="reason">Причина</Label>
					<Textarea id="reason" name="reason" rows={2} placeholder="Что не так с выгрузкой" />
					<div>
						<Button type="submit" variant="outline" disabled={submitting}>
							<XIcon aria-hidden="true" />
							Отклонить снимок
						</Button>
					</div>
				</form>
			</Card.Content>
		</Card.Root>
	</div>
</div>
