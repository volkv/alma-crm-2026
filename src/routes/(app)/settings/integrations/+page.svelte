<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { ResolvedPathname } from '$app/types';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PencilIcon from '@lucide/svelte/icons/pencil';
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
	import FormDialog from '$lib/components/form-dialog.svelte';
	import FormField from '$lib/components/form/form-field.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge, { type StatusTone } from '$lib/components/status-badge.svelte';
	import { formatDateTime, pluralize } from '$lib/format';
	import {
		DADATA_CLOUD_ORIGIN,
		DADATA_KEY_SOURCE_LABELS,
		dadataSettingsFormSchema,
		deliverySettingsSchema,
		exchangeCmsFormSchema,
		exchangeLmsFormSchema,
		lmsSettingsFormSchema,
		prefixPattern,
		webhookFormSchema,
		WEBHOOK_STATE_LABELS,
		type DadataSettingsFormInput,
		type DeliverySettings,
		type ExchangeCmsFormInput,
		type ExchangeLmsFormInput,
		type LmsSettingsFormInput,
		type WebhookFormInput,
		type WebhookView
	} from '$lib/contracts/integrations';
	import { AUDIT_EVENT_GROUPS, AUDIT_EVENT_LABELS } from '../../audit/labels';
	import type { AuditEventType } from '$lib/contracts/audit';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	/**
	 * Группы страницы — по внешним системам, а не по видам настроек: кто
	 * разбирает приём заявок с сайта, ищет всё про сайт в одном месте.
	 */
	const TABS = ['cms', 'lms', 'webhooks', 'reference'] as const;
	type Tab = (typeof TABS)[number];

	function isTab(value: string | null): value is Tab {
		return value !== null && (TABS as readonly string[]).includes(value);
	}

	/**
	 * Выбранная группа живёт в адресе (`?tab=…`): прямая ссылка открывает нужную,
	 * и её же видит сервер — страница приходит сразу с открытой группой, без мигания.
	 */
	let tab = $state<Tab>(
		untrack(() => {
			const requested = page.url.searchParams.get('tab');

			return isTab(requested) ? requested : 'cms';
		})
	);

	function tabHref(next: Tab): ResolvedPathname {
		return `${resolve('/(app)/settings/integrations')}?tab=${next}` as ResolvedPathname;
	}

	/**
	 * Смена группы меняет адрес без перехода и без новой записи в истории:
	 * «назад» уводит со страницы, а не перебирает группы.
	 */
	function selectTab(next: string) {
		if (!isTab(next) || next === tab) {
			return;
		}

		tab = next;
		replaceState(tabHref(next), page.state);
	}

	/**
	 * Стрелки по плиткам — как по вкладкам: влево и вправо по кругу, `Home` и
	 * `End` — к краям. Группа открывается сразу, фокус идёт за ней.
	 */
	function onTilesKeydown(event: KeyboardEvent) {
		const index = TABS.indexOf(tab);
		const next =
			event.key === 'ArrowRight'
				? TABS[(index + 1) % TABS.length]
				: event.key === 'ArrowLeft'
					? TABS[(index - 1 + TABS.length) % TABS.length]
					: event.key === 'Home'
						? TABS[0]
						: event.key === 'End'
							? TABS[TABS.length - 1]
							: null;

		if (next === null) {
			return;
		}

		event.preventDefault();
		selectTab(next);
		document.getElementById(`integrations-tab-${next}`)?.focus();
	}

	// Старый якорь `#dadata` (ссылки из справки и закладки) открывает группу
	// справочных сервисов. Якоря сервер не видит, поэтому — после гидратации.
	onMount(async () => {
		if (page.url.hash !== '#dadata') {
			return;
		}

		tab = 'reference';
		await tick();
		document.getElementById('dadata')?.scrollIntoView({ block: 'start' });
	});

	/** Секрет подписки приходит сообщением формы и показывается ровно один раз. */
	type IssuedSecret = { secret: string; name: string };

	let editorOpen = $state(false);
	let dadataOpen = $state(false);
	let cmsOpen = $state(false);
	let lmsOpen = $state(false);
	let groupsOpen = $state(false);
	let deliveryOpen = $state(false);
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

	// Формы подключений устроены одинаково: на карточке — текущие значения, по
	// «Изменить» — окно с формой. Успех закрывает окно и пишет итог в карточке;
	// ошибка остаётся в окне, и окно не закрывается.

	const {
		form: lms,
		errors: lmsErrors,
		enhance: lmsEnhance,
		submitting: lmsSubmitting,
		message: lmsMessage
	} = superForm<LmsSettingsFormInput, string>(
		untrack(() => data.lmsForm),
		{
			validators: zod4Client(lmsSettingsFormSchema),
			id: 'lms-settings',
			onUpdated: ({ form: updated }) => {
				if (updated.valid) {
					lmsOpen = false;
				}
			}
		}
	);

	const {
		form: cms,
		errors: cmsErrors,
		enhance: cmsEnhance,
		submitting: cmsSubmitting,
		message: cmsMessage
	} = superForm<ExchangeCmsFormInput, string>(
		untrack(() => data.exchangeCmsForm),
		{
			validators: zod4Client(exchangeCmsFormSchema),
			id: 'exchange-cms-settings',
			onUpdated: ({ form: updated }) => {
				if (updated.valid) {
					cmsOpen = false;
				}
			}
		}
	);

	const {
		form: groups,
		errors: groupsErrors,
		enhance: groupsEnhance,
		submitting: groupsSubmitting,
		message: groupsMessage
	} = superForm<ExchangeLmsFormInput, string>(
		untrack(() => data.exchangeLmsForm),
		{
			validators: zod4Client(exchangeLmsFormSchema),
			id: 'exchange-lms-settings',
			onUpdated: ({ form: updated }) => {
				if (updated.valid) {
					groupsOpen = false;
				}
			}
		}
	);

	const {
		form: dadata,
		errors: dadataErrors,
		enhance: dadataEnhance,
		submitting: dadataSubmitting,
		message: dadataMessage
	} = superForm<DadataSettingsFormInput, string>(
		untrack(() => data.dadataForm),
		{
			validators: zod4Client(dadataSettingsFormSchema),
			id: 'dadata-settings',
			onUpdated: ({ form: updated }) => {
				if (updated.valid) {
					dadataOpen = false;
				}
			}
		}
	);

	const {
		form: delivery,
		errors: deliveryErrors,
		enhance: deliveryEnhance,
		submitting: deliverySubmitting,
		message: deliveryMessage
	} = superForm<DeliverySettings, string>(
		untrack(() => data.deliveryForm),
		{
			validators: zod4Client(deliverySettingsSchema),
			id: 'delivery-settings',
			onUpdated: ({ form: updated }) => {
				if (updated.valid) {
					deliveryOpen = false;
				}
			}
		}
	);

	// Окно открывается с сохранёнными значениями, а не с тем, что набрали и
	// бросили в прошлый раз: «Отмена» не должна оставлять черновик в форме.
	// Поле секрета всегда пустое — пустое значит «оставить прежний».

	function openCms() {
		$cms = {
			cmsInstance: data.exchange.cms.instance,
			cmsStatusUrl: data.exchange.cms.statusUrl ?? '',
			cmsSecret: null,
			cmsDefaultOwnerUserId: data.exchange.cms.defaultOwnerUserId
		};
		$cmsErrors = {};
		cmsOpen = true;
	}

	function openGroups() {
		$groups = {
			lmsInstance: data.exchange.lms.instance,
			lmsGroupsUrl: data.exchange.lms.groupsUrl ?? '',
			lmsSecret: null
		};
		$groupsErrors = {};
		groupsOpen = true;
	}

	function openLms() {
		$lms = {
			baseUrl: data.lms.baseUrl ?? '',
			token: null,
			enabled: data.lms.enabled,
			syncIntervalMinutes: data.lms.syncIntervalMinutes
		};
		$lmsErrors = {};
		lmsOpen = true;
	}

	function openDelivery() {
		$delivery = { ...data.deliveryForm.data };
		$deliveryErrors = {};
		deliveryOpen = true;
	}

	function openDadata() {
		$dadata.apiKey = null;
		$dadataErrors = {};
		dadataOpen = true;
	}

	/** Результат кнопок раздела приходит обычным действием, а не через superforms. */
	const notice = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);
	// Успешный ответ кнопки несёт `ok`; отказ по правам приходит общим
	// переводчиком ошибок и этого поля не знает — и он именно отказ.
	const noticeFailed = $derived(
		actionResult !== null && (!('ok' in actionResult) || actionResult.ok !== true)
	);

	/* Плитки групп: состояние считается из того, что страница уже загрузила. */

	type Status = { label: string; tone: StatusTone };

	const CONFIGURED: Status = { label: 'Настроено', tone: 'success' };
	const NOT_CONFIGURED: Status = { label: 'Не настроено', tone: 'neutral' };
	const FAILED: Status = { label: 'Ошибка', tone: 'danger' };

	const cmsOwner = $derived(
		data.owners.find((owner) => owner.id === data.exchange.cms.defaultOwnerUserId) ?? null
	);

	/** Сайт настроен, когда заявки есть кому принять и статус есть куда вернуть. */
	const cmsStatus = $derived<Status>(
		cmsOwner !== null && data.exchange.cms.statusUrl !== null && data.exchange.cms.hasSecret
			? CONFIGURED
			: NOT_CONFIGURED
	);

	/** Неудачная последняя выгрузка важнее того, что адреса заданы. */
	const lmsStatus = $derived<Status>(
		data.lmsState !== null && !data.lmsState.ok
			? FAILED
			: data.lms.baseUrl !== null &&
				  data.lms.hasToken &&
				  data.exchange.lms.groupsUrl !== null &&
				  data.exchange.lms.hasSecret
				? CONFIGURED
				: NOT_CONFIGURED
	);

	const webhooksStatus = $derived<Status>({
		label: pluralize(data.webhooks.length, ['подписка', 'подписки', 'подписок']),
		tone: data.webhooks.some((item) => item.enabled && item.state === 'failed')
			? 'danger'
			: data.webhooks.length > 0
				? 'success'
				: 'neutral'
	});

	const referenceStatus = $derived<Status>(
		data.dadata.keySource === 'none' ? NOT_CONFIGURED : CONFIGURED
	);

	type Tile = { tab: Tab; title: string; status: Status; detail: string };

	const tiles = $derived<Record<Tab, Tile>>({
		cms: {
			tab: 'cms',
			title: 'Сайт (CMS)',
			status: cmsStatus,
			detail:
				cmsOwner === null
					? 'Ответственный за заявки не задан'
					: `Заявки принимает ${cmsOwner.fullName}`
		},
		lms: {
			tab: 'lms',
			title: 'Система обучения (LMS)',
			status: lmsStatus,
			detail:
				data.lmsState === null
					? 'Выгрузок ещё не было'
					: `Выгрузка ${formatDateTime(new Date(data.lmsState.finishedAt))}`
		},
		webhooks: {
			tab: 'webhooks',
			title: 'Вебхуки',
			status: webhooksStatus,
			detail: `Ждут повтора: ${data.webhooks.reduce((sum, item) => sum + item.pending, 0)}`
		},
		reference: {
			tab: 'reference',
			title: 'Справочные сервисы',
			status: referenceStatus,
			detail: `Dadata: ключ ${DADATA_KEY_SOURCE_LABELS[data.dadata.keySource]}`
		}
	});

	const applicationsUrl = $derived(`${data.origin}/api/v1/applications`);
	const resultsUrl = $derived(`${data.origin}/api/v1/exchange/learning-groups/results`);

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

	async function copyText(text: string, done: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success(done);
		} catch {
			// Буфер обмена бывает закрыт настройками браузера: честнее сказать об
			// этом, чем делать вид, что текст скопирован.
			toast.error('Скопировать не удалось — выделите текст и скопируйте вручную');
		}
	}
