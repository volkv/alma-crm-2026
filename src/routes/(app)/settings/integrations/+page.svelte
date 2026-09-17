<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import FormField from '$lib/components/form/form-field.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDateTime } from '$lib/format';
	import {
		deliverySettingsSchema,
		exchangeSettingsFormSchema,
		lmsSettingsFormSchema,
		prefixPattern,
		webhookFormSchema,
		WEBHOOK_STATE_LABELS,
		type DeliverySettings,
		type ExchangeSettingsFormInput,
		type LmsSettingsFormInput,
		type WebhookFormInput,
		type WebhookView
	} from '$lib/contracts/integrations';
	import { AUDIT_EVENT_GROUPS, AUDIT_EVENT_LABELS } from '../../audit/labels';
	import type { AuditEventType } from '$lib/contracts/audit';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	/** Секрет подписки приходит сообщением формы и показывается ровно один раз. */
	type IssuedSecret = { secret: string; name: string };

	let editorOpen = $state(false);
	let issued = $state<IssuedSecret | null>(null);

	const {
		form: webhook,
		errors: webhookErrors,
		enhance: webhookEnhance,
		submitting: webhookSubmitting,
		reset: resetWebhook
	} = superForm<WebhookFormInput, IssuedSecret | null>(
		untrack(() => data.webhookForm),
		{
			validators: zod4Client(webhookFormSchema),
			// Набор событий — список: форма едет одним JSON.
			dataType: 'json',
			onUpdated: ({ form: updated }) => {
				if (!updated.valid) {
					return;
				}

				editorOpen = false;

				if (updated.message) {
					issued = updated.message;
				}
			}
		}
	);

	const {
		form: lms,
		errors: lmsErrors,
		enhance: lmsEnhance,
		submitting: lmsSubmitting,
		message: lmsMessage
	} = superForm<LmsSettingsFormInput, string>(
		untrack(() => data.lmsForm),
		{ validators: zod4Client(lmsSettingsFormSchema), id: 'lms-settings' }
	);

	const {
		form: exchange,
		errors: exchangeErrors,
		enhance: exchangeEnhance,
		submitting: exchangeSubmitting,
		message: exchangeMessage
	} = superForm<ExchangeSettingsFormInput, string>(
		untrack(() => data.exchangeForm),
		{ validators: zod4Client(exchangeSettingsFormSchema), id: 'exchange-settings' }
	);

	const {
		form: delivery,
		errors: deliveryErrors,
		enhance: deliveryEnhance,
		submitting: deliverySubmitting,
		message: deliveryMessage
	} = superForm<DeliverySettings, string>(
		untrack(() => data.deliveryForm),
		{ validators: zod4Client(deliverySettingsSchema), id: 'delivery-settings' }
	);

	/** Результат кнопок раздела приходит обычным действием, а не через superforms. */
	const notice = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);
	// Успешный ответ кнопки несёт `ok`; отказ по правам приходит общим
	// переводчиком ошибок и этого поля не знает — и он именно отказ.
	const noticeFailed = $derived(
		actionResult !== null && (!('ok' in actionResult) || actionResult.ok !== true)
	);

	function startCreate() {
		resetWebhook();
		$webhook.id = null;
		$webhook.events = [];
		$webhook.enabled = true;
		editorOpen = true;
	}

	function startEdit(subscription: WebhookView) {
		$webhook.id = subscription.id;
		$webhook.name = subscription.name;
		$webhook.url = subscription.url;
		$webhook.events = [...subscription.events];
		$webhook.enabled = subscription.enabled;
		editorOpen = true;
	}

	function toggle(list: string[], value: string, checked: boolean): string[] {
		return checked ? [...new Set([...list, value])] : list.filter((item) => item !== value);
	}

	/** Раздел целиком выбран — отдельные события внутри него выбирать не нужно. */
	function wholeGroup(events: string[], prefix: string): boolean {
		return events.includes(prefixPattern(prefix));
	}

	function eventSummary(events: string[]): string {
		const groups = events.filter((event) => event.endsWith('.*')).length;

		return groups === 0
			? `событий: ${events.length}`
			: `разделов: ${groups}, отдельных событий: ${events.length - groups}`;
	}

	function eventLabel(pattern: string): string {
		return AUDIT_EVENT_LABELS[pattern as AuditEventType] ?? pattern;
	}

	async function copySecret(secret: string) {
		try {
			await navigator.clipboard.writeText(secret);
			toast.success('Секрет скопирован');
		} catch {
			// Буфер обмена бывает закрыт настройками браузера: честнее сказать об
			// этом, чем делать вид, что секрет скопирован.
			toast.error('Скопировать не удалось — выделите секрет и скопируйте вручную');
		}
	}
