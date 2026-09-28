<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { applyAction, enhance } from '$app/forms';
	import { asset, resolve } from '$app/paths';
	import { invalidateAll } from '$app/navigation';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import FileDropzone from '$lib/components/form/file-dropzone.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge, { type StatusTone } from '$lib/components/status-badge.svelte';
	import { describeActionFailure } from '$lib/components/interactions/action-enhance';
	import {
		PAYMENT_ROW_ACTION_LABELS,
		PAYMENT_ROW_ACTIONS,
		PAYMENT_ROW_RESULT_LABELS,
		PAYMENTS_ASSUMPTION,
		PAYMENTS_FILE_FORMATS_HINT,
		type PaymentRowAction,
		type PaymentsView
	} from '$lib/contracts/payments';

	/**
	 * Загрузка оплат с сайта: файл выгрузки → предпросмотр по записям →
	 * загрузка.
	 *
	 * Предпросмотр и загрузка зовут один и тот же разбор и одну и ту же сверку:
	 * «создать / обновить / без изменений / ошибка» на экране — не прогноз по
	 * другим правилам, а тот же расчёт. Файл присылается дважды: сервер между
	 * нажатиями ничего не хранит, и загружается ровно то, что проверили.
	 */
	let open = $state(false);
	let payments = $state<PaymentsView | null>(null);
	let refusal = $state<{ message: string; description?: string } | null>(null);

	const ROW_TONES: Record<PaymentRowAction, StatusTone> = {
		create: 'accent',
		update: 'info',
		unchanged: 'neutral',
		error: 'danger'
	};

	/** Подписи итогов: до загрузки — что станет с записью, после — что стало. */
	const labels = $derived(
		payments?.applied === true ? PAYMENT_ROW_RESULT_LABELS : PAYMENT_ROW_ACTION_LABELS
	);

	/** Сколько записей уйдёт в загрузку: новые и обновления. */
	const loadable = $derived(
		payments === null ? 0 : payments.counts.create + payments.counts.update
	);

	const submit: SubmitFunction = () => {
		refusal = null;

		return async ({ result }) => {
			if (result.type === 'failure') {
				refusal = describeActionFailure(result.data);

				return;
			}

			if (result.type === 'success') {
				payments = (result.data?.payments as PaymentsView | undefined) ?? null;

				// После загрузки журнал ниже пополнился строками оплат — страница
				// перечитывается, а итог остаётся в диалоге.
				if (payments?.applied === true) {
					await invalidateAll();
				}

				return;
			}

			await applyAction(result);
		};
	};
</script>

<div class="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-4">
	<Button
		type="button"
		variant="outline"
		data-tour="exchange-payments"
		onclick={() => {
			payments = null;
			refusal = null;
			open = true;
		}}
	>
		Загрузить оплаты с сайта
	</Button>
	<span class="text-sm text-muted-foreground">
		Выгрузка оплаченных заказов сайта файлом: каждая запись отмечает оплату в деле по номеру заявки.
	</span>
</div>

<FormDialog
	bind:open
	width="xl"
	title="Загрузить оплаты с сайта"
	description="Файл выгрузки сайта → проверка записей → загрузка. Стадии дел загрузка не меняет."
>
	<div class="flex flex-col gap-form">
		<InlineHint tone="info">{PAYMENTS_ASSUMPTION}</InlineHint>

		<!-- Образцы выгрузки: те же колонки, что ждёт разбор, и курсы из
			справочника стенда — файл проходит проверку как есть. -->
		<p class="text-sm text-muted-foreground">
			Образец файла:
			<a
				class="text-link underline-offset-4 hover:underline"
				href={asset('/samples/payments.json')}
				download>JSON</a
			>
			·
			<a
				class="text-link underline-offset-4 hover:underline"
				href={asset('/samples/payments.csv')}
				download>таблица CSV</a
			>
		</p>

		{#if refusal !== null}
			<Alert.Root variant="destructive">
				<TriangleAlertIcon aria-hidden="true" />
				<Alert.Title>{refusal.message}</Alert.Title>
				{#if refusal.description}
					<Alert.Description>{refusal.description}</Alert.Description>
				{/if}
			</Alert.Root>
		{/if}

		<form
			id="exchange-payments-form"
			method="POST"
			action="?/paymentsPreview"
			enctype="multipart/form-data"
			use:enhance={submit}
			class="flex flex-col gap-form"
		>
			<FileDropzone
				id="exchange-payments-file"
				name="file"
				label="Файл выгрузки"
				description="{PAYMENTS_FILE_FORMATS_HINT}. У таблицы первая строка — названия колонок."
				accept=".json,application/json,.xls,.xlsx,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
				required
				onchoose={() => {
					payments = null;
					refusal = null;
				}}
			/>
			<div class="flex flex-wrap gap-2">
				<Button type="submit" variant="outline">Проверить файл</Button>
				{#if payments !== null && !payments.applied && loadable > 0}
					<Button type="submit" formaction="?/paymentsImport">
						Загрузить записей: {loadable}
					</Button>
				{/if}
			</div>
		</form>

		{#if payments !== null}
			<section class="flex flex-col gap-2" aria-labelledby="exchange-payments-result-title">
				<h3 id="exchange-payments-result-title" class="text-sm font-medium">
					{payments.applied ? 'Чем кончилась загрузка' : 'Что станет с записями файла'}
				</h3>
				{#each payments.fileIssues as issue (issue)}
					<InlineHint tone="warning">{issue}</InlineHint>
				{/each}
				<p class="text-xs text-muted-foreground">
					{PAYMENT_ROW_ACTIONS.map(
						(action) => `${labels[action]}: ${payments?.counts[action] ?? 0}`
					).join(' · ')}
				</p>
				{#if payments.rows.length > 0}
					<ul class="flex max-h-96 flex-col divide-y overflow-y-auto rounded-md border">
						{#each payments.rows as row (row.place)}
							<li class="flex flex-col gap-0.5 px-3 py-2 text-sm">
								<div class="flex flex-wrap items-center gap-2">
									<span class="text-xs text-muted-foreground tabular-nums">{row.place}</span>
									<span class="min-w-0 flex-1 break-words">{row.fullName || '—'}</span>
									<StatusBadge tone={ROW_TONES[row.action]}>
										{labels[row.action]}
									</StatusBadge>
								</div>
								{#if row.interactionId !== null}
									<a
										class="text-xs text-link underline-offset-4 hover:underline"
										href={resolve('/(app)/interactions/[id=uuid]', { id: row.interactionId })}
									>
										Открыть дело
									</a>
								{/if}
								{#if row.orderId !== null}
									<span class="text-xs break-all text-muted-foreground">
										{[
											row.orderId,
											row.course,
											row.streamNumber === null ? null : `поток ${row.streamNumber}`
										]
											.filter((part) => part !== null)
											.join(' · ')}
									</span>
								{/if}
								{#each row.issues as issue (issue)}
									<span class="text-xs text-danger-soft-foreground">{issue}</span>
								{/each}
								{#each row.notes as note (note)}
									<span class="text-xs text-muted-foreground">{note}</span>
								{/each}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	</div>

	{#snippet footer({ close })}
		<div class="flex justify-end">
			<Button type="button" variant="outline" onclick={close}>Закрыть</Button>
		</div>
	{/snippet}
</FormDialog>
