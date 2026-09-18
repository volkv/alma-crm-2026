<script lang="ts">
	import { page } from '$app/state';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	/**
	 * Отправка формы теряет строку запроса, а в ней приезжает `next` — страница,
	 * с которой человека развернули на вход.
	 */
	const query = $derived(page.url.searchParams.toString());
	const loginAction = $derived(query === '' ? '' : `?${query}`);
</script>

<svelte:head>
	<title>Вход — LCT CRM</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<!-- Заголовок страницы, а не карточки: на странице входа он единственный. -->
		<h1 class="text-xl leading-snug font-semibold tracking-tight">{data.banner.title}</h1>
		{#if data.banner.text}
			<Card.Description>{data.banner.text}</Card.Description>
		{/if}
	</Card.Header>

	<Card.Content class="flex flex-col gap-4">
		<!-- Объяснение, почему человек снова здесь: это не отказ, поэтому и не
		     `destructive`. -->
		{#if data.notice}
			<Alert.Root>
				<Alert.Description>{data.notice}</Alert.Description>
			</Alert.Root>
		{/if}

		{#if actionResult}
			<Alert.Root variant="destructive">
				<Alert.Description>{actionResult.message}</Alert.Description>
			</Alert.Root>
		{/if}

		{#if data.rateLimited}
			<!-- Адрес выбрал лимит заходов: кнопка отсюда всё равно не пройдёт — её
			     POST развернёт обратно сюда. Показывать нерабочий орган управления
			     хуже, чем не показывать ничего. -->
			<Alert.Root variant="destructive">
				<Alert.Description>{data.rateLimited}</Alert.Description>
			</Alert.Root>
		{:else}
			<p class="text-sm text-muted-foreground">
				Вход идёт через общий каталог учётных записей: почту и пароль спрашивает он, а система
				получает от него уже проверенную учётную запись и роль.
			</p>

			<!-- Единственное действие страницы, поэтому кнопка во всю ширину и на
			     ступень крупнее обычной: у входа РТК ID она выглядит так же. -->
			<form method="POST" action={loginAction}>
				<Button type="submit" size="lg" class="w-full">
					<LogInIcon aria-hidden="true" />
					Войти
				</Button>
			</form>

			{#if data.demoAccounts.length > 0}
				<div
					class="flex flex-col gap-3 rounded-lg border border-primary-soft-border bg-primary-soft p-3"
				>
					<div class="flex flex-col gap-1">
						<p class="text-sm font-medium">Демо-режим</p>
						<p class="text-xs text-muted-foreground">
							Учётные записи стенда: роль и имя входа. Пароль у всех трёх общий — он выдаётся вместе
							со стендом. Названия вузов и продуктов в системе настоящие, люди, договоры и цифры —
							вымышленные.
						</p>
					</div>
					<ul class="flex flex-col gap-1.5" data-testid="demo-accounts">
						{#each data.demoAccounts as account (account.login)}
							<li
								class="flex items-center justify-between gap-4 rounded-md bg-surface px-2.5 py-1.5"
							>
								<span class="text-sm">{account.roleName}</span>
								<code class="font-mono text-xs text-muted-foreground">{account.login}</code>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		{/if}
	</Card.Content>
</Card.Root>
