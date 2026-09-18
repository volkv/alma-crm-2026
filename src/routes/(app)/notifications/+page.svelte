<script lang="ts">
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import { formatNumber } from '$lib/format';
	import {
		NOTIFICATION_CHANNELS,
		NOTIFICATION_CHANNEL_LABELS,
		isStubChannel
	} from '$lib/contracts/notifications';
	import DeliveryRow from './delivery-row.svelte';
	import FilterBar from './filter-bar.svelte';
	import type { PageProps } from './$types';

	/**
	 * Уведомления: что система сказала руководителям и дошло ли это.
	 *
	 * Правило и каналы названы прямо над таблицей, а не спрятаны в справку:
	 * строку «заглушка» читать бессмысленно, не зная, что канал заглушкой и
	 * заведён.
	 */
	let { data, form }: PageProps = $props();

	const pages = $derived(Math.max(1, Math.ceil(data.deliveries.total / data.deliveries.pageSize)));

	const enabled = $derived(NOTIFICATION_CHANNELS.filter((channel) => data.channels[channel]));
	const stubbed = $derived(enabled.filter((channel) => isStubChannel(channel)));

	/**
	 * Ссылка на соседнюю страницу с тем же фильтром: выборку из журнала кладут в
	 * задачу, и номер страницы обязан жить в адресе рядом с фильтром.
	 */
	function pageHref(page: number): string {
		const pairs: string[] = [];

		for (const [name, value] of Object.entries(data.filter)) {
			if (value !== null && name !== 'page' && name !== 'pageSize') {
				pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
			}
		}

		pairs.push(`page=${page}`);

		return `?${pairs.join('&')}`;
	}
</script>

<svelte:head>
	<title>Уведомления — LCT CRM</title>
</svelte:head>

<PageHeader
	title="Уведомления"
	description="Напоминания о взаимодействиях, которые стоят на одной стадии дольше порога: кому ушли, каким каналом и дошли ли"
/>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	{#if form}
		<Alert.Root variant={form.ok ? 'default' : 'destructive'}>
			<Alert.Description>
				{form.message}
				{#if form.issues.length > 0}
					<ul class="list-inside list-disc">
						{#each form.issues as issue (issue)}
							<li>{issue}</li>
						{/each}
					</ul>
				{/if}
			</Alert.Description>
		</Alert.Root>
	{/if}

	<Alert.Root>
		<Alert.Title>Как это работает</Alert.Title>
		<Alert.Description>
			<p>
				Система напоминает руководителю ответственного, когда взаимодействие стоит на одной стадии
				дольше
				{data.thresholdDays === 0 ? 'нуля дней (сразу)' : `${data.thresholdDays} дн.`}; время пауз в
				этот срок не входит. Порог и каналы меняются в общих настройках.
			</p>
			<p>
				Включённые каналы: {enabled.length === 0
					? 'ни одного — напоминания не уходят'
					: enabled.map((channel) => NOTIFICATION_CHANNEL_LABELS[channel]).join(', ')}.
			</p>
			{#if stubbed.length > 0}
				<p>
					{stubbed.map((channel) => NOTIFICATION_CHANNEL_LABELS[channel]).join(' и ')} — заглушка: строка
					в журнале появляется, реальная отправка не выполняется.
				</p>
			{/if}
		</Alert.Description>
	</Alert.Root>

	<FilterBar />

	{#if data.deliveries.items.length === 0}
		<EmptyState
			title="Доставок нет"
			description="Либо ни одно взаимодействие ещё не простояло дольше порога, либо под этот фильтр ничего не попало."
		/>
	{:else}
		<div class="overflow-x-auto rounded-lg border border-border bg-surface">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Когда</Table.Head>
						<Table.Head>Повод</Table.Head>
						<Table.Head>Взаимодействие</Table.Head>
						<Table.Head>Получатель</Table.Head>
						<Table.Head>Канал</Table.Head>
						<Table.Head>Состояние</Table.Head>
						<Table.Head>Попытки</Table.Head>
						<Table.Head>Подробности</Table.Head>
						<Table.Head>Действия</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.deliveries.items as delivery (delivery.id)}
						<DeliveryRow {delivery} canManage={data.canManage} />
					{/each}
				</Table.Body>
			</Table.Root>
		</div>

		<div class="flex items-center justify-between text-sm text-muted-foreground">
			<span>Всего доставок: {formatNumber(data.deliveries.total)}</span>
			{#if pages > 1}
				<div class="flex items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						href={pageHref(data.filter.page - 1)}
						disabled={data.filter.page <= 1}
					>
						Назад
					</Button>
					<span>{data.filter.page} из {pages}</span>
					<Button
						variant="outline"
						size="sm"
						href={pageHref(data.filter.page + 1)}
						disabled={data.filter.page >= pages}
					>
						Вперёд
					</Button>
				</div>
			{/if}
		</div>
	{/if}
</div>
