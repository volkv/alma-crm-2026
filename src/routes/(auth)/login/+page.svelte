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

	let loginForm = $state<HTMLFormElement>();

	/**
	 * Сказать странице нечего — выхода, конца сессии, отказа каталога или лимита
	 * заходов не было — значит, она лишний шаг: форма уходит сама, и человек
	 * сразу видит форму каталога. Уходит та же форма POST, что и по кнопке:
	 * заход заводит запись на сервере и остаётся под проверкой происхождения и
	 * лимитом заходов. Без скрипта страница остаётся с кнопкой «Войти».
	 */
	const startAutomatically = $derived(
		data.notice === null && !actionResult && data.rateLimited === null
	);

	$effect(() => {
		if (startAutomatically && loginForm !== undefined) {
			loginForm.requestSubmit();
		}
	});
</script>

<svelte:head>
	<title>Вход — Альма CRM</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<!-- Заголовок страницы, а не карточки: на странице входа он единственный. -->
		<h1 class="text-xl leading-snug font-semibold tracking-tight">Вход в Альма CRM</h1>
		<Card.Description>От первого контакта с вузом до подтверждённого результата</Card.Description>
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
			<!-- Единственное действие страницы, поэтому кнопка во всю ширину и на
			     ступень крупнее обычной. Строка под ней заранее объясняет, почему
			     почту и пароль спросит другая страница. -->
			<form bind:this={loginForm} method="POST" action={loginAction} class="flex flex-col gap-2">
				<Button type="submit" size="lg" class="w-full">
					<LogInIcon aria-hidden="true" />
					Войти
				</Button>
				<p class="text-center text-xs text-muted-foreground">
					Почту и пароль рабочей учётной записи спросит следующий шаг
				</p>
			</form>

			<!-- Баннер задаёт администратор (`/settings/general`): кому система
			     предназначена и что действия записываются. Это оговорка, а не
			     заголовок, поэтому и набрана мелко. -->
			<div class="flex flex-col gap-0.5 text-xs" data-testid="login-banner">
				<p class="font-medium">{data.banner.title}</p>
				{#if data.banner.text}
					<p class="text-muted-foreground">{data.banner.text}</p>
				{/if}
			</div>
		{/if}
	</Card.Content>
</Card.Root>
