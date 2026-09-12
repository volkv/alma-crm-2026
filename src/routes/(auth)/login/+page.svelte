<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import { loginSchema } from '$lib/contracts/auth';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	const {
		form,
		errors,
		enhance,
		submitting,
		message
		// superforms забирает начальную форму один раз и дальше следит за
		// обновлениями страницы сам.
	} = superForm(
		untrack(() => data.form),
		{ validators: zod4Client(loginSchema) }
	);

	/**
	 * Отправка формы на именованное действие теряет строку запроса, а в ней
	 * приезжает `next` — страница, с которой человека развернули на вход.
	 */
	const query = $derived(page.url.searchParams.toString());
	const loginAction = $derived(query === '' ? '?/login' : `?/login&${query}`);
	const demoAction = $derived(query === '' ? '?/demo' : `?/demo&${query}`);

	/** Отказ демонстрационного входа приходит не через superforms, а обычным `fail`. */
	const demoError = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);
</script>

<svelte:head>
	<title>Вход — LCT CRM</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<!-- Заголовок страницы, а не карточки: на странице входа он единственный. -->
		<h1 class="text-lg leading-snug font-semibold tracking-tight">{data.banner.title}</h1>
		{#if data.banner.text}
			<Card.Description>{data.banner.text}</Card.Description>
		{/if}
	</Card.Header>

	<Card.Content class="flex flex-col gap-4">
		<!-- Объяснение, почему человек снова здесь: это не отказ, поэтому и не
		     `destructive`. Ошибка входа стоит ниже — ближе к форме. -->
		{#if data.notice}
			<Alert.Root>
				<Alert.Description>{data.notice}</Alert.Description>
			</Alert.Root>
		{/if}

		{#if $message}
			<Alert.Root variant="destructive">
				<Alert.Description>{$message}</Alert.Description>
			</Alert.Root>
		{/if}

		{#if demoError}
			<Alert.Root variant="destructive">
				<Alert.Description>{demoError}</Alert.Description>
			</Alert.Root>
		{/if}

		<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
		<form method="POST" action={loginAction} use:enhance novalidate class="flex flex-col gap-4">
			<FieldInput
				name="email"
				type="email"
				label="Рабочая почта"
				required
				placeholder="name@example.org"
				bind:value={$form.email}
				errors={$errors.email}
			/>
			<FieldInput
				name="password"
				type="password"
				label="Пароль"
				required
				bind:value={$form.password}
				errors={$errors.password}
			/>
			<FormActions submitting={$submitting} submitLabel="Войти" />
		</form>

		{#if data.demoAccounts.length > 0}
			<div class="flex flex-col gap-2 border-t border-border pt-4">
				<p class="text-sm font-medium">Демо-режим</p>
				<p class="text-xs text-muted-foreground">
					Вход без пароля под одной из ролей. Данные в системе синтетические.
				</p>
				<form method="POST" action={demoAction} class="flex flex-wrap gap-2">
					{#each data.demoAccounts as account (account.roleId)}
						<Button type="submit" name="role" value={account.roleId} variant="outline" size="sm">
							<LogInIcon aria-hidden="true" />
							Войти как {account.roleName.toLocaleLowerCase('ru-RU')}
						</Button>
					{/each}
				</form>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
