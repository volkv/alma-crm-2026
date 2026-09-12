<script lang="ts">
	import { renderSVG } from 'uqr';
	import InlineHint from '$lib/components/inline-hint.svelte';

	/**
	 * Перенос секрета в приложение-аутентификатор: код для камеры и тот же
	 * секрет строкой.
	 *
	 * Строка обязательна, а не «на всякий случай»: камеры нет у настольного
	 * компьютера, а приложение на телефоне всё равно нужно. Поэтому секрет
	 * показывается и тем, и другим способом, а не одним.
	 *
	 * Картинка собирается здесь, а не на сервере: рисовать её — дело
	 * представления, а ссылку `otpauth://` знают оба места, где этот перенос
	 * происходит, — второй шаг входа и профиль.
	 */
	let {
		uri,
		secret
	}: {
		/** Ссылка `otpauth://` целиком. */
		uri: string;
		/** Тот же секрет в base32, разбитый на группы для переписывания руками. */
		secret: string;
	} = $props();

	/**
	 * Код едет картинкой в `data:`, а не разметкой внутрь страницы: вставка
	 * готового SVG в документ — это то самое место, где однажды окажется не наш
	 * SVG. Политика безопасности содержимого `data:` для картинок разрешает.
	 *
	 * Чёрное на белом задано явно: код читает камера, а не человек, и
	 * подстраиваться под тему оформления ему нечем — на тёмном фоне
	 * контрастности не остаётся.
	 */
	const source = $derived(
		`data:image/svg+xml,${encodeURIComponent(
			renderSVG(uri, { pixelSize: 6, border: 2, whiteColor: '#ffffff', blackColor: '#000000' })
		)}`
	);
</script>

<div class="flex flex-col gap-3">
	<InlineHint tone="info">
		Откройте приложение для одноразовых кодов и наведите камеру на этот код. Если камеры нет,
		добавьте запись вручную и введите ключ ниже.
	</InlineHint>

	<div class="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
		<img
			src={source}
			alt="Код для приложения-аутентификатора"
			width="204"
			height="204"
			class="shrink-0 rounded-md border border-border bg-white p-1"
		/>

		<div class="flex w-full flex-col gap-1.5">
			<p class="text-xs font-medium text-muted-foreground">Ключ для ручного ввода</p>
			<code
				class="block rounded-md border border-border bg-surface-muted px-2.5 py-2 font-mono text-sm break-all select-all"
				data-testid="totp-secret">{secret}</code
			>
			<p class="text-xs text-muted-foreground">
				Тип — по времени, алгоритм SHA-1, шесть цифр, шаг 30 секунд. Это значения по умолчанию почти
				во всех приложениях.
			</p>
		</div>
	</div>
</div>
