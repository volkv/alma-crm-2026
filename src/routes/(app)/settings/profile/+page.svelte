<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import BackupCodes from '$lib/components/auth/backup-codes.svelte';
	import TotpEnrollment from '$lib/components/auth/totp-enrollment.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { totpCodeSchema } from '$lib/contracts/auth';
	import { formatDateTime, pluralize } from '$lib/format';
	import { changePasswordSchema } from './schema';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	/** Отказ демонстрации приходит обычным `fail`, мимо superforms. */
	const refusal = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);

	/**
	 * Резервные коды — и только что выданные при подключении, и перевыпущенные.
	 * Показываются они один раз, поэтому приезжают рядом с формой, а не в ней.
	 */
	const backupCodes = $derived(
		actionResult !== null && 'backupCodes' in actionResult
			? (actionResult.backupCodes ?? null)
			: null
	);

	const { form, errors, enhance, submitting, message } = superForm(
		untrack(() => data.form),
		{ validators: zod4Client(changePasswordSchema) }
	);

	const {
		form: enrollData,
		errors: enrollErrors,
		enhance: enrollEnhance,
		submitting: enrollSubmitting
	} = superForm(
		untrack(() => data.enrollForm),
		{ validators: zod4Client(totpCodeSchema) }
	);

	const {
		form: disableData,
		errors: disableErrors,
		enhance: disableEnhance,
		submitting: disableSubmitting,
		message: disableMessage
	} = superForm(
		untrack(() => data.disableForm),
		{ validators: zod4Client(totpCodeSchema) }
	);

	const {
		form: codesData,
		errors: codesErrors,
		enhance: codesEnhance,
		submitting: codesSubmitting
	} = superForm(
		untrack(() => data.codesForm),
		{ validators: zod4Client(totpCodeSchema) }
	);

	/**
	 * Отправка на именованное действие теряет строку запроса, а в ней стоит
	 * `mfa=enroll` — признак начатой регистрации. Без него страница после
	 * неверного кода потеряла бы и QR-код, и поле, в которое его вводят.
	 */
	const enrollAction = $derived(
		page.url.searchParams.toString() === ''
			? '?/mfaEnroll'
			: `?/mfaEnroll&${page.url.searchParams.toString()}`
	);

	const policyHint = $derived(
		`Не короче ${pluralize(data.policy.minLength, ['символа', 'символов', 'символов'])}; ` +
			`минимум ${pluralize(data.policy.minClasses, ['вид', 'вида', 'видов'])} символов из четырёх: ` +
			'строчные буквы, прописные буквы, цифры, знаки'
	);
</script>

<svelte:head>
	<title>Профиль — LCT CRM</title>
</svelte:head>

