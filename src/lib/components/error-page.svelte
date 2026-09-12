<script lang="ts">
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
			<p class="text-xs text-faint">
				Код обращения: <span class="font-medium">{requestId}</span>
			</p>
		{/if}
	</div>

	<div class="flex flex-wrap items-center justify-center gap-2">
		<Button href={resolve('/(app)')} variant={status === 401 ? 'outline' : 'default'}>
			На главную
		</Button>
		{#if status === 401}
			<Button href={resolve('/(auth)/login')}>Войти</Button>
		{/if}
	</div>
</div>
