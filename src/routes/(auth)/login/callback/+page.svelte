<script lang="ts">
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	/**
	 * Страница рисуется только тогда, когда вход не состоялся: удачный исход
	 * уводит перенаправлением ещё в загрузчике.
	 */
	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Вход не выполнен — Альма CRM</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<h1 class="text-lg leading-snug font-semibold tracking-tight">Вход не выполнен</h1>
	</Card.Header>

	<Card.Content class="flex flex-col gap-4">
		<Alert.Root variant="destructive">
			<Alert.Description data-testid="login-failure">{data.message}</Alert.Description>
		</Alert.Root>

		<Button href="/login" variant="outline" class="w-full">
			<ArrowLeftIcon aria-hidden="true" />
			Вернуться к входу
		</Button>
	</Card.Content>
</Card.Root>
