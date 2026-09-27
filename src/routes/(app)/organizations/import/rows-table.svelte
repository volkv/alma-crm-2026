<script lang="ts">
	import * as Table from '$lib/components/ui/table/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { StatusTone } from '$lib/components/status-badge.svelte';
	import {
		CATALOG_ROW_ACTION_DONE_LABELS,
		CATALOG_ROW_ACTION_LABELS,
		CATALOG_TARGET_LABELS,
		type CatalogImportRowView,
		type CatalogImportStatus,
		type CatalogRowAction,
		type DirectoryImportKind
	} from '$lib/contracts/directory-import';
	import { formatDate } from '$lib/format';

	/** Календарный день так, как его разбирает импорт. */
	const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

	/**
	 * Строки каталога вместе с тем, что импорт с ними сделает или сделал.
	 *
	 * Действие стоит в той же строке, что и данные, и рядом с ним — «что именно»:
	 * «Обновить» без названия поля и прежнего значения подтверждать нельзя, а
	 * список изменений отдельно от строк заставил бы сверять номера руками.
	 *
	 * Колонки данных — по виду загрузки: у каталога это вуз, продукт, договор и
	 * лицензия, у вендоров — компания, продукты и контакт. Контакт (ФИО и способ
	 * связи) взят из строки файла и приходит по тому же правилу, что сама строка
	 * файла: автору загрузки и полному доступу. Остальным колонки контакта нет —
	 * что с ним будет или стало, говорит колонка действия.
	 */
	let {
		rows,
		kind,
		status,
		emptyTitle = 'Строк нет',
		emptyDescription
	}: {
		rows: readonly CatalogImportRowView[];
		kind: DirectoryImportKind;
		/** Статус загрузки: применённая называет действия в прошедшем времени. */
		status: CatalogImportStatus;
		emptyTitle?: string;
		emptyDescription?: string;
	} = $props();

	const TONES: Record<CatalogRowAction, StatusTone> = {
		create: 'success',
		update: 'accent',
		unchanged: 'neutral',
		error: 'danger'
	};

	const done = $derived(status === 'confirmed');

	// Отклонённая загрузка ничего не сделала: колонка показывает, что она предлагала.
	const actionHead = $derived(
		done ? 'Что сделано' : status === 'rejected' ? 'Что предлагалось' : 'Что будет'
	);

	const label = (action: CatalogRowAction): string =>
		(done ? CATALOG_ROW_ACTION_DONE_LABELS : CATALOG_ROW_ACTION_LABELS)[action];

	const dash = (value: string | null): string => value ?? '—';

	/**
	 * Значение строки так, как его читает человек: календарный день из файла
	 * разобран в `ГГГГ-ММ-ДД`, а показывается `ДД.ММ.ГГГГ`, как во всём продукте.
	 */
	const shown = (value: string | null): string =>
		value !== null && ISO_DAY.test(value) ? formatDate(value) : dash(value);

	const showContact = $derived(
		kind === 'vendors' && rows.some((row) => row.vendorContact !== null)
	);
</script>

{#if rows.length === 0}
	<div class="rounded-lg border border-border bg-surface">
		<EmptyState title={emptyTitle} description={emptyDescription} />
	</div>
{:else}
	<div class="overflow-x-auto rounded-lg border border-border bg-surface">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-12 text-right">№</Table.Head>
					{#if kind === 'catalog'}
						<Table.Head>Учебное заведение</Table.Head>
						<Table.Head>Продукт</Table.Head>
						<Table.Head>Договор</Table.Head>
						<Table.Head>Лицензия</Table.Head>
						<Table.Head>Статус передачи</Table.Head>
					{:else}
						<Table.Head>Компания</Table.Head>
						<Table.Head>Продукты</Table.Head>
						{#if showContact}
							<Table.Head>Контакт</Table.Head>
						{/if}
					{/if}
					<Table.Head>{actionHead}</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each rows as row (row.id)}
					<Table.Row data-row-no={row.rowNo} data-action={row.action}>
						<Table.Cell class="text-right text-muted-foreground">{row.rowNo}</Table.Cell>
						<Table.Cell>
							{dash(row.organizationName)}
							{#if row.organizationInn !== null}
								<span class="block text-xs text-muted-foreground">ИНН {row.organizationInn}</span>
							{/if}
						</Table.Cell>
						<Table.Cell class="max-w-64 truncate" title={row.productName ?? undefined}>
							{dash(row.productName)}
						</Table.Cell>
						{#if kind === 'catalog'}
							<Table.Cell class="whitespace-nowrap">{dash(row.contractNumber)}</Table.Cell>
							<Table.Cell class="whitespace-nowrap">{shown(row.licenseUntil)}</Table.Cell>
							<Table.Cell>{dash(row.transferStatus)}</Table.Cell>
						{:else if showContact}
							<Table.Cell>
								{dash(row.vendorContact?.name ?? null)}
								{#if row.vendorContact?.channel}
									<span class="block text-xs text-muted-foreground">
										{row.vendorContact.channel}
									</span>
								{/if}
							</Table.Cell>
						{/if}
						<Table.Cell>
							<div class="flex flex-col gap-1">
								<StatusBadge tone={TONES[row.action]} dot={row.action !== 'error'}>
									{label(row.action)}
								</StatusBadge>
								{#if row.issues.length > 0}
									<ul class="flex flex-col gap-1">
										{#each row.issues as issue (issue.message)}
											<li class="text-xs text-danger-soft-foreground">{issue.message}</li>
										{/each}
									</ul>
								{/if}
								{#if row.creations.length > 0}
									<ul class="flex flex-col gap-0.5">
										{#each row.creations as creation (creation.target + creation.subject)}
											<li class="text-xs text-muted-foreground">
												{CATALOG_TARGET_LABELS[creation.target]}: {creation.subject}
											</li>
										{/each}
									</ul>
								{/if}
								{#if row.changes.length > 0}
									<ul class="flex flex-col gap-0.5">
										{#each row.changes as change (change.target + change.subject + change.field)}
											<li class="text-xs text-muted-foreground">
												{change.subject} · {change.field}: {shown(change.from)} → {shown(change.to)}
											</li>
										{/each}
									</ul>
								{/if}
							</div>
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
{/if}