</script>

<svelte:head>
	<title>Интеграции — LCT CRM</title>
</svelte:head>

{#if notice}
	<Alert.Root variant={noticeFailed ? 'destructive' : 'default'}>
		<Alert.Description>{notice}</Alert.Description>
	</Alert.Root>
{/if}

{#if !data.canManageEndpoints}
	<!-- Раздел открыт, менять адреса нельзя. Так он выглядит и на публичной
		демонстрации: журнал обмена, состояние доставок и заход в систему обучения
		показывают, а адрес приёмника, токен и периодичность переживают
		демонстрацию — и остаются за правом «Внешние адреса и секреты подключений»
		(`docs/access-matrix.md`, раздел 5). -->
	<InlineHint tone="info">
		Адреса, секреты и периодичность фоновой работы меняет тот, у кого есть право «Внешние адреса и
		секреты подключений». Здесь они видны, но не редактируются: подписка на чужой приёмник и токен
		чужой системы продолжают работать и после того, как вы закроете вкладку. Журнал обмена, повтор
		доставки и заход в систему обучения доступны как обычно.
	</InlineHint>
{/if}

<!-- Целое число в поле: пустое значение даёт NaN, и схема скажет об этом
	словами; подменять его нулём нельзя — ноль здесь означал бы настройку. -->
{#snippet numberField({
	name,
	label,
	description,
	value,
	errors,
	onchange
}: {
	name: string;
	label: string;
	description?: string;
	value: number;
	errors: string[] | undefined;
	onchange: (next: number) => void;
})}
	<FormField {name} {label} {description} {errors} required>
		{#snippet control({ id, describedBy, invalid })}
			<Input
				{id}
				{name}
				type="number"
				inputmode="numeric"
				{value}
				aria-invalid={invalid}
				aria-describedby={describedBy}
				oninput={(event) => onchange(event.currentTarget.valueAsNumber)}
			/>
		{/snippet}
	</FormField>
{/snippet}

<Card.Root>
	<Card.Header>
		<Card.Title>Подписки на события</Card.Title>
		<Card.Description>
			Внешняя система узнаёт о происходящем из журнала действий: подписка получает POST с телом
			события и подписью. Секрет показывается один раз — при заведении.
		</Card.Description>
		{#if data.canManageEndpoints}
			<Card.Action>
				<Button size="sm" onclick={startCreate}>
					<PlusIcon aria-hidden="true" />
					Добавить подписку
				</Button>
			</Card.Action>
		{/if}
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		{#if data.webhooks.length === 0}
			<p class="text-sm text-muted-foreground">
				Подписок ещё нет. Заведите первую, когда внешней системе понадобится узнавать о событиях без
				опроса API.
			</p>
		{/if}

		{#each data.webhooks as subscription (subscription.id)}
			<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
				<header class="flex flex-wrap items-start justify-between gap-2">
					<div class="flex min-w-0 flex-col gap-1">
						<div class="flex items-center gap-2">
							<h2 class="text-sm font-medium">{subscription.name}</h2>
							{#if subscription.enabled}
								<StatusBadge tone={subscription.state === 'failed' ? 'danger' : 'success'}>
									{WEBHOOK_STATE_LABELS[subscription.state]}
								</StatusBadge>
							{:else}
								<StatusBadge tone="neutral">Выключена</StatusBadge>
							{/if}
						</div>
						<p class="truncate font-mono text-xs text-muted-foreground">{subscription.url}</p>
						<p class="text-xs text-muted-foreground">
							{eventSummary(subscription.events)}; ждут повтора: {subscription.pending}
						</p>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						{#if data.canManageEndpoints}
							<Button variant="outline" size="sm" onclick={() => startEdit(subscription)}>
								Изменить
							</Button>
						{/if}
						<form method="POST" action="?/test">
							<input type="hidden" name="webhookId" value={subscription.id} />
							<Button type="submit" variant="outline" size="sm">Тестовое событие</Button>
						</form>
					</div>
				</header>

				{#if subscription.lastDeliveries.length > 0}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Когда</Table.Head>
								<Table.Head>Событие</Table.Head>
								<Table.Head>Попытка</Table.Head>
								<Table.Head>Ответ</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each subscription.lastDeliveries as delivery (delivery.at + delivery.eventId)}
								<Table.Row>
									<Table.Cell>{formatDateTime(new Date(delivery.at))}</Table.Cell>
									<Table.Cell>{eventLabel(delivery.eventType)}</Table.Cell>
									<Table.Cell>{delivery.attempt}</Table.Cell>
									<Table.Cell>
										{#if delivery.ok}
											<StatusBadge tone="success">{delivery.status ?? 200}</StatusBadge>
										{:else}
											<span class="text-danger">{delivery.error}</span>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{:else}
					<p class="text-xs text-muted-foreground">Доставок ещё не было.</p>
				{/if}
			</section>
		{/each}
	</Card.Content>
</Card.Root>

<Card.Root>
	<Card.Header>
		<Card.Title>Периодичность доставки</Card.Title>
		<Card.Description>
			Как часто система дочитывает журнал в подписки и проверяет, не пора ли идти за выгрузкой.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if $deliveryMessage}
			<Alert.Root><Alert.Description>{$deliveryMessage}</Alert.Description></Alert.Root>
		{/if}
		{#if data.canManageEndpoints}
			<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
			<form
				method="POST"
				action="?/delivery"
				use:deliveryEnhance
				novalidate
				class="flex max-w-sm flex-col gap-4"
			>
				{@render numberField({
					name: 'intervalSeconds',
					label: 'Интервал, секунд',
					value: $delivery.intervalSeconds,
					errors: $deliveryErrors.intervalSeconds,
					onchange: (next) => ($delivery.intervalSeconds = next)
				})}
				<FormActions submitting={$deliverySubmitting} submitLabel="Сохранить" />
			</form>
		{:else}
			<dl class="text-sm">
				<dt class="text-muted-foreground">Интервал, секунд</dt>
				<dd class="font-mono">{$delivery.intervalSeconds}</dd>
			</dl>
		{/if}
	</Card.Content>
</Card.Root>

<Card.Root>
	<Card.Header>
		<Card.Title>Система обучения</Card.Title>
		<Card.Description>
			Выгрузка по курсам и записанным слушателям становится снимком данных об обучении. В показатели
			он попадёт только после подтверждения человеком — в разделе «Данные».
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		{#if data.lmsState}
			<InlineHint tone={data.lmsState.ok ? 'info' : 'warning'}>
				Последняя синхронизация {formatDateTime(new Date(data.lmsState.finishedAt))}:
				{data.lmsState.message}
			</InlineHint>
		{/if}

		{#if data.lmsHint !== null}
			<InlineHint tone="info">
				На стенде рядом поднят имитатор системы обучения. Адрес — <code class="font-mono"
					>{data.lmsHint}</code
				>, токен веб-сервиса — <code class="font-mono">mock-lms-token</code>. Данные в нём выдуманы,
				и его ответ ничего не доказывает о настоящей LMS.
			</InlineHint>
		{/if}

		{#if $lmsMessage}
			<Alert.Root><Alert.Description>{$lmsMessage}</Alert.Description></Alert.Root>
		{/if}

		{#if $lmsErrors._errors}
			<Alert.Root variant="destructive">
				<Alert.Description>
					<ul class="list-inside list-disc">
						{#each $lmsErrors._errors as issue (issue)}
							<li>{issue}</li>
						{/each}
					</ul>
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if !data.canManageEndpoints}
			<dl class="grid gap-2 text-sm sm:grid-cols-2">
				<div>
					<dt class="text-muted-foreground">Адрес системы обучения</dt>
					<dd class="font-mono break-all">{data.lms.baseUrl ?? 'не задан'}</dd>
				</div>
				<div>
					<dt class="text-muted-foreground">Токен веб-сервиса</dt>
					<dd>{data.lms.hasToken ? 'Сохранён' : 'Не задан'}</dd>
				</div>
				<div>
					<dt class="text-muted-foreground">Периодичность выгрузки, минут</dt>
					<dd class="font-mono">{data.lms.syncIntervalMinutes}</dd>
				</div>
				<div>
					<dt class="text-muted-foreground">Выгрузка по расписанию</dt>
					<dd>{data.lms.enabled ? 'Включена' : 'Выключена'}</dd>
				</div>
			</dl>
		{:else}
			<form
				method="POST"
				action="?/lms"
				use:lmsEnhance
				novalidate
				class="grid gap-4 sm:grid-cols-2"
			>
				<FieldInput
					name="baseUrl"
					label="Адрес системы обучения"
					description="Без хвоста: клиент сам добавит webservice/rest/server.php"
					placeholder="https://lms.example.org"
					bind:value={$lms.baseUrl}
					errors={$lmsErrors.baseUrl}
				/>
				<FieldInput
					name="token"
					label="Токен веб-сервиса"
					description={data.lms.hasToken
						? 'Токен сохранён. Пустое поле оставит прежний'
						: 'Токен веб-сервиса Moodle; после сохранения показан не будет'}
					placeholder={data.lms.hasToken ? '••••••••' : 'Токен'}
					bind:value={() => $lms.token ?? '', (next) => ($lms.token = next.trim() || null)}
					errors={$lmsErrors.token}
				/>
				{@render numberField({
					name: 'syncIntervalMinutes',
					label: 'Периодичность выгрузки, минут',
					value: $lms.syncIntervalMinutes,
					errors: $lmsErrors.syncIntervalMinutes,
					onchange: (next) => ($lms.syncIntervalMinutes = next)
				})}
				<div class="flex items-end">
					<Label class="flex items-center gap-2 font-normal">
						<Checkbox name="enabled" bind:checked={$lms.enabled} />
						Забирать выгрузку по расписанию
					</Label>
				</div>
				<div class="sm:col-span-2">
					<FormActions submitting={$lmsSubmitting} submitLabel="Сохранить настройки" />
				</div>
			</form>
		{/if}

		<div class="flex flex-wrap gap-2 border-t border-border pt-4">
			<form method="POST" action="?/sync">
				<Button
					type="submit"
					variant={data.lms.hasToken ? 'default' : 'outline'}
					disabled={!data.lms.hasToken}
				>
					<RefreshCwIcon aria-hidden="true" />
					Синхронизировать сейчас
				</Button>
			</form>
			{#if data.lms.hasToken && data.canManageEndpoints}
				<form method="POST" action="?/forgetToken">
					<Button type="submit" variant="outline">Забыть токен</Button>
				</form>
			{/if}
		</div>
		{#if !data.lms.hasToken}
			<p class="text-xs text-muted-foreground">
				Синхронизация станет доступна, когда будут заданы адрес и токен.
			</p>
		{/if}
	</Card.Content>
</Card.Root>

<Card.Root>
	<Card.Header>
		<Card.Title>Обмен с CMS и системой обучения</Card.Title>
		<Card.Description>
			Четыре направления контракта обмена: заявка с сайта и снимок её статуса обратно, заявка на
			учебную группу и результат потока. Журнал обмена в обе стороны — в разделе «Внешние системы».
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		<p class="text-sm">
			Входящие принимаются ключом доступа роли «Внешняя система»:
			<code class="font-mono">POST {data.origin}/api/v1/applications</code>
			и
			<code class="font-mono">POST {data.origin}/api/v1/exchange/learning-groups/results</code>.
			Исходящие CRM подписывает HMAC, как вебхуки.
		</p>

		{#if $exchangeMessage}
			<Alert.Root><Alert.Description>{$exchangeMessage}</Alert.Description></Alert.Root>
		{/if}

		{#if $exchangeErrors._errors}
			<Alert.Root variant="destructive">
				<Alert.Description>
					<ul class="list-inside list-disc">
						{#each $exchangeErrors._errors as issue (issue)}
							<li>{issue}</li>
						{/each}
					</ul>
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if data.canManageEndpoints}
			<form
				method="POST"
				action="?/exchange"
				use:exchangeEnhance
				novalidate
				class="grid gap-4 sm:grid-cols-2"
			>
				<FieldInput
					name="cmsInstance"
					label="Экземпляр CMS"
					description="Имя подключения: с ним сверяется source.instance входящего сообщения"
					placeholder="itschool-site"
					bind:value={$exchange.cmsInstance}
					errors={$exchangeErrors.cmsInstance}
				/>
				<FieldInput
					name="cmsStatusUrl"
					label="Адрес карточки заявки"
					description="Содержит фигурные скобки с externalId — на их место встаёт ключ заявки"
					placeholder="https://site.example.org/api/applications/{'{externalId}'}/status"
					bind:value={$exchange.cmsStatusUrl}
					errors={$exchangeErrors.cmsStatusUrl}
				/>
				<FieldInput
					name="cmsSecret"
					label="Секрет подписи для CMS"
					description={data.exchange.cms.hasSecret
						? 'Секрет сохранён. Пустое поле оставит прежний'
						: 'Им подписываются исходящие сообщения; после сохранения показан не будет'}
					placeholder={data.exchange.cms.hasSecret ? '••••••••' : 'Секрет'}
					bind:value={
						() => $exchange.cmsSecret ?? '', (next) => ($exchange.cmsSecret = next.trim() || null)
					}
					errors={$exchangeErrors.cmsSecret}
				/>
				<FieldSelect
					name="cmsDefaultOwnerUserId"
					label="Ответственный за входящие заявки"
					description="Сотрудник, который принимает заявки с сайта и ведёт их дальше"
					placeholder="Не задан"
					options={data.owners.map((owner) => ({ value: owner.id, label: owner.fullName }))}
					bind:value={
						() => $exchange.cmsDefaultOwnerUserId ?? '',
						(next) => ($exchange.cmsDefaultOwnerUserId = next === '' ? null : next)
					}
					errors={$exchangeErrors.cmsDefaultOwnerUserId}
				/>
				<FieldInput
					name="lmsInstance"
					label="Экземпляр системы обучения"
					description="Имя подключения: с ним сверяется source.instance результата группы"
					placeholder="moodle-itschool"
					bind:value={$exchange.lmsInstance}
					errors={$exchangeErrors.lmsInstance}
				/>
				<FieldInput
					name="lmsGroupsUrl"
					label="Адрес заведения учебной группы"
					description="Туда уходит заявка на поток по кнопке из карточки взаимодействия"
					placeholder="https://lms.example.org/api/groups"
					bind:value={$exchange.lmsGroupsUrl}
					errors={$exchangeErrors.lmsGroupsUrl}
				/>
				<FieldInput
					name="lmsSecret"
					label="Секрет подписи для системы обучения"
					description={data.exchange.lms.hasSecret
						? 'Секрет сохранён. Пустое поле оставит прежний'
						: 'Им подписывается заявка на учебную группу'}
					placeholder={data.exchange.lms.hasSecret ? '••••••••' : 'Секрет'}
					bind:value={
						() => $exchange.lmsSecret ?? '', (next) => ($exchange.lmsSecret = next.trim() || null)
					}
					errors={$exchangeErrors.lmsSecret}
				/>
				<div class="sm:col-span-2">
					<FormActions submitting={$exchangeSubmitting} submitLabel="Сохранить подключения" />
				</div>
			</form>
		{:else}
			<!-- Адреса и секреты подключений правит только тот, у кого есть право
				«Внешние адреса и секреты подключений»: они уводят данные на чужой узел
				(`docs/access-matrix.md`, раздел 5). Остальным раздел показывает
				состояние подключений — этого хватает, чтобы разобрать обмен;
				объяснение дано один раз, наверху страницы. -->
			<dl class="grid gap-2 text-sm sm:grid-cols-2">
				<div>
					<dt class="text-muted-foreground">Экземпляр CMS</dt>
					<dd class="font-mono">{data.exchange.cms.instance}</dd>
				</div>
				<div>
					<dt class="text-muted-foreground">Адрес карточки заявки</dt>
					<dd class="font-mono break-all">{data.exchange.cms.statusUrl ?? 'не задан'}</dd>
				</div>
				<div>
					<dt class="text-muted-foreground">Экземпляр системы обучения</dt>
					<dd class="font-mono">{data.exchange.lms.instance}</dd>
				</div>
				<div>
					<dt class="text-muted-foreground">Адрес заведения группы</dt>
					<dd class="font-mono break-all">{data.exchange.lms.groupsUrl ?? 'не задан'}</dd>
				</div>
			</dl>
		{/if}
	</Card.Content>
</Card.Root>

<Dialog.Root bind:open={editorOpen}>
	<Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{$webhook.id === null ? 'Новая подписка' : 'Подписка'}</Dialog.Title>
			<Dialog.Description>
				Адрес принимает POST с телом события. По http принимает только адрес на этой же машине —
				остальным нужен https.
			</Dialog.Description>
		</Dialog.Header>

		{#if $webhookErrors._errors}
			<Alert.Root variant="destructive">
				<Alert.Description>
					<ul class="list-inside list-disc">
						{#each $webhookErrors._errors as issue (issue)}
							<li>{issue}</li>
						{/each}
					</ul>
				</Alert.Description>
			</Alert.Root>
		{/if}

		<form
			method="POST"
			action="?/webhook"
			use:webhookEnhance
			novalidate
			class="flex flex-col gap-4"
		>
			<FieldInput
				name="name"
				label="Название"
				required
				placeholder="Портал партнёров"
				bind:value={$webhook.name}
				errors={$webhookErrors.name}
			/>
			<FieldInput
				name="url"
				label="Адрес приёмника"
				required
				placeholder="https://partner.example.org/hooks/lct"
				bind:value={$webhook.url}
				errors={$webhookErrors.url}
			/>

			<Label class="flex items-center gap-2 font-normal">
				<Checkbox bind:checked={$webhook.enabled} />
				Подписка включена
			</Label>

			<fieldset class="flex flex-col gap-2">
				<legend class="text-sm font-medium">События</legend>
				{#if $webhookErrors.events}
					<p class="text-xs text-danger">{$webhookErrors.events}</p>
				{/if}
				<ScrollArea class="h-64 rounded-md border border-border p-3">
					{#each AUDIT_EVENT_GROUPS as group (group.prefix)}
						{@const whole = wholeGroup($webhook.events, group.prefix)}
						<div class="mb-3 flex flex-col gap-1">
							<Label class="flex items-center gap-2 text-sm font-medium">
								<Checkbox
									checked={whole}
									onCheckedChange={(checked) =>
										($webhook.events = toggle(
											$webhook.events.filter((event) => !event.startsWith(`${group.prefix}.`)),
											prefixPattern(group.prefix),
											checked === true
										))}
								/>
								{group.label} — весь раздел
							</Label>
							<div class="ml-6 flex flex-col gap-1">
								{#each group.types as type (type)}
									<Label class="flex items-center gap-2 text-xs font-normal">
										<Checkbox
											checked={whole || $webhook.events.includes(type)}
											disabled={whole}
											onCheckedChange={(checked) =>
												($webhook.events = toggle($webhook.events, type, checked === true))}
										/>
										{AUDIT_EVENT_LABELS[type]}
									</Label>
								{/each}
							</div>
						</div>
					{/each}
				</ScrollArea>
			</fieldset>

			<FormActions
				submitting={$webhookSubmitting}
				submitLabel={$webhook.id === null ? 'Завести подписку' : 'Сохранить'}
				oncancel={() => (editorOpen = false)}
			/>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root
	open={issued !== null}
	onOpenChange={(open) => {
		if (!open) issued = null;
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Подписка «{issued?.name}» заведена</Dialog.Title>
			<Dialog.Description>
				Заберите секрет сейчас: им подписывается каждая доставка, и второй раз показать его будет
				неоткуда.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex items-center gap-2">
			<Input
				readonly
				value={issued?.secret ?? ''}
				aria-label="Секрет подписки"
				class="font-mono"
				onfocus={(event) => event.currentTarget.select()}
			/>
			<Button
				variant="outline"
				size="icon"
				aria-label="Скопировать секрет"
				onclick={() => copySecret(issued?.secret ?? '')}
			>
				<CopyIcon aria-hidden="true" />
			</Button>
		</div>

		<InlineHint tone="warning" icon={KeyRoundIcon}>
			Подпись считается от секрета: тот, у кого он есть, может выдать свой запрос за наш. Проверка
			подписи на стороне получателя описана в документации по интеграциям.
		</InlineHint>

		<Dialog.Footer>
			<Button onclick={() => (issued = null)}>Готово</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
