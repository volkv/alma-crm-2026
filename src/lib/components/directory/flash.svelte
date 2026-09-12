<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import { withoutParam } from './query';

	/**
	 * Сообщение об успехе, пережившее переход.
	 *
	 * Форма справочника заканчивается переходом на карточку, поэтому сказать
	 * «сохранено» на той же странице уже некому: тост живёт в памяти вкладки, а
	 * страница успела смениться. Действие дописывает к адресу `?done=<код>`,
	 * страница переводит код в фразу и убирает параметр — иначе перезагрузка и
	 * ссылка, посланная коллеге, покажут тост ещё раз.
	 *
	 * Коды закрытые: текст берётся из словаря страницы, а не из адреса, чтобы
	 * подсунутой ссылкой нельзя было показать человеку произвольную фразу.
	 */
	let { messages }: { messages: Record<string, string> } = $props();

	$effect(() => {
		const code = page.url.searchParams.get('done');

		if (code === null) {
			return;
		}

		replaceState(withoutParam(page.url, 'done'), {});

		const text = messages[code];

		if (text !== undefined) {
			toast.success(text);
		}
	});
</script>
