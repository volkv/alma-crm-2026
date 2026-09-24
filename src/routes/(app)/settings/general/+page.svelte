<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import FormField from '$lib/components/form/form-field.svelte';
	import { settingSchemas } from '$lib/contracts/settings';
	import { NOTIFICATION_CHANNEL_LABELS } from '$lib/contracts/notifications';
	import {
		demoScheduleSchema,
		enrichmentSchema,
		sessionLimitsSchema,
		stuckWatchSchema
	} from './schema';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	/**
	 * Отказ по правам приходит обычным `fail`, мимо superforms: у него нет поля,
	 * к которому его можно отнести, и правкой полей он не поправляется. Показать
	 * его всё равно надо — страница открыта, а сохранение уже не проходит.
	 */
	const refusal = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);

	/** Сохранённая настройка — повод для тоста, а не для ещё одной строки на странице. */
	function notifySaved(updated: { message?: unknown }) {
		if (typeof updated.message === 'string') {
			toast.success(updated.message);
		}
	}

	const {
		form: bannerData,
		errors: bannerErrors,
		enhance: bannerEnhance,
		submitting: bannerSubmitting
	} = superForm(
		untrack(() => data.bannerForm),
		{
			validators: zod4Client(settingSchemas.login_banner),
			onUpdated: ({ form }) => notifySaved(form)
		}
	);

	const {
		form: sessionData,
		errors: sessionErrors,
		enhance: sessionEnhance,
		submitting: sessionSubmitting
	} = superForm(
		untrack(() => data.sessionForm),
		{ validators: zod4Client(sessionLimitsSchema), onUpdated: ({ form }) => notifySaved(form) }
	);

	const {
		form: stuckData,
		errors: stuckErrors,
		enhance: stuckEnhance,
		submitting: stuckSubmitting
	} = superForm(
		untrack(() => data.stuckWatchForm),
		{ validators: zod4Client(stuckWatchSchema), onUpdated: ({ form }) => notifySaved(form) }
	);

	const {
		form: demoScheduleData,
		errors: demoScheduleErrors,
		enhance: demoScheduleEnhance,
		submitting: demoScheduleSubmitting
	} = superForm(
		untrack(() => data.demoScheduleForm),
		{ validators: zod4Client(demoScheduleSchema), onUpdated: ({ form }) => notifySaved(form) }
	);

	const {
		form: enrichmentData,
		errors: enrichmentErrors,
		enhance: enrichmentEnhance,
		submitting: enrichmentSubmitting
	} = superForm(
		untrack(() => data.enrichmentForm),
		{ validators: zod4Client(enrichmentSchema), onUpdated: ({ form }) => notifySaved(form) }
	);

	let resetConfirmOpen = $state(false);
	let resetForm = $state<HTMLFormElement | null>(null);

	/**
	 * Диалог подтверждения ждёт, пока сброс действительно закончится: он длится
	 * секунды, и закрыть его сразу значило бы вернуть страницу, на которой ничего
	 * не происходит. `ConfirmDialog` держит себя открытым, пока не разрешится
	 * обещание `onconfirm`, — разрешает его ответ формы.
	 */
	let finishReset: (() => void) | null = null;

	function submitReset(): Promise<void> {
		return new Promise((resolve) => {
			finishReset = resolve;
			resetForm?.requestSubmit();
		});
	}
</script>

<svelte:head>
	<title>Общие настройки — LCT CRM</title>
</svelte:head>

