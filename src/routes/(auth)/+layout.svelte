<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Страницы, на которые попадают без сессии. Оболочки приложения здесь нет и
	 * быть не может: разделы, поиск и меню учётной записи существуют только для
	 * того, кто уже вошёл.
	 */
	let { children }: { children: Snippet } = $props();
</script>

<div class="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-10">
	<div class="w-full max-w-md">
		{@render children()}
	</div>
</div>
