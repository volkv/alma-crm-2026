<script lang="ts">
	import type { Snippet } from 'svelte';
	import { AlmaLogo } from '$lib/components/brand';

	/**
	 * Страницы, на которые попадают без сессии. Оболочки приложения здесь нет и
	 * быть не может: разделы, поиск и меню учётной записи существуют только для
	 * того, кто уже вошёл.
	 *
	 * Над карточкой — знак и название словом: тот же лок-ап, что видит человек
	 * дальше, на форме каталога учётных записей.
	 */
	let { children }: { children: Snippet } = $props();
</script>

<div class="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-10">
	<div class="flex w-full max-w-md flex-col items-center gap-6">
		<AlmaLogo size={40} wordClass="text-lg" />

		<div class="w-full">
			{@render children()}
		</div>
	</div>
</div>