{#if refusal}
	<Alert.Root variant="destructive">
		<Alert.Title>Настройка не сохранена</Alert.Title>
		<Alert.Description>{refusal}</Alert.Description>
	</Alert.Root>
{/if}

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
	description: string;
	value: number;
	errors: string[] | undefined;
	onchange: (next: number) => void;
})}
	<FormField {name} {label} {description} {errors} required>
		{#snippet control({ id, describedBy, invalid })}
			<!-- Пустое поле даёт NaN, и схема скажет об этом словами; подменять его
				нулём нельзя — ноль здесь означал бы настоящую настройку. -->
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

<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
<Card.Root data-tour="general-banner">
	<Card.Header>
		<Card.Title>Страница входа</Card.Title>
		<Card.Description>
			Заголовок и текст над формой входа: кому система предназначена и куда обращаться за доступом.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{@render formErrors($bannerErrors._errors)}
		<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
		<form method="POST" action="?/banner" use:bannerEnhance novalidate class="flex flex-col gap-4">
			<FieldInput
				name="title"
				label="Заголовок"
				required
				bind:value={$bannerData.title}
				errors={$bannerErrors.title}
			/>
			<FieldTextarea
				name="text"
				label="Текст"
				description="Не длиннее 2000 символов; можно оставить пустым."
				rows={3}
				bind:value={$bannerData.text}
				errors={$bannerErrors.text}
			/>
			<FormActions submitting={$bannerSubmitting} submitLabel="Сохранить баннер" />
		</form>
	</Card.Content>
</Card.Root>

<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
<Card.Root data-tour="general-sessions">
	<Card.Header>
		<Card.Title>Сроки жизни сессии</Card.Title>
		<Card.Description>
			Сессия кончается по тому сроку, который наступит раньше. Правка действует на новые сессии и на
			продление уже открытых.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{@render formErrors($sessionErrors._errors)}
		<form
			method="POST"
			action="?/session"
			use:sessionEnhance
			novalidate
			class="flex flex-col gap-4"
		>
			<div class="grid gap-4 sm:grid-cols-2">
				{@render numberField({
					name: 'idleMinutes',
					label: 'Бездействие, минут',
					description: 'От 5 до 240',
					value: $sessionData.idleMinutes,
					errors: $sessionErrors.idleMinutes,
					onchange: (next) => ($sessionData.idleMinutes = next)
				})}
				{@render numberField({
					name: 'absoluteHours',
					label: 'Предельный срок, часов',
					description: 'От 1 до 72',
					value: $sessionData.absoluteHours,
					errors: $sessionErrors.absoluteHours,
					onchange: (next) => ($sessionData.absoluteHours = next)
				})}
			</div>
			<FormActions submitting={$sessionSubmitting} submitLabel="Сохранить сроки" />
		</form>
	</Card.Content>
</Card.Root>

<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
<Card.Root data-tour="general-stuck">
	<Card.Header>
		<Card.Title>Напоминания: зависшие взаимодействия, сроки лицензий и утренняя сводка</Card.Title>
		<Card.Description>
			Взаимодействие, которое стоит на одной стадии дольше порога, вызывает напоминание руководителю
			ответственного. Время пауз в этот срок не входит: ждать ответа вуза и стоять — разные вещи.
			Ноль означает «напоминать сразу»; повтор в любом случае не чаще раза в сутки, пока стадия не
			сменится. Лицензия по позиции договора, срок которой кончается в пределах окна или уже прошёл,
			вызывает напоминание ответственному за вуз (одно на позицию, пока срок не изменят), а истёкшая
			— ещё и эскалацию его руководителю. Утренняя сводка «Мой день» раз в сутки напоминает каждому
			сотруднику, что у него на сегодня: просрочки, близкие сроки, помехи, ожидание, лицензии и
			новые заявки. Что и кому ушло, видно в разделе
			<a class="underline underline-offset-4" href={resolve('/notifications')}>«Уведомления»</a>.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{@render formErrors($stuckErrors._errors)}
		<form
			method="POST"
			action="?/stuckWatch"
			use:stuckEnhance
			novalidate
			class="flex flex-col gap-4"
		>
			<div class="grid gap-4 sm:grid-cols-2">
				{@render numberField({
					name: 'thresholdDays',
					label: 'Порог зависания, дней',
					description: 'От 0 до 365',
					value: $stuckData.thresholdDays,
					errors: $stuckErrors.thresholdDays,
					onchange: (next) => ($stuckData.thresholdDays = next)
				})}
				{@render numberField({
					name: 'licenseWarningDays',
					label: 'Окно продления лицензии, дней',
					description: 'От 0 до 365; 0 — только об истёкших',
					value: $stuckData.licenseWarningDays,
					errors: $stuckErrors.licenseWarningDays,
					onchange: (next) => ($stuckData.licenseWarningDays = next)
				})}
			</div>
			<div class="flex flex-col gap-2">
				<Label class="flex items-center gap-2 font-normal">
					<Checkbox name="digestEnabled" bind:checked={$stuckData.digestEnabled} />
					Присылать утреннюю сводку «Мой день»
				</Label>
				<div class="grid gap-4 sm:grid-cols-2">
					{@render numberField({
						name: 'digestHour',
						label: 'Час сводки',
						description: 'От 0 до 23, по Москве',
						value: $stuckData.digestHour,
						errors: $stuckErrors.digestHour,
						onchange: (next) => ($stuckData.digestHour = next)
					})}
				</div>
				<p class="text-xs text-muted-foreground">
					Одна сводка на сотрудника, день и канал; у кого на сегодня дел нет, тому она не приходит.
					Приложение, которое в этот час не работало, отправит сводку первым проходом после.
				</p>
			</div>
			<fieldset class="flex flex-col gap-2">
				<legend class="text-sm font-medium">Каналы</legend>
				<Label class="flex items-center gap-2 font-normal">
					<Checkbox name="email" bind:checked={$stuckData.email} />
					{NOTIFICATION_CHANNEL_LABELS.email}
				</Label>
				<Label class="flex items-center gap-2 font-normal">
					<Checkbox name="telegram" bind:checked={$stuckData.telegram} />
					{NOTIFICATION_CHANNEL_LABELS.telegram}
				</Label>
				<Label class="flex items-center gap-2 font-normal">
					<Checkbox name="max" bind:checked={$stuckData.max} />
					{NOTIFICATION_CHANNEL_LABELS.max}
				</Label>
				<p class="text-xs text-muted-foreground">
					Telegram и MAX — заглушки функционала: строка в журнале доставок появляется, реальная
					отправка не выполняется. Почта отправляет по-настоящему, через почтовый сервер из
					<code>SMTP_URL</code>.
				</p>
			</fieldset>
			<FormActions submitting={$stuckSubmitting} submitLabel="Сохранить правило" />
		</form>
	</Card.Content>
</Card.Root>

<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
<Card.Root data-tour="general-enrichment">
	<Card.Header>
		<Card.Title>Внешние источники паспорта организации</Card.Title>
		<Card.Description>
			Поиск реквизитов в ЕГРЮЛ через Dadata и чтение раздела «Сведения об образовательной
			организации» на сайте вуза из формы организации. Сервер ходит только на адрес Dadata и на
			домен сайта из карточки; ничего не записывается без подтверждения сотрудника. Выключено —
			карточку заполняют вручную или снимком JSON.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{@render formErrors($enrichmentErrors._errors)}
		<form
			method="POST"
			action="?/enrichment"
			use:enrichmentEnhance
			novalidate
			class="flex flex-col gap-4"
		>
			<Label class="flex items-center gap-2 font-normal">
				<Checkbox name="enabled" bind:checked={$enrichmentData.enabled} />
				Разрешить обращения к внешним источникам
			</Label>
			<div class="grid gap-4 sm:grid-cols-2">
				{@render numberField({
					name: 'dailyQuota',
					label: 'Обращений на сотрудника в сутки',
					description: 'От 1 до 1000; ответ из кэша квоту не тратит',
					value: $enrichmentData.dailyQuota,
					errors: $enrichmentErrors.dailyQuota,
					onchange: (next) => ($enrichmentData.dailyQuota = next)
				})}
			</div>
			{#if !data.dadataConfigured}
				<p class="text-xs text-muted-foreground">
					Ключ Dadata не задан (<code>DADATA_API_KEY</code>): при включённых источниках читается
					только раздел «Сведения» на сайтах вузов.
				</p>
			{/if}
			<FormActions submitting={$enrichmentSubmitting} submitLabel="Сохранить" />
		</form>
	</Card.Content>
</Card.Root>

<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
<Card.Root data-tour="general-demo">
	<Card.Header>
		<Card.Title>Демо-данные</Card.Title>
		<Card.Description>
			Сброс возвращает стенд к тому набору, с которым он поставляется: взаимодействия, документы,
			справочник и данные об обучении заливаются заново. Учётные записи, роли, описание процесса и
			журнал действий остаются. Кнопкой — сейчас, расписанием — каждую ночь: стенд общий, и показ
			начинается с эталонного набора, кто бы что на нём вчера ни наработал.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-2">
		<!-- Недоступную команду не прячем: пропавшая кнопка не объясняет, куда она
			делась. Первичный вид — только у той, что действительно нажимается. -->
		<div>
			<Button
				variant={data.demoMode ? 'destructive' : 'outline'}
				disabled={!data.demoMode}
				onclick={() => (resetConfirmOpen = true)}
			>
				<RotateCcwIcon aria-hidden="true" />
				Сбросить демо-данные
			</Button>
		</div>
		{#if !data.demoMode}
			<p class="text-xs text-muted-foreground">
				Установка работает не в демонстрационном режиме: данные в ней принадлежат организации, а
				эталона, к которому их возвращать, нет. Ни кнопки, ни расписания здесь поэтому нет — и то и
				другое включается переменной окружения <code>DEMO_MODE</code>.
			</p>
		{:else}
			<p class="text-xs text-muted-foreground">
				Всё, что наработали на стенде за время показа, пропадёт: пройденные стадии, комментарии,
				загруженные файлы и правки справочника.
			</p>

			{@render formErrors($demoScheduleErrors._errors)}
			<form
				method="POST"
				action="?/demoSchedule"
				use:demoScheduleEnhance
				novalidate
				class="flex flex-col gap-4 border-t border-border pt-4"
			>
				<Label class="flex items-center gap-2 font-normal">
					<Checkbox name="enabled" bind:checked={$demoScheduleData.enabled} />
					Сбрасывать стенд ежедневно
				</Label>
				<div class="grid gap-4 sm:grid-cols-2">
					{@render numberField({
						name: 'hour',
						label: 'Час сброса',
						description: 'От 0 до 23, по часам сервера',
						value: $demoScheduleData.hour,
						errors: $demoScheduleErrors.hour,
						onchange: (next) => ($demoScheduleData.hour = next)
					})}
				</div>
				<p class="text-xs text-muted-foreground">
					Сброс проходит один раз в сутки, не раньше назначенного часа: приложение, которое в этот
					час не работало, сбросит стенд при первой возможности. Пока расписание включено, об этом
					сказано полосой демо-режима на каждой странице.
				</p>
				<FormActions submitting={$demoScheduleSubmitting} submitLabel="Сохранить расписание" />
			</form>
		{/if}
	</Card.Content>
</Card.Root>

<ConfirmDialog
	bind:open={resetConfirmOpen}
	title="Сбросить демонстрационные данные?"
	description="Взаимодействия, документы, справочник и данные об обучении будут стёрты и залиты заново из поставки. Вернуть наработанное на стенде нельзя. Учётные записи, роли, описание процесса и журнал действий останутся."
	confirmLabel="Сбросить демо-данные"
	tone="danger"
	onconfirm={submitReset}
/>

<!-- Диалог только подтверждает; отправляет обычная форма — действие одно на все
	пути. `enhance` здесь нужен ради ответа: по нему закрывается диалог и
	поднимается тост. -->
<form
	method="POST"
	action="?/demoReset"
	bind:this={resetForm}
	class="hidden"
	use:enhance={() =>
		async ({ result, update }) => {
			await update({ reset: false });

			if (result.type === 'success' && typeof result.data?.demoReset === 'string') {
				toast.success(result.data.demoReset);
			}

			// Отказ показывает общий блок над карточками: у него нет поля, к
			// которому его можно отнести.
			finishReset?.();
			finishReset = null;
		}}
></form>