</script>

<svelte:head>
	<title>Интеграции — Альма CRM</title>
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
		{#if data.demoSession}
			Вы вошли демонстрационной записью. Право «Внешние адреса и секреты подключений» у роли может
			быть, но демонстрационной сессии оно не выдаётся никогда: адреса, секреты и периодичность
			переживают показ, и задаёт их штатный администратор стенда. Здесь они видны, но не
			редактируются. Журнал обмена, повтор доставки, тестовое событие и заход в систему обучения
			доступны как обычно.
		{:else}
			Адреса, секреты и периодичность фоновой работы меняет тот, у кого есть право «Внешние адреса и
			секреты подключений». Здесь они видны, но не редактируются: подписка на чужой приёмник и токен
			чужой системы продолжают работать и после того, как вы закроете вкладку. Журнал обмена, повтор
			доставки и заход в систему обучения доступны как обычно.
		{/if}
	</InlineHint>
{/if}

<!-- Входящий адрес с кнопкой копирования: его передают владельцу чужой системы. -->
{#snippet inboundAddress(label: string, url: string)}
	<div class="flex flex-col gap-1">
		<span class="text-sm text-muted-foreground">{label}</span>
		<div class="flex min-w-0 items-center gap-2">
			<code class="min-w-0 font-mono text-sm break-all">POST {url}</code>
			<Button
				variant="outline"
				size="icon"
				aria-label="Скопировать адрес"
				onclick={() => copyText(url, 'Адрес скопирован')}
			>
				<CopyIcon aria-hidden="true" />
			</Button>
		</div>
	</div>
{/snippet}

<!-- Ошибки формы, не относящиеся к одному полю: над полями, внутри окна. -->
{#snippet formErrors(issues: string[] | undefined)}
	{#if issues}
		<Alert.Root variant="destructive" class="mb-4">
			<Alert.Description>
				<ul class="list-inside list-disc">
					{#each issues as issue (issue)}
						<li>{issue}</li>
					{/each}
				</ul>
			</Alert.Description>
		</Alert.Root>
	{/if}
{/snippet}

<!-- Итог сохранения — в карточке, которую меняли. -->
{#snippet saved(text: string | undefined)}
	{#if text}
		<Alert.Root><Alert.Description>{text}</Alert.Description></Alert.Root>
	{/if}
{/snippet}

{#snippet editButton(onclick: () => void)}
	{#if data.canManageEndpoints}
		<Card.Action>
			<Button size="sm" variant="outline" {onclick}>
				<PencilIcon aria-hidden="true" />
				Изменить
			</Button>
		</Card.Action>
	{/if}
{/snippet}

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

<!-- Сводка по группам — она же переключатель: одно слово о состоянии, щелчок
	или стрелки открывают группу. Обёртки плиток несут `data-tour` — метки
	подсказок по этому экрану (`$lib/onboarding/screens`): закрытые группы на
	экране не видны, и подсказка указывает на их плитку. -->
{#snippet tileButton(tile: Tile)}
	<button
		type="button"
		role="tab"
		id="integrations-tab-{tile.tab}"
		aria-selected={tab === tile.tab}
		aria-controls={tab === tile.tab ? `integrations-panel-${tile.tab}` : undefined}
		tabindex={tab === tile.tab ? 0 : -1}
		class={[
			'flex h-full w-full min-w-0 flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
			tab === tile.tab
				? 'border-link bg-selection text-selection-foreground'
				: 'border-border bg-surface hover:bg-surface-muted'
		]}
		onclick={() => selectTab(tile.tab)}
	>
		<span class="text-sm font-medium">{tile.title}</span>
		<StatusBadge tone={tile.status.tone}>{tile.status.label}</StatusBadge>
		<span class="line-clamp-2 text-xs break-words text-muted-foreground">{tile.detail}</span>
	</button>
{/snippet}

<div
	role="tablist"
	aria-label="Внешние системы"
	tabindex="-1"
	class="grid grid-cols-2 gap-2 lg:grid-cols-4"
	data-tour="integrations-summary"
	onkeydown={onTilesKeydown}
>
	<div role="presentation" class="min-w-0" data-tour="integrations-cms">
		{@render tileButton(tiles.cms)}
	</div>
	<div role="presentation" class="min-w-0" data-tour="integrations-lms">
		{@render tileButton(tiles.lms)}
	</div>
	<div role="presentation" class="min-w-0" data-tour="integrations-webhooks">
		{@render tileButton(tiles.webhooks)}
	</div>
	<div role="presentation" class="min-w-0">
		{@render tileButton(tiles.reference)}
	</div>
</div>

{#if tab === 'cms'}
	<div
		role="tabpanel"
		id="integrations-panel-cms"
		aria-labelledby="integrations-tab-cms"
		class="flex flex-col gap-4"
	>
		<Card.Root>
			<Card.Header>
				<Card.Title>Обмен с сайтом</Card.Title>
				<Card.Description>
					Заявка с сайта приходит в CRM, а снимок её статуса уходит обратно в карточку заявки на
					сайте. Входящие принимаются ключом доступа роли «Внешняя система», исходящие CRM
					подписывает HMAC, как вебхуки. Журнал обмена в обе стороны — в разделе «Внешние системы».
				</Card.Description>
				{@render editButton(openCms)}
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				{@render inboundAddress('Входящий адрес заявок', applicationsUrl)}
				<dl class="grid gap-2 text-sm sm:grid-cols-2">
					<div>
						<dt class="text-muted-foreground">Экземпляр CMS</dt>
						<dd class="font-mono break-all">{data.exchange.cms.instance}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Адрес карточки заявки</dt>
						<dd class="break-all">
							{#if data.exchange.cms.statusUrl !== null}
								<span class="font-mono">{data.exchange.cms.statusUrl}</span>
							{:else}
								не задан — снимок статуса на сайт не уходит
							{/if}
						</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Секрет подписи</dt>
						<dd>{data.exchange.cms.hasSecret ? 'Задан' : 'Не задан'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Ответственный за входящие заявки</dt>
						<dd>{cmsOwner?.fullName ?? 'Не задан'}</dd>
					</div>
				</dl>
				{@render saved($cmsMessage)}
			</Card.Content>
		</Card.Root>
	</div>
{/if}

{#if tab === 'lms'}
	<div
		role="tabpanel"
		id="integrations-panel-lms"
		aria-labelledby="integrations-tab-lms"
		class="flex flex-col gap-4"
	>
		<Card.Root>
			<Card.Header>
				<Card.Title>Выгрузка из системы обучения</Card.Title>
				<Card.Description>
					Выгрузка по курсам и записанным слушателям становится снимком данных об обучении. В
					показатели он попадёт только после подтверждения человеком — в разделе «Данные об
					обучении».
				</Card.Description>
				{@render editButton(openLms)}
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
						>, токен веб-сервиса — <code class="font-mono">mock-lms-token</code>. Данные в нём
						выдуманы, и его ответ ничего не доказывает о настоящей LMS.
					</InlineHint>
				{/if}

				<dl class="grid gap-2 text-sm sm:grid-cols-2">
					<div>
						<dt class="text-muted-foreground">Адрес системы обучения</dt>
						<dd class="font-mono break-all">{data.lms.baseUrl ?? 'не задан'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Токен веб-сервиса</dt>
						<dd>{data.lms.hasToken ? 'Задан' : 'Не задан'}</dd>
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

				{@render saved($lmsMessage)}

				<div class="flex flex-col gap-2 border-t border-border pt-4">
					<form method="POST" action="?tab=lms&/sync">
						<Button
							type="submit"
							variant={data.lms.hasToken ? 'default' : 'outline'}
							disabled={!data.lms.hasToken}
						>
							<RefreshCwIcon aria-hidden="true" />
							Синхронизировать сейчас
						</Button>
					</form>
					{#if !data.lms.hasToken}
						<p class="text-xs text-muted-foreground">
							Синхронизация станет доступна, когда будут заданы адрес и токен.
						</p>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Обмен учебными группами</Card.Title>
				<Card.Description>
					Заявка на учебную группу уходит в систему обучения по кнопке из карточки взаимодействия, а
					результат потока приходит обратно. Входящие принимаются ключом доступа роли «Внешняя
					система», исходящие CRM подписывает HMAC.
				</Card.Description>
				{@render editButton(openGroups)}
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				{@render inboundAddress('Входящий адрес результатов потока', resultsUrl)}
				<dl class="grid gap-2 text-sm sm:grid-cols-2">
					<div>
						<dt class="text-muted-foreground">Экземпляр системы обучения</dt>
						<dd class="font-mono break-all">{data.exchange.lms.instance}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Адрес заведения учебной группы</dt>
						<dd class="break-all">
							{#if data.exchange.lms.groupsUrl !== null}
								<span class="font-mono">{data.exchange.lms.groupsUrl}</span>
							{:else}
								не задан — заявку на группу отправить нельзя
							{/if}
						</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Секрет подписи</dt>
						<dd>{data.exchange.lms.hasSecret ? 'Задан' : 'Не задан'}</dd>
					</div>
				</dl>
				{@render saved($groupsMessage)}
			</Card.Content>
		</Card.Root>
	</div>
{/if}

{#if tab === 'webhooks'}
	<div
		role="tabpanel"
		id="integrations-panel-webhooks"
		aria-labelledby="integrations-tab-webhooks"
		class="flex flex-col gap-4"
	>
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
						Подписок ещё нет. Создайте первую, когда внешней системе понадобится узнавать о событиях
						без опроса API.
					</p>
				{/if}

				{#each data.webhooks as subscription (subscription.id)}
					<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
						<header class="flex flex-wrap items-start justify-between gap-2">
							<div class="flex min-w-0 flex-col gap-1">
								<div class="flex items-center gap-2">
									<h2 class="section-title">{subscription.name}</h2>
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
								<form method="POST" action="?tab=webhooks&/test">
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
				{@render editButton(openDelivery)}
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<dl class="text-sm">
					<dt class="text-muted-foreground">Интервал, секунд</dt>
					<dd class="font-mono">{data.deliveryForm.data.intervalSeconds}</dd>
				</dl>
				{@render saved($deliveryMessage)}
			</Card.Content>
		</Card.Root>
	</div>
{/if}

{#if tab === 'reference'}
	<div
		role="tabpanel"
		id="integrations-panel-reference"
		aria-labelledby="integrations-tab-reference"
		class="flex flex-col gap-4"
	>
		<!-- `id="dadata"` — якорь: на панель ссылаются общие настройки и справка. -->
		<Card.Root id="dadata">
			<Card.Header>
				<Card.Title>Dadata</Card.Title>
				<Card.Description>
					Поиск реквизитов организации в ЕГРЮЛ по названию или ИНН. Здесь — ключ API подсказок и
					адрес сервиса. Ключ целиком не показывается никогда — только последние четыре знака.
				</Card.Description>
				{@render editButton(openDadata)}
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<dl class="grid gap-2 text-sm sm:grid-cols-2">
					<div>
						<dt class="text-muted-foreground">Ключ API</dt>
						<dd>
							{#if data.dadata.keyMask !== null}
								<span class="font-mono">{data.dadata.keyMask}</span>,
							{/if}
							{DADATA_KEY_SOURCE_LABELS[data.dadata.keySource]}
						</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Адрес сервиса</dt>
						<dd>
							<span class="font-mono break-all">{data.dadata.baseUrl}</span>
							{data.dadata.customBaseUrl ? '(свой)' : '(облачный)'}
						</dd>
					</div>
				</dl>

				<Alert.Root>
					<Alert.Description>
						По умолчанию система работает с облачной Dadata — ей нужен выход в интернет. Для
						закрытого контура можно настроить коробочную версию: она ставится на серверы заказчика,
						а её внутренний адрес указывают в поле «Адрес сервиса». Коробочная версия платная и
						приобретается у Dadata отдельно; демо-стенд работает только с облачной на бесплатном
						тарифе.
					</Alert.Description>
				</Alert.Root>

				{#if data.dadata.keySource === 'settings' && data.dadata.environmentKey}
					<p class="text-xs text-muted-foreground">
						В окружении сервера тоже есть ключ: ключ из интерфейса его перекрывает, а после удаления
						снова начнёт действовать ключ окружения с облачным адресом.
					</p>
				{/if}

				{@render saved($dadataMessage)}
			</Card.Content>
		</Card.Root>

		<p class="text-sm text-muted-foreground">
			Сам поиск включается флагом «Внешние источники», там же задаётся суточная квота обращений — в
			<a
				class="underline underline-offset-2"
				href="{resolve('/(app)/settings/general')}#external-sources">общих настройках</a
			>.
		</p>
	</div>
{/if}

<FormDialog
	bind:open={cmsOpen}
	width="xl"
	title="Обмен с сайтом"
	description="Пустой адрес карточки заявки выключает отправку статуса на сайт. Пустое поле секрета оставит прежний."
>
	{@render formErrors($cmsErrors._errors)}

	<form
		id="exchange-cms-form"
		method="POST"
		action="?/exchangeCms"
		use:cmsEnhance
		novalidate
		class="flex flex-col gap-4"
	>
		<FieldInput
			name="cmsInstance"
			label="Экземпляр CMS"
			description="Имя подключения: с ним сверяется source.instance входящего сообщения"
			placeholder="itschool-site"
			bind:value={$cms.cmsInstance}
			errors={$cmsErrors.cmsInstance}
		/>
		<FieldInput
			name="cmsStatusUrl"
			label="Адрес карточки заявки"
			description="Содержит фигурные скобки с externalId — на их место встаёт ключ заявки"
			placeholder="https://site.example.org/api/applications/{'{externalId}'}/status"
			bind:value={$cms.cmsStatusUrl}
			errors={$cmsErrors.cmsStatusUrl}
		/>
		<FieldInput
			name="cmsSecret"
			label="Секрет подписи для CMS"
			description={data.exchange.cms.hasSecret
				? 'Секрет сохранён. Пустое поле оставит прежний'
				: 'Им подписываются исходящие сообщения; после сохранения показан не будет'}
			placeholder={data.exchange.cms.hasSecret ? '••••••••' : 'Секрет'}
			bind:value={() => $cms.cmsSecret ?? '', (next) => ($cms.cmsSecret = next.trim() || null)}
			errors={$cmsErrors.cmsSecret}
		/>
		<FieldSelect
			name="cmsDefaultOwnerUserId"
			label="Ответственный за входящие заявки"
			description="Сотрудник, который принимает заявки с сайта и ведёт их дальше"
			placeholder="Не задан"
			options={data.owners.map((owner) => ({ value: owner.id, label: owner.fullName }))}
			bind:value={
				() => $cms.cmsDefaultOwnerUserId ?? '',
				(next) => ($cms.cmsDefaultOwnerUserId = next === '' ? null : next)
			}
			errors={$cmsErrors.cmsDefaultOwnerUserId}
		/>
	</form>

	{#snippet footer({ close })}
		<FormActions
			form="exchange-cms-form"
			submitting={$cmsSubmitting}
			submitLabel="Сохранить"
			oncancel={close}
			class="border-t-0 pt-0"
		/>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={lmsOpen}
	title="Выгрузка из системы обучения"
	description="Адрес и токен веб-сервиса Moodle. Пустое поле токена оставит прежний."
>
	{@render formErrors($lmsErrors._errors)}

	<form
		id="lms-form"
		method="POST"
		action="?/lms"
		use:lmsEnhance
		novalidate
		class="flex flex-col gap-4"
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
		<Label class="flex items-center gap-2 font-normal">
			<Checkbox name="enabled" bind:checked={$lms.enabled} />
			Забирать выгрузку по расписанию
		</Label>
	</form>

	{#if data.lms.hasToken}
		<form method="POST" action="?tab=lms&/forgetToken" class="mt-4 border-t border-border pt-4">
			<Button type="submit" variant="outline">Забыть токен</Button>
		</form>
	{/if}

	{#snippet footer({ close })}
		<FormActions
			form="lms-form"
			submitting={$lmsSubmitting}
			submitLabel="Сохранить"
			oncancel={close}
			class="border-t-0 pt-0"
		/>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={groupsOpen}
	title="Обмен учебными группами"
	description="Пустой адрес выключает отправку заявок на учебную группу. Пустое поле секрета оставит прежний."
>
	{@render formErrors($groupsErrors._errors)}

	<form
		id="exchange-lms-form"
		method="POST"
		action="?/exchangeLms"
		use:groupsEnhance
		novalidate
		class="flex flex-col gap-4"
	>
		<FieldInput
			name="lmsInstance"
			label="Экземпляр системы обучения"
			description="Имя подключения: с ним сверяется source.instance результата группы"
			placeholder="moodle-itschool"
			bind:value={$groups.lmsInstance}
			errors={$groupsErrors.lmsInstance}
		/>
		<FieldInput
			name="lmsGroupsUrl"
			label="Адрес заведения учебной группы"
			description="Туда уходит заявка на поток по кнопке из карточки взаимодействия"
			placeholder="https://lms.example.org/api/groups"
			bind:value={$groups.lmsGroupsUrl}
			errors={$groupsErrors.lmsGroupsUrl}
		/>
		<FieldInput
			name="lmsSecret"
			label="Секрет подписи для системы обучения"
			description={data.exchange.lms.hasSecret
				? 'Секрет сохранён. Пустое поле оставит прежний'
				: 'Им подписывается заявка на учебную группу; после сохранения показан не будет'}
			placeholder={data.exchange.lms.hasSecret ? '••••••••' : 'Секрет'}
			bind:value={
				() => $groups.lmsSecret ?? '', (next) => ($groups.lmsSecret = next.trim() || null)
			}
			errors={$groupsErrors.lmsSecret}
		/>
	</form>

	{#snippet footer({ close })}
		<FormActions
			form="exchange-lms-form"
			submitting={$groupsSubmitting}
			submitLabel="Сохранить"
			oncancel={close}
			class="border-t-0 pt-0"
		/>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={deliveryOpen}
	title="Периодичность доставки"
	description="Как часто фоновый цикл дочитывает журнал в подписки."
>
	{@render formErrors($deliveryErrors._errors)}

	<form
		id="delivery-form"
		method="POST"
		action="?/delivery"
		use:deliveryEnhance
		novalidate
		class="flex flex-col gap-4"
	>
		{@render numberField({
			name: 'intervalSeconds',
			label: 'Интервал, секунд',
			value: $delivery.intervalSeconds,
			errors: $deliveryErrors.intervalSeconds,
			onchange: (next) => ($delivery.intervalSeconds = next)
		})}
	</form>

	{#snippet footer({ close })}
		<FormActions
			form="delivery-form"
			submitting={$deliverySubmitting}
			submitLabel="Сохранить"
			oncancel={close}
			class="border-t-0 pt-0"
		/>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={dadataOpen}
	title="Подключение к Dadata"
	description="Пустой адрес — облачный сервис. Свой адрес нужен коробочной версии в сети заказчика и сохраняется только вместе с ключом."
>
	{@render formErrors($dadataErrors._errors)}

	<form
		id="dadata-form"
		method="POST"
		action="?/dadata"
		use:dadataEnhance
		novalidate
		class="flex flex-col gap-4"
	>
		<FieldInput
			name="apiKey"
			label="Ключ API"
			description={data.dadata.keySource === 'settings'
				? 'Ключ сохранён. Пустое поле оставит прежний'
				: 'API key из личного кабинета Dadata; после сохранения показан не будет'}
			placeholder={data.dadata.keyMask ?? 'Ключ API'}
			bind:value={() => $dadata.apiKey ?? '', (next) => ($dadata.apiKey = next.trim() || null)}
			errors={$dadataErrors.apiKey}
		/>
		<FieldInput
			name="baseUrl"
			label="Адрес сервиса"
			description="Для коробочной версии — её внутренний адрес по https"
			placeholder={DADATA_CLOUD_ORIGIN}
			bind:value={$dadata.baseUrl}
			errors={$dadataErrors.baseUrl}
		/>
	</form>

	{#if data.dadata.keySource === 'settings'}
		<form
			method="POST"
			action="?tab=reference&/forgetDadataKey"
			class="mt-4 border-t border-border pt-4"
		>
			<Button type="submit" variant="outline">Удалить ключ</Button>
		</form>
	{/if}

	{#snippet footer({ close })}
		<FormActions
			form="dadata-form"
			submitting={$dadataSubmitting}
			submitLabel="Сохранить"
			oncancel={close}
			class="border-t-0 pt-0"
		/>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={editorOpen}
	width="xl"
	title={$webhook.id === null ? 'Создать подписку' : 'Подписка'}
	description="Адрес принимает POST с телом события. По http принимает только адрес на этой же машине — остальным нужен https."
>
	{#if $webhookErrors._errors}
		<Alert.Root variant="destructive" class="mb-4">
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
		id="webhook-form"
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
	</form>

	{#snippet footer({ close })}
		<FormActions
			form="webhook-form"
			submitting={$webhookSubmitting}
			submitLabel={$webhook.id === null ? 'Создать подписку' : 'Сохранить'}
			oncancel={close}
			class="border-t-0 pt-0"
		/>
	{/snippet}
</FormDialog>

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
				onclick={() => copyText(issued?.secret ?? '', 'Секрет скопирован')}
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
