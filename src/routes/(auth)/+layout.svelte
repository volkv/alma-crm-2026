<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Страницы, на которые попадают без сессии. Оболочки приложения здесь нет и
	 * быть не может: разделы, поиск и меню учётной записи существуют только для
	 * того, кто уже вошёл.
	 *
	 * Раскладка — та же, что у входа РТК ID: знак продукта, под ним одна
	 * карточка на спокойном холсте и ничего больше. Заголовок страницы живёт
	 * внутри карточки, поэтому знак здесь — не заголовок, а подпись: иначе на
	 * странице оказалось бы два `<h1>`.
	 */
	let { children }: { children: Snippet } = $props();
</script>

<div class="relative flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-10">
	<!-- Фирменный тёплый отсвет сверху: единственное место, где акцент работает
	     заливкой во весь экран. Цвет — токен, не картинка. -->
	<div
		class="pointer-events-none absolute inset-x-0 top-0 h-56 bg-linear-to-b from-primary-soft to-transparent"
		aria-hidden="true"
	></div>

	<div class="relative flex w-full max-w-md flex-col items-center gap-5">
		<div class="flex items-center gap-2.5">
			<span
				class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground"
				aria-hidden="true">CRM</span
			>
			<span class="text-base font-semibold tracking-tight">LCT CRM</span>
		</div>

		<div class="w-full">
			{@render children()}
		</div>
	</div>
</div>
