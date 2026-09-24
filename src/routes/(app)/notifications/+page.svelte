<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import Header from '$lib/components/header.svelte';
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
	<title>Уведомления — Альма CRM</title>
</svelte:head>

<Header
	title="Уведомления"
	description="Напоминания о зависших взаимодействиях и о сроках лицензий и утренние сводки: кому ушли, каким каналом и дошли ли"
/>

<!-- Крошка «Настройки» без ссылки — та же, что у остальных страниц этой группы
	меню: журнал доставок стоит среди настроек, и путь к нему обязан читаться
	так же, как путь к ним. -->
<Breadcrumbs
	items={[
		{ label: 'Главное', href: resolve('/') },
		{ label: 'Настройки' },
		{ label: 'Уведомления' }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
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

	<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
	<Alert.Root data-tour="notifications-log">
		<Alert.Title>Как это работает</Alert.Title>
		<Alert.Description>
			<p>
				Система напоминает руководителю ответственного, когда взаимодействие стоит на одной стадии
				дольше
				{data.thresholdDays === 0 ? 'нуля дней (сразу)' : `${data.thresholdDays} дн.`}; время пауз в
				этот срок не входит.
			</p>
			<p>
				О лицензии по позиции договора система говорит ответственному за организацию один раз на
				срок, когда до конца остаётся {data.licenseWarningDays} дн. или меньше; если срок прошёл, руководителю
				ответственного уходит эскалация. Ссылка ведёт на карточку организации, где у позиции стоит кнопка
				«Запустить продление». Пороги и каналы меняются в общих настройках.
			</p>
			<p>
				{#if data.digest.enabled}
					Утренняя сводка «Мой день» уходит раз в сутки, в {String(data.digest.hour).padStart(
						2,
						'0'
					)}:00 по Москве или первым проходом после, каждому сотруднику, у которого на сегодня есть
					дела: одна на человека, день и канал.
				{:else}
					Утренняя сводка «Мой день» выключена в общих настройках.
				{/if}
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
			description="Либо ни одно взаимодействие не простояло дольше порога, ни одна лицензия не подошла к концу срока и утренних сводок ещё не было, либо под этот фильтр ничего не попало."
		/>
	{:else}
		<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
		<div
			data-tour="notifications-deliveries"
			class="overflow-x-auto rounded-lg border border-border bg-surface"
		>
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Когда</Table.Head>
						<Table.Head>Повод</Table.Head>
						<Table.Head>Предмет</Table.Head>
						<Table.Head>Получатель</Table.Head>
						<Table.Head>Канал</Table.Head>
						<Table.Head>Состояние</Table.Head>
						<!-- Попытки и подробности уезжают в строку под состоянием, пока окно
							уже 1536: «повод — получатель — канал — состояние» обязаны
							помещаться на экране в 1280 точек целиком. -->
						<Table.Head class="hidden 2xl:table-cell">Попытки</Table.Head>
						<Table.Head class="hidden 2xl:table-cell">Подробности</Table.Head>
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
