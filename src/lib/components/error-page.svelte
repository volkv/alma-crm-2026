<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';

	/**
	 * Что человек видит вместо страницы.
	 *
	 * Три вещи и ни одной лишней: код ответа, фраза, которую написал сервер, и
	 * код обращения, по которому случай находится в логе. Фразу мы не сочиняем и
	 * не прячем — сервис уже сказал по-русски, чего не хватило (права, записи,
	 * терпения), и подменять это общим «что-то пошло не так» значит отправить
	 * человека угадывать. Заголовок при этом наш: он отвечает на «что теперь»,
	 * а не повторяет сообщение.
	 */
	const TITLES: Record<number, string> = {
		401: 'Нужно войти',
		403: 'Доступ закрыт',
		404: 'Страница не найдена',
		429: 'Слишком много запросов',
		500: 'Что-то пошло не так'
	};

	const status = $derived(page.status);
	const title = $derived(
		TITLES[status] ?? (status >= 500 ? 'Что-то пошло не так' : 'Запрос не принят')
	);
	/**
	 * Фраза сервера — но только если она добавляет что-то к заголовку. На 404 по
	 * несуществующему адресу их пишут разные места («Страница не найдена» в
	 * таблице отказов фреймворка и здесь), и человек получал одну и ту же строку
	 * дважды: крупно и мелко.
	 */
	const message = $derived(page.error?.message ?? '');
	const detail = $derived(message === title ? '' : message);
	// У ожидаемого отказа тело пишет `error()`, у неожиданного — `handleError`;
	// корневой макет кладёт тот же идентификатор в данные страницы, поэтому код
	// обращения есть и там, и там.
	const requestId = $derived(page.error?.requestId ?? page.data.requestId);
	/**
	 * Отказ сервера или ошибка загрузки — то, что нередко проходит само собой
	 * (истёкший запрос, случайный сбой). 401/403/404/429 таким не бывают: тот же
	 * адрес ответит тем же самым, и кнопка «Повторить» только обманула бы.
	 */
	const canRetry = $derived(status >= 500);

	let copied = $state(false);
	let copyFailed = $state(false);
	let copyResetHandle: ReturnType<typeof setTimeout> | undefined;

	async function copyRequestId(id: string): Promise<void> {
		clearTimeout(copyResetHandle);

		try {
			await navigator.clipboard.writeText(id);
			copied = true;
			copyFailed = false;
		} catch {
			// Буфер обмена бывает недоступен (небезопасный контекст, запрет
			// разрешения) — тогда молчать нельзя: человек ждёт код скопированным,
			// а его никуда не положили. Код всё равно есть на экране текстом.
			copied = false;
			copyFailed = true;
		}

		copyResetHandle = setTimeout(() => {
			copied = false;
			copyFailed = false;
		}, 2000);
	}
</script>

<div
	class="flex flex-col items-center justify-center gap-5 px-4 py-16 text-center"
	data-slot="error-page"
>
	<p class="text-5xl font-semibold text-faint tabular-nums">{status}</p>

	<div class="space-y-2">
		<h1 class="text-lg font-semibold tracking-tight">{title}</h1>
		{#if detail}
			<p class="mx-auto max-w-md text-sm text-muted-foreground">{detail}</p>
		{/if}
		{#if requestId}
			<div class="flex flex-col items-center gap-1">
				<p class="flex items-center gap-1 text-xs text-faint">
					Код обращения: <span class="font-medium">{requestId}</span>
					<Button
						variant="ghost"
						size="icon-sm"
						class="size-5 text-faint"
						aria-label="Скопировать код обращения"
						onclick={() => copyRequestId(requestId)}
					>
						{#if copied}
							<CheckIcon aria-hidden="true" />
						{:else}
							<CopyIcon aria-hidden="true" />
						{/if}
					</Button>
				</p>
				{#if copyFailed}
					<p class="text-xs text-danger-soft-foreground">
						Не удалось скопировать — выделите код вручную.
					</p>
				{/if}
			</div>
		{/if}
	</div>

	<div class="flex flex-wrap items-center justify-center gap-2">
		{#if canRetry}
			<Button variant="outline" onclick={() => window.location.reload()}>Повторить</Button>
		{/if}
		<Button href={resolve('/(app)')} variant={status === 401 ? 'outline' : 'default'}>
			На главную
		</Button>
		{#if status === 401}
			<Button href={resolve('/(auth)/login')}>Войти</Button>
		{/if}
	</div>
</div>
