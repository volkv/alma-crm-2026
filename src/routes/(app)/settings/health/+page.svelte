<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge, { type StatusTone } from '$lib/components/status-badge.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	type Status = (typeof data.report.links)[number]['state']['status'];
	type Kind = (typeof data.report.links)[number]['kind'];

	const STATUS: Record<Status, { label: string; tone: StatusTone }> = {
		ok: { label: 'Отвечает', tone: 'success' },
		failed: { label: 'Не отвечает', tone: 'danger' },
		not_configured: { label: 'Не настроено', tone: 'neutral' },
		disabled: { label: 'Выключено флагом', tone: 'neutral' },
		not_checked: { label: 'Не проверялось', tone: 'info' }
	};

	/**
	 * Что связь значит для работы. Подписи короткие, поэтому под таблицей стоит
	 * легенда с теми же пояснениями: подсказка в `title` видна не всем и не на
	 * телефоне.
	 */
	const KIND: Record<Kind, { label: string; hint: string }> = {
		required: {
			label: 'Обязательная',
			hint: 'Своя служба установки: база, кэш, хранилище файлов, вход, сборка документов. Без неё не работают вход, карточка, документы или отчёты.'
		},
		allowed: {
			label: 'Внутри сети',
			hint: 'Соседняя система в сети заказчика: CMS, система обучения, почтовый сервер. Без неё встаёт только своё направление, например обмен или письма; остальное работает.'
		},
		external: {
			label: 'Через интернет',
			hint: 'Внешний сервис в интернете. Выключается флагом «Внешние источники»; без него реквизиты организации вводятся вручную, основные сценарии от него не зависят.'
		}
	};

	const KIND_ORDER: readonly Kind[] = ['required', 'allowed', 'external'];

	const checkedAt = $derived(
		new Date(data.report.checkedAt).toLocaleString('ru-RU', {
			dateStyle: 'short',
			timeStyle: 'medium'
		})
	);

	let refreshing = $state(false);
	let checkingExternal = $state(false);

	async function refresh() {
		refreshing = true;

		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	const external = $derived(form?.external ?? null);
	const actionMessage = $derived(form?.message ?? null);
</script>

<svelte:head>
	<title>Статус системы — Альма CRM</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title>Статус системы</Card.Title>
		<Card.Description>
			С чем система соединяется, зачем и отвечает ли оно сейчас. Каждая связь проверяется при
			открытии страницы, не дольше пары секунд; наружу, в интернет, открытие не ходит.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
		<div
			data-tour="diagnostics-summary"
			class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4"
		>
			<div class="flex flex-col gap-1">
				<p class="text-sm font-medium">
					Основные сценарии работают без интернета:
					<StatusBadge tone={data.report.offlineReady ? 'success' : 'danger'} class="ml-1">
						{data.report.offlineReady ? 'да' : 'нет'}
					</StatusBadge>
				</p>
				<p class="text-xs text-muted-foreground">
					Итог считается только по обязательным локальным связям. Отказ CMS, почты или внешних
					источников выключает своё направление, но не вход, карточку и отчёты. Проверено
					{checkedAt}.
				</p>
			</div>
			<Button variant="outline" onclick={refresh} disabled={refreshing}>
				<RefreshCwIcon aria-hidden="true" />
				Проверить заново
			</Button>
		</div>

		<div
			data-tour="diagnostics-links"
			class="overflow-x-auto rounded-xl border border-border bg-surface"
		>
			<Table.Root>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head>Связь</Table.Head>
						<Table.Head>Адрес</Table.Head>
						<Table.Head>Для основных сценариев</Table.Head>
						<Table.Head>Состояние</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.report.links as link (link.id)}
						<Table.Row class="hover:bg-transparent">
							<Table.Cell class="align-top whitespace-normal">
								<span class="block font-medium">{link.name}</span>
								<span class="block text-xs text-muted-foreground">{link.purpose}</span>
							</Table.Cell>
							<Table.Cell class="align-top">
								{#if link.address === null}
									<span class="text-xs text-faint">не задан</span>
								{:else}
									<code class="text-xs break-all">{link.address}</code>
								{/if}
							</Table.Cell>
							<Table.Cell class="align-top">
								<StatusBadge
									tone={link.kind === 'required' ? 'accent' : 'neutral'}
									title={KIND[link.kind].hint}
								>
									{KIND[link.kind].label}
								</StatusBadge>
							</Table.Cell>
							<Table.Cell class="align-top whitespace-normal">
								<StatusBadge tone={STATUS[link.state.status].tone} dot>
									{STATUS[link.state.status].label}
								</StatusBadge>
								{#if link.state.latencyMs !== null}
									<span class="ml-1 text-xs text-muted-foreground">{link.state.latencyMs} мс</span>
								{/if}
								{#if link.state.detail !== null}
									<span class="mt-1 block max-w-md text-xs text-muted-foreground">
										{link.state.detail}
									</span>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>

		<dl
			class="grid gap-x-3 gap-y-1.5 text-xs text-muted-foreground sm:grid-cols-[max-content_1fr]"
			aria-label="Что значит колонка «Для основных сценариев»"
		>
			{#each KIND_ORDER as kind (kind)}
				<dt>
					<StatusBadge tone={kind === 'required' ? 'accent' : 'neutral'}>
						{KIND[kind].label}
					</StatusBadge>
				</dt>
				<dd class="self-center">{KIND[kind].hint}</dd>
			{/each}
		</dl>

		<p class="text-xs text-muted-foreground" data-testid="outbound-allow-list">
			Разрешённые узлы внутри сети (<code>OUTBOUND_ALLOWED_HOSTS</code>):
			{#if data.report.outboundAllowList.length === 0}
				список пуст — CMS, система обучения и приёмники подписок принимаются только по публичным
				адресам.
			{:else}
				{#each data.report.outboundAllowList as entry, index (entry)}
					<code class="break-all">{entry}</code>{index < data.report.outboundAllowList.length - 1
						? ', '
						: '.'}
				{/each}
				Адрес в приватной сети или на петле, не входящий в список, отклоняется.
			{/if}
		</p>

		<div data-tour="diagnostics-external" class="flex flex-col gap-2 border-t border-border pt-4">
			<InlineHint>
				Внешние источники — Dadata и сайты вузов — включаются флагом «Внешние источники» в
				<Button
					variant="link"
					class="h-auto p-0 align-baseline text-xs"
					href={resolve('/(app)/settings/general')}
				>
					общих настройках
				</Button>. Кнопка ниже один раз разрешает имя {data.dadataHost} и открывает соединение на порт
				443 — без запроса к API, ключа и квоты она не тратит.
			</InlineHint>
			<form
				method="POST"
				action="?/external"
				use:enhance={() => {
					checkingExternal = true;

					return async ({ update }) => {
						await update();
						checkingExternal = false;
					};
				}}
			>
				<Button type="submit" variant="outline" disabled={checkingExternal}>
					<GlobeIcon aria-hidden="true" />
					Проверить внешние источники
				</Button>
			</form>
			{#if external !== null}
				<p class="flex flex-wrap items-center gap-2 text-sm" role="status">
					<span>{external.host}</span>
					<StatusBadge tone={external.state.status === 'ok' ? 'success' : 'danger'} dot>
						{external.state.status === 'ok' ? 'Доступен' : 'Недоступен'}
					</StatusBadge>
					{#if external.resolved !== null}
						<span class="text-xs text-muted-foreground">{external.resolved}</span>
					{/if}
					{#if external.state.latencyMs !== null}
						<span class="text-xs text-muted-foreground">{external.state.latencyMs} мс</span>
					{/if}
					{#if external.state.detail !== null}
						<span class="basis-full text-xs text-muted-foreground">{external.state.detail}</span>
					{/if}
				</p>
			{:else if actionMessage !== null}
				<p class="text-sm text-danger" role="alert">{actionMessage}</p>
			{/if}
		</div>
	</Card.Content>
</Card.Root>
