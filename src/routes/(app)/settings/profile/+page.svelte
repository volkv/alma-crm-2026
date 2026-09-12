<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import { pluralize } from '$lib/format';
	import { changePasswordSchema } from './schema';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const { form, errors, enhance, submitting, message } = superForm(
		untrack(() => data.form),
		{ validators: zod4Client(changePasswordSchema) }
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
		<form method="POST" action="?/revokeAll">
			<Button type="submit" variant="outline">Завершить все сессии</Button>
		</form>
	</Card.Content>
</Card.Root>
