<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import FormField from '$lib/components/form/form-field.svelte';
	import { settingSchemas } from '$lib/contracts/settings';
	import { mfaPolicySchema, sessionLimitsSchema } from './schema';
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
		form: passwordData,
		errors: passwordErrors,
		enhance: passwordEnhance,
		submitting: passwordSubmitting
	} = superForm(
		untrack(() => data.passwordForm),
		{
			validators: zod4Client(settingSchemas.password_policy),
			onUpdated: ({ form }) => notifySaved(form)
		}
	);

	const {
		form: lockoutData,
		errors: lockoutErrors,
		enhance: lockoutEnhance,
		submitting: lockoutSubmitting
	} = superForm(
		untrack(() => data.lockoutForm),
		{
			validators: zod4Client(settingSchemas.lockout_policy),
			onUpdated: ({ form }) => notifySaved(form)
		}
	);

	const {
		form: mfaData,
		errors: mfaErrors,
		enhance: mfaEnhance,
		submitting: mfaSubmitting
	} = superForm(
		untrack(() => data.mfaForm),
		{
			validators: zod4Client(mfaPolicySchema),
			// Список ролей — массив, и обычной формой он не едет.
			dataType: 'json',
			onUpdated: ({ form }) => notifySaved(form)
		}
	);

	/** Включает и выключает роль в списке обязательных. */
	function toggleRole(roleId: string, required: boolean) {
		$mfaData.requiredForRoles = required
			? [...$mfaData.requiredForRoles, roleId]
			: $mfaData.requiredForRoles.filter((id) => id !== roleId);
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
		<Card.Title>Политика паролей</Card.Title>
		<Card.Description>
			Требования проверяются при установке пароля. Уже заведённые пароли остаются рабочими:
			ужесточение политики не запирает людей снаружи.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{@render formErrors($passwordErrors._errors)}
		<form
			method="POST"
			action="?/password"
			use:passwordEnhance
			novalidate
			class="flex flex-col gap-4"
		>
			<div class="grid gap-4 sm:grid-cols-2">
				{@render numberField({
					name: 'minLength',
					label: 'Минимальная длина',
					description: 'От 8 до 128 символов',
					value: $passwordData.minLength,
					errors: $passwordErrors.minLength,
					onchange: (next) => ($passwordData.minLength = next)
				})}
				{@render numberField({
					name: 'minClasses',
					label: 'Классов символов',
					description: 'Из четырёх: строчные, прописные, цифры, знаки',
					value: $passwordData.minClasses,
					errors: $passwordErrors.minClasses,
					onchange: (next) => ($passwordData.minClasses = next)
				})}
			</div>
			<FormActions submitting={$passwordSubmitting} submitLabel="Сохранить политику" />
		</form>
	</Card.Content>
</Card.Root>

<Card.Root>
	<Card.Header>
		<Card.Title>Блокировка после неудачных входов</Card.Title>
		<Card.Description>
			Попытки считаются по паре «учётная запись и адрес». Демонстрационные записи не блокируются:
			чужая опечатка не должна закрывать вход остальным.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{@render formErrors($lockoutErrors._errors)}
		<form
			method="POST"
			action="?/lockout"
			use:lockoutEnhance
			novalidate
			class="flex flex-col gap-4"
		>
			<div class="grid gap-4 sm:grid-cols-2">
				{@render numberField({
					name: 'attempts',
					label: 'Попыток до блокировки',
					description: 'От 1 до 20',
					value: $lockoutData.attempts,
					errors: $lockoutErrors.attempts,
					onchange: (next) => ($lockoutData.attempts = next)
				})}
				{@render numberField({
					name: 'minutes',
					label: 'Блокировка, минут',
					description: 'От 1 до 1440',
					value: $lockoutData.minutes,
					errors: $lockoutErrors.minutes,
					onchange: (next) => ($lockoutData.minutes = next)
				})}
			</div>
			<FormActions submitting={$lockoutSubmitting} submitLabel="Сохранить политику" />
		</form>
	</Card.Content>
</Card.Root>

<Card.Root>
	<Card.Header>
		<Card.Title>Второй фактор входа</Card.Title>
		<Card.Description>
			Одноразовый код из приложения-аутентификатора вдобавок к паролю. Роли из списка получают его
			принудительно: при следующем входе система попросит подключить приложение и до этого в систему
			не пустит. Остальные могут подключить фактор себе сами в профиле.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{@render formErrors($mfaErrors._errors)}
		<form method="POST" action="?/mfa" use:mfaEnhance novalidate class="flex flex-col gap-4">
			<fieldset class="flex flex-col gap-2">
				<legend class="text-sm font-medium">Роли, которым фактор обязателен</legend>
				{#each data.roles as role (role.id)}
					<Label class="flex items-center gap-2 font-normal">
						<Checkbox
							checked={$mfaData.requiredForRoles.includes(role.id)}
							onCheckedChange={(checked) => toggleRole(role.id, checked === true)}
						/>
						{role.name}
					</Label>
				{/each}
				{#if $mfaErrors.requiredForRoles}
					<p class="text-xs text-danger-soft-foreground">{$mfaErrors.requiredForRoles}</p>
				{/if}
			</fieldset>

			<Label class="flex items-start gap-3 font-normal">
				<Switch
					checked={$mfaData.remoteOnly}
					onCheckedChange={(checked) => ($mfaData.remoteOnly = checked)}
				/>
				<span class="flex flex-col gap-1">
					<span class="text-sm font-medium">Только при удалённом доступе</span>
					<span class="text-xs text-muted-foreground">
						Код спрашивается, когда адрес не попал ни в одну доверенную сеть. Пока список сетей
						пуст, удалённым считается любой адрес.
					</span>
				</span>
			</Label>

			<FieldTextarea
				name="trustedNetworks"
				label="Доверенные сети"
				description="По одной на строку, в виде 198.51.100.0/24 или 2001:db8::/32. Адрес — начало сети, а не адрес машины."
				rows={3}
				bind:value={$mfaData.trustedNetworks}
				errors={$mfaErrors.trustedNetworks}
			/>

			<FormActions submitting={$mfaSubmitting} submitLabel="Сохранить политику" />
		</form>
	</Card.Content>
</Card.Root>
