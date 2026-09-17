<script lang="ts">
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	/** И отказ демонстрации, и подтверждение «сессии завершены» приходят одинаково. */
	const notice = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);
	const refused = $derived(actionResult !== null && 'issues' in actionResult);
</script>

<svelte:head>
	<title>Профиль — LCT CRM</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title>Учётная запись</Card.Title>
		<Card.Description>
			Имя, почта и роль приходят из каталога учётных записей при каждом входе. Менять их — там же,
			где вы вводите пароль; здесь они только показаны.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		<KeyValue>
			<KeyValueRow label="Имя">{data.account.fullName}</KeyValueRow>
			<KeyValueRow label="Рабочая почта">{data.account.email}</KeyValueRow>
		</KeyValue>
	</Card.Content>
</Card.Root>

<Card.Root>
	<Card.Header>
		<Card.Title>Сессии</Card.Title>
		<Card.Description>
			Гасит все сессии этой учётной записи в системе, включая текущую. Сессию в каталоге учётных
			записей это не трогает: чтобы выйти и из него, нажмите «Выйти» в меню.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		{#if notice}
			<Alert.Root variant={refused ? 'destructive' : 'default'}>
				<Alert.Description>{notice}</Alert.Description>
			</Alert.Root>

			{#if !refused}
				<Button href="/login" variant="outline" class="self-start">
					<LogInIcon aria-hidden="true" />
					Войти заново
				</Button>
			{/if}
		{/if}

		{#if data.isDemo}
			<InlineHint>
				Учётная запись демонстрационная и общая для всех, кто открыл стенд: завершить её сессии
				нельзя — это выкинуло бы из системы остальных посетителей.
			</InlineHint>
		{:else}
			<form method="POST" action="?/revokeAll">
				<Button type="submit" variant="outline">Завершить все сессии</Button>
			</form>
		{/if}
	</Card.Content>
</Card.Root>
