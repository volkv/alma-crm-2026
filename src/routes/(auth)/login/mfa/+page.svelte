<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import BackupCodes from '$lib/components/auth/backup-codes.svelte';
	import TotpEnrollment from '$lib/components/auth/totp-enrollment.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import { secondFactorSchema, totpCodeSchema } from '$lib/contracts/auth';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	/**
	 * Резервные коды приходят рядом с формой, а не внутри неё: показать их надо
	 * один раз и сразу после регистрации, а формой они не являются.
	 */
	const backupCodes = $derived(
		actionResult !== null && 'backupCodes' in actionResult
			? (actionResult.backupCodes ?? null)
			: null
	);

	/** Отказ действия «Продолжить» приходит обычным `fail`, мимо superforms. */
	const refusal = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);

	const { form, errors, enhance, submitting, message } = superForm(
		untrack(() => data.form),
		{
			// Вид шага за время жизни страницы не меняется: он решён загрузчиком, а
			// смена вида — это новая загрузка.
			validators: zod4Client(
				untrack(() => (data.mode === 'enroll' ? totpCodeSchema : secondFactorSchema))
			)
		}
	);

	/**
	 * Отправка на именованное действие теряет строку запроса, а в ней приезжает
	 * `next` — страница, с которой человека развернули на вход.
	 */
	const query = $derived(page.url.searchParams.toString());
	const action = $derived((name: string) => (query === '' ? `?/${name}` : `?/${name}&${query}`));
</script>

<svelte:head>
	<title>Подтверждение входа — LCT CRM</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<h1 class="text-lg leading-snug font-semibold tracking-tight">
			{data.mode === 'enroll' ? 'Подключение второго фактора' : 'Подтверждение входа'}
		</h1>
		<Card.Description>
			{#if data.mode === 'enroll'}
				Для вашей роли вход защищён одноразовым кодом. Подключите приложение — без этого система не
				откроется.
			{:else}
				Введите код из приложения для учётной записи {data.account.email}.
			{/if}
		</Card.Description>
	</Card.Header>

	<Card.Content class="flex flex-col gap-4">
		{#if refusal}
			<Alert.Root variant="destructive">
				<Alert.Description>{refusal}</Alert.Description>
			</Alert.Root>
		{/if}

		{#if $message}
			<Alert.Root variant="destructive">
				<Alert.Description>{$message}</Alert.Description>
			</Alert.Root>
		{/if}

		{#if $errors._errors}
			<Alert.Root variant="destructive">
				<Alert.Description>
					<ul class="list-inside list-disc">
						{#each $errors._errors as issue (issue)}
							<li>{issue}</li>
						{/each}
					</ul>
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if backupCodes !== null}
			<!-- Регистрация закончена, но вход ещё нет: пока человек не подтвердил,
			     что записал коды, сессия остаётся неполной. -->
			<BackupCodes codes={backupCodes} />

			<form method="POST" action={action('finish')}>
				<FormActions submitLabel="Я записал коды, продолжить" />
			</form>
		{:else if data.mode === 'enroll' && data.enrollment !== null}
			<TotpEnrollment uri={data.enrollment.uri} secret={data.enrollment.secret} />

			<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
			<form
				method="POST"
				action={action('enroll')}
				use:enhance
				novalidate
				class="flex flex-col gap-4"
			>
				<FieldInput
					name="code"
					label="Код из приложения"
					description="Шесть цифр; они меняются каждые 30 секунд"
					required
					placeholder="000000"
					bind:value={$form.code}
					errors={$errors.code}
				/>
				<FormActions submitting={$submitting} submitLabel="Подключить" />
			</form>
		{:else}
			<form
				method="POST"
				action={action('verify')}
				use:enhance
				novalidate
				class="flex flex-col gap-4"
			>
				<FieldInput
					name="code"
					label="Код или резервный код"
					description="Шесть цифр из приложения — или один из резервных кодов, если приложения нет под рукой"
					required
					placeholder="000000"
					bind:value={$form.code}
					errors={$errors.code}
				/>
				<FormActions submitting={$submitting} submitLabel="Подтвердить" />
			</form>

			<p class="text-xs text-muted-foreground">
				Резервных кодов выдаётся {data.backupCodeCount}, каждый работает один раз. Если не осталось
				ни приложения, ни кодов, фактор сбросит администратор.
			</p>
		{/if}
	</Card.Content>
</Card.Root>
