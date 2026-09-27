<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import FilterBar from '$lib/components/exchange/filter-bar.svelte';
	import MessageRow from '$lib/components/exchange/message-row.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import { formatNumber } from '$lib/format';
	import PaymentsDialog from './payments-dialog.svelte';
	import type { PageProps } from './$types';

	/**
	 * Внешние системы: обе стороны обмена одним списком.
	 *
	 * Одним списком намеренно: вопрос сотрудника звучит «что происходит с этой
	 * заявкой», а не «что происходит с нашими исходящими» — и ответ на него
	 * собирается из входящего сообщения и ушедшего следом статуса.
	 */
	let { data, form }: PageProps = $props();

	const pages = $derived(Math.max(1, Math.ceil(data.messages.total / data.messages.pageSize)));

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
	<title>Внешние системы — Альма CRM</title>
</svelte:head>

<!-- Крошка «Настройки» без ссылки — та же, что у остальных страниц этой группы
	меню: журнал обмена стоит среди настроек, и путь к нему обязан читаться так
	же, как путь к ним. -->
<Header
	title="Внешние системы"
	description="Журнал обмена с CMS сайта и системой обучения: что пришло, что ушло и чем ответили"
/>

<Breadcrumbs items={[{ label: 'Настройки' }, { label: 'Внешние системы' }]} />

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	{#if form}
		<Alert.Root variant={form.ok ? 'default' : 'destructive'}>
			<Alert.Description>
				{form.message}
				{#if 'interactionId' in form && form.interactionId}
					<a
						class="text-link underline-offset-4 hover:underline"
						href={resolve('/(app)/interactions/[id=uuid]', { id: form.interactionId })}
					>
						Открыть дело заявки
					</a>
				{/if}
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

	{#if data.demoApplication}
		<!--
			Стенд: сцена обмена начинается на сайте, а не в CRM. Кнопка просит
			имитатор CMS подать новую заявку вуза или физического лица — дальше всё
			идёт обычным путём, и то же самое делает кнопка на странице самого
			имитатора.
		-->
		<form
			data-tour="exchange-demo"
			method="POST"
			action="?/demoApplication"
			use:enhance
			class="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-4"
		>
			<span id="exchange-demo-title" class="text-sm font-medium">Демо: заявка с сайта</span>
			<div role="group" aria-labelledby="exchange-demo-title" class="flex flex-wrap gap-2">
				<Button type="submit" name="form" value="b2b" variant="outline">Вуз (b2b)</Button>
				<Button type="submit" name="form" value="b2c" variant="outline">Физлицо (b2c)</Button>
			</div>
			<span class="text-sm text-muted-foreground">
				Имитатор CMS подаст заявку так же, как её подал бы посетитель сайта: она приедет по
				контракту обмена и станет взаимодействием. Каждое нажатие — новая заявка с новым ключом.
			</span>
		</form>
	{/if}

	{#if data.demoMocks.length > 0}
		<!--
			Стенд: отказ и восстановление обмена по заказу. Переключатель ставит
			имитатору сценарий «рвать соединения» — исходящие к нему встают в
			очередь повторов, — и снимает его. Имитатор общий для всего стенда.
		-->
		<section
			class="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
			aria-labelledby="exchange-demo-mocks-title"
		>
			<div class="flex flex-col gap-1">
				<h2 id="exchange-demo-mocks-title" class="text-sm font-medium">
					Демо: отказ и восстановление обмена
				</h2>
				<p class="text-sm text-muted-foreground">
					Недоступный имитатор рвёт соединения: исходящие к нему получают сетевую ошибку и ждут
					повтора. Верните доступность — и «Повторить» у строки доставит то же сообщение.
				</p>
			</div>
			<ul class="flex flex-col gap-2">
				{#each data.demoMocks as mock (mock.system)}
					<li class="flex flex-wrap items-center gap-3 text-sm">
						<span class="min-w-32 font-medium">{mock.title}</span>
						{#if mock.available === null}
							<span class="text-danger-soft-foreground">
								Состояние неизвестно: {mock.problem}
							</span>
						{:else}
							<span
								class={mock.available ? 'text-muted-foreground' : 'text-danger-soft-foreground'}
							>
								{mock.available ? 'доступен' : 'недоступен — рвёт соединения'}
							</span>
							<form method="POST" action="?/mockAvailability" use:enhance>
								<input type="hidden" name="system" value={mock.system} />
								<input type="hidden" name="available" value={mock.available ? 'false' : 'true'} />
								<Button type="submit" variant="outline" size="sm">
									{mock.available ? 'Сделать недоступным' : 'Вернуть доступность'}
								</Button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<!-- Загрузка оплат с сайта — не принадлежность стенда: выгрузку оплат
		присылает сайт заказчика, а загружает её администратор. -->
	<PaymentsDialog />

	<FilterBar />

	<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
	<div data-tour="exchange-journal" class="flex min-w-0 flex-col gap-4">
		{#if data.messages.items.length === 0}
			<EmptyState
				title="Сообщений нет"
				description="Обмен либо ещё не настроен, либо под этот фильтр ничего не попало."
			/>
		{:else}
			<div class="overflow-x-auto rounded-lg border border-border bg-surface">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Когда</Table.Head>
							<Table.Head>Направление</Table.Head>
							<Table.Head class="hidden 2xl:table-cell">Система</Table.Head>
							<Table.Head>Тип</Table.Head>
							<Table.Head>Ключи</Table.Head>
							<Table.Head>Состояние</Table.Head>
							<Table.Head>Попытки</Table.Head>
							<!-- Система, ответ и взаимодействие уезжают в строку под
							направлением, состоянием и событием, пока окно уже 1536: ключевые
							колонки журнала обязаны помещаться на экране в 1280 точек целиком,
							и с запасом — на машине без фирменной гарнитуры подстановка шире. -->
							<Table.Head class="hidden 2xl:table-cell">Ответ</Table.Head>
							<Table.Head class="hidden 2xl:table-cell">Взаимодействие</Table.Head>
							<Table.Head>Действия</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.messages.items as message (message.id)}
							<MessageRow {message} />
						{/each}
					</Table.Body>
				</Table.Root>
			</div>

			<div class="flex items-center justify-between text-sm text-muted-foreground">
				<span>Всего сообщений: {formatNumber(data.messages.total)}</span>
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
</div>
