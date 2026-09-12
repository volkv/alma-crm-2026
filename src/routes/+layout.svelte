<script lang="ts">
	import '../app.css';

	let { children } = $props();

	/**
	 * Отметка «страница ожила»: эффект корневого layout'а срабатывает после того,
	 * как приложение смонтировано, — до этого разметка на экране есть, а
	 * обработчиков у неё нет. Отметку читают проверки (`e2e/helpers/hydration.ts`);
	 * поведения продукта она не меняет.
	 */
	$effect(() => {
		document.body.dataset.hydrated = 'true';
	});
</script>

{@render children()}
