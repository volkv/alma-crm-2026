<script lang="ts">
	import type { Snippet } from 'svelte';
	import { AlmaMark } from '$lib/components/brand';

	/**
	 * Страницы, на которые попадают без сессии. Оболочки приложения здесь нет и
	 * быть не может: разделы, поиск и меню учётной записи существуют только для
	 * того, кто уже вошёл.
	 *
	 * Над карточкой — один знак. Название системы стоит в заголовке карточки,
	 * и словесный логотип рядом с ним повторил бы его дважды подряд.
	 */
	let { children }: { children: Snippet } = $props();
</script>

<div class="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-10">
	<div class="flex w-full max-w-md flex-col items-center gap-6">
		<AlmaMark size={44} />

		<div class="w-full">
			{@render children()}
		</div>
	</div>
</div>
