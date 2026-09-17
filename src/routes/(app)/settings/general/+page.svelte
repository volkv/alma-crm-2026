<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import FormField from '$lib/components/form/form-field.svelte';
	import { settingSchemas } from '$lib/contracts/settings';
	import { sessionLimitsSchema } from './schema';
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

<Card.Root>
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

<Card.Root>
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

<Card.Root>
	<Card.Header>
		<Card.Title>Демо-данные</Card.Title>
		<Card.Description>
			Сброс возвращает стенд к тому набору, с которым он поставляется: взаимодействия, документы,
			справочник и данные об обучении заливаются заново. Учётные записи, роли, описание процесса и
			журнал действий остаются.
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
				эталона, к которому их возвращать, нет. Сброс включается переменной окружения
				<code>DEMO_MODE</code>.
			</p>
		{:else}
			<p class="text-xs text-muted-foreground">
				Всё, что наработали на стенде за время показа, пропадёт: пройденные стадии, комментарии,
				загруженные файлы и правки справочника.
			</p>
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
