<script lang="ts">
	import { page } from '$app/state';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
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

	const demoPassword = $derived(data.demoPassword);

	/**
	 * Чем кончилось последнее нажатие «Скопировать пароль». Ответ живёт на самой
	 * карточке, а не всплывающим сообщением: оболочки приложения на странице
	 * входа нет, а вместе с ней нет и места, куда такому сообщению всплывать.
	 */
	let copyState = $state<'idle' | 'copied' | 'failed'>('idle');

	const copyNotice = $derived(
		copyState === 'copied'
			? 'Пароль скопирован'
			: copyState === 'failed'
				? 'Скопировать не удалось — выделите пароль и скопируйте вручную'
				: ''
	);

	/**
	 * Отметка об успехе держится пару секунд: столько нужно, чтобы её заметили, а
	 * потом кнопка снова выглядит нажимаемой. Отказ не гаснет — его читают, а не
	 * замечают краем глаза.
	 */
	$effect(() => {
		if (copyState !== 'copied') {
			return;
		}

		const timer = setTimeout(() => (copyState = 'idle'), 2000);

		return () => clearTimeout(timer);
	});

	async function copyPassword(password: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(password);
			copyState = 'copied';
		} catch {
			// Буфер обмена бывает закрыт настройками браузера, а по незащищённому
			// адресу его не существует вовсе: честнее сказать об этом, чем делать
			// вид, что пароль скопирован.
			copyState = 'failed';
		}
	}
</script>

<svelte:head>
	<title>Вход — Альма CRM</title>
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
							Учётные записи стенда: роль и имя входа. Пароль у всех трёх общий{demoPassword ===
							null
								? ' — он выдаётся вместе со стендом'
								: ''}. Названия вузов и продуктов в системе настоящие, люди, договоры и цифры —
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
					{#if demoPassword !== null}
						<!-- Пароль стенда публичный: его знает всякий, кто открыл репозиторий,
						     и прятать его от зрителя показа значило бы прятать от одного его. -->
						<div class="flex flex-col gap-1">
							<div
								class="flex items-center justify-between gap-4 rounded-md bg-surface py-1.5 pr-1.5 pl-2.5"
								data-testid="demo-password"
							>
								<span class="text-sm">Пароль</span>
								<div class="flex items-center gap-1">
									<code class="font-mono text-xs text-muted-foreground">{demoPassword}</code>
									<!-- Набирают пароль не здесь, а в чужой форме — в каталоге
									     учётных записей, куда уводит «Войти»: перенабор по памяти
									     посреди показа стоит дороже кнопки. -->
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label="Скопировать пароль"
										data-testid="copy-demo-password"
										onclick={() => copyPassword(demoPassword)}
									>
										{#if copyState === 'copied'}
											<CheckIcon aria-hidden="true" />
										{:else}
											<CopyIcon aria-hidden="true" />
										{/if}
									</Button>
								</div>
							</div>
							<!-- Область объявлений стоит на странице до нажатия: контейнер,
							     появившийся вместе с текстом, экранный диктор не прочитает. -->
							<p
								class="min-h-4 px-2.5 text-xs {copyState === 'failed'
									? 'text-danger-soft-foreground'
									: 'text-muted-foreground'}"
								aria-live="polite"
								data-testid="demo-password-notice"
							>
								{copyNotice}
							</p>
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	</Card.Content>
</Card.Root>
