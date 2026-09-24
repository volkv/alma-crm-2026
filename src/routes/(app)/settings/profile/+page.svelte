<script lang="ts">
	import LifeBuoyIcon from '@lucide/svelte/icons/life-buoy';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import { getOnboardingTour } from '$lib/onboarding/tour.svelte';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	const tour = getOnboardingTour();

	/** И отказ демонстрации, и подтверждение «сессии завершены» приходят одинаково. */
	const notice = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);
	const refused = $derived(actionResult !== null && 'issues' in actionResult);
</script>

<svelte:head>
	<title>Профиль — Альма CRM</title>
</svelte:head>

<Card.Root data-tour="settings-profile-account">
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

<Card.Root data-tour="settings-profile-sessions">
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

{#if tour.fullLength > 0}
	<Card.Root>
		<Card.Header>
			<Card.Title>Подсказки</Card.Title>
			<Card.Description>
				Полный обход экранов вашей роли: тур сам открывает каждый экран и рассказывает, что на нём
				главное. Он показывается один раз при первом входе; подсказки по отдельному экрану всегда
				под значком «?» в шапке. Признак «уже показаны» принадлежит этому браузеру — с другого
				устройства подсказки начнутся заново.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<Button variant="outline" onclick={() => tour.startFull()}>
				<LifeBuoyIcon aria-hidden="true" />
				Полный тур по системе
			</Button>
		</Card.Content>
	</Card.Root>
{/if}