{#if refusal}
	<Alert.Root variant="destructive">
		<Alert.Title>Действие не выполнено</Alert.Title>
		<Alert.Description>{refusal}</Alert.Description>
	</Alert.Root>
{/if}

{#if $message}
	<Alert.Root>
		<Alert.Title>{$message}</Alert.Title>
		<Alert.Description>
			Ссылки раздела больше не откроются: сессия завершена на этом устройстве и на всех остальных.
		</Alert.Description>
		<Alert.Action>
			<Button href={resolve('/login')} size="sm" data-sveltekit-reload>
				<LogInIcon aria-hidden="true" />
				Войти заново
			</Button>
		</Alert.Action>
	</Alert.Root>
{/if}

<Card.Root>
	<Card.Header>
		<Card.Title>Учётная запись</Card.Title>
	</Card.Header>
	<Card.Content>
		<KeyValue>
			<KeyValueRow label="Имя" value={data.account.fullName} />
			<KeyValueRow label="Рабочая почта" value={data.account.email} />
		</KeyValue>
	</Card.Content>
</Card.Root>

<Card.Root>
	<Card.Header>
		<Card.Title>Смена пароля</Card.Title>
		<Card.Description>
			После смены все сессии завершаются, включая текущую: если пароль меняют потому, что старый мог
			утечь, чужая открытая вкладка не должна пережить смену.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if data.isDemo}
			<InlineHint tone="warning">
				Учётная запись демонстрации общая: под ней на стенде работают все сразу. Смена её пароля
				увела бы вход у остальных, поэтому из демонстрации пароль не меняется.
			</InlineHint>
		{:else}
			{#if $errors._errors}
				<Alert.Root variant="destructive" class="mb-4">
					<Alert.Description>
						<ul class="list-inside list-disc">
							{#each $errors._errors as issue (issue)}
								<li>{issue}</li>
							{/each}
						</ul>
					</Alert.Description>
				</Alert.Root>
			{/if}

			<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
			<form method="POST" action="?/password" use:enhance novalidate class="flex flex-col gap-4">
				<FieldInput
					name="current"
					type="password"
					label="Текущий пароль"
					required
					bind:value={$form.current}
					errors={$errors.current}
				/>
				<FieldInput
					name="next"
					type="password"
					label="Новый пароль"
					description={policyHint}
					required
					bind:value={$form.next}
					errors={$errors.next}
				/>
				<FieldInput
					name="repeat"
					type="password"
					label="Новый пароль ещё раз"
					required
					bind:value={$form.repeat}
					errors={$errors.repeat}
				/>
				<FormActions submitting={$submitting} submitLabel="Сменить пароль" />
			</form>
		{/if}
	</Card.Content>
</Card.Root>

<Card.Root>
	<Card.Header>
		<Card.Title>Второй фактор</Card.Title>
		<Card.Description>
			Одноразовый код из приложения-аутентификатора в дополнение к паролю. Украденный пароль без
			телефона владельца перестаёт быть доступом в систему.
		</Card.Description>
		{#if data.mfa.enabled}
			<Card.Action>
				<StatusBadge tone="success">Подключён</StatusBadge>
			</Card.Action>
		{/if}
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		{#if data.isDemo}
			<InlineHint tone="warning">
				Учётная запись демонстрации общая: под ней на стенде работают все сразу. Второй фактор
				привязал бы вход к одному телефону, поэтому из демонстрации он не подключается.
			</InlineHint>
		{:else}
			{#if $disableMessage}
				<Alert.Root>
					<Alert.Description>{$disableMessage}</Alert.Description>
				</Alert.Root>
			{/if}

			{#if backupCodes !== null}
				<BackupCodes codes={backupCodes} />
			{:else if data.mfa.enabled}
				<KeyValue>
					<KeyValueRow
						label="Подключён"
						value={data.mfa.enrolledAt === null ? '—' : formatDateTime(data.mfa.enrolledAt)}
					/>
					<KeyValueRow
						label="Резервных кодов осталось"
						value={`${data.mfa.backupCodesLeft} из ${data.backupCodeCount}`}
					/>
				</KeyValue>

				{#if data.mfa.backupCodesLeft === 0}
					<InlineHint tone="warning">
						Резервные коды кончились. Без приложения войти будет нечем — выпустите новые.
					</InlineHint>
				{/if}

				<div class="flex flex-col gap-4 border-t border-border pt-4">
					<p class="text-sm font-medium">Новые резервные коды</p>
					{#if $codesErrors._errors}
						<Alert.Root variant="destructive">
							<Alert.Description>
								<ul class="list-inside list-disc">
									{#each $codesErrors._errors as issue (issue)}
										<li>{issue}</li>
									{/each}
								</ul>
							</Alert.Description>
						</Alert.Root>
					{/if}
					<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
					<form
						method="POST"
						action="?/mfaCodes"
						use:codesEnhance
						novalidate
						class="flex flex-col gap-4"
					>
						<FieldInput
							name="code"
							label="Код из приложения"
							description="Прежние резервные коды перестанут работать сразу"
							required
							placeholder="000000"
							bind:value={$codesData.code}
							errors={$codesErrors.code}
						/>
						<FormActions submitting={$codesSubmitting} submitLabel="Выпустить новые коды" />
					</form>
				</div>

				{#if data.mfaRequired}
					<InlineHint tone="info">
						Для вашей роли второй фактор обязателен по политике доступа: отключить его может только
						администратор, изменив политику.
					</InlineHint>
				{:else}
					<div class="flex flex-col gap-4 border-t border-border pt-4">
						<p class="text-sm font-medium">Отключение фактора</p>
						{#if $disableErrors._errors}
							<Alert.Root variant="destructive">
								<Alert.Description>
									<ul class="list-inside list-disc">
										{#each $disableErrors._errors as issue (issue)}
											<li>{issue}</li>
										{/each}
									</ul>
								</Alert.Description>
							</Alert.Root>
						{/if}
						<form
							method="POST"
							action="?/mfaDisable"
							use:disableEnhance
							novalidate
							class="flex flex-col gap-4"
						>
							<FieldInput
								name="code"
								label="Код из приложения"
								description="Вход снова будет защищён только паролем"
								required
								placeholder="000000"
								bind:value={$disableData.code}
								errors={$disableErrors.code}
							/>
							<FormActions submitting={$disableSubmitting} submitLabel="Отключить фактор" />
						</form>
					</div>
				{/if}
			{:else if data.enrollment !== null}
				<TotpEnrollment uri={data.enrollment.uri} secret={data.enrollment.secret} />

				{#if $enrollErrors._errors}
					<Alert.Root variant="destructive">
						<Alert.Description>
							<ul class="list-inside list-disc">
								{#each $enrollErrors._errors as issue (issue)}
									<li>{issue}</li>
								{/each}
							</ul>
						</Alert.Description>
					</Alert.Root>
				{/if}

				<form
					method="POST"
					action={enrollAction}
					use:enrollEnhance
					novalidate
					class="flex flex-col gap-4"
				>
					<FieldInput
						name="code"
						label="Код из приложения"
						description="Шесть цифр; они меняются каждые 30 секунд"
						required
						placeholder="000000"
						bind:value={$enrollData.code}
						errors={$enrollErrors.code}
					/>
					<FormActions submitting={$enrollSubmitting} submitLabel="Подключить" />
				</form>
			{:else}
				<InlineHint>
					{#if data.mfaRequired}
						Для вашей роли фактор обязателен: при следующем входе система попросит его подключить.
					{:else}
						Фактор не подключён. Вход защищён только паролем.
					{/if}
				</InlineHint>

				<div>
					<Button variant="outline" href={`${resolve('/(app)/settings/profile')}?mfa=enroll`}>
						<ShieldCheckIcon aria-hidden="true" />
						Подключить второй фактор
					</Button>
				</div>
			{/if}
		{/if}
	</Card.Content>
</Card.Root>

<Card.Root>
	<Card.Header>
		<Card.Title>Сессии</Card.Title>
		<Card.Description>
			Вход с каждого устройства заводит отдельную сессию. Если вы забыли выйти на чужом компьютере
			или подозреваете, что сессией пользуется кто-то ещё, завершите все сразу — включая эту.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if data.isDemo}
			<InlineHint tone="warning">
				Сессии демонстрации принадлежат не одному человеку: завершить их все — значит выкинуть со
				стенда всех, кто сейчас его смотрит. Из демонстрации это действие закрыто.
			</InlineHint>
		{:else}
			<form method="POST" action="?/revokeAll">
				<Button type="submit" variant="outline">Завершить все сессии</Button>
			</form>
		{/if}
	</Card.Content>
</Card.Root>
