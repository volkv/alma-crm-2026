<script lang="ts">
	import ErrorPage from '$lib/components/error-page.svelte';

	/**
	 * Страница ошибки вне приложения: несуществующий адрес, форма входа, всё,
	 * что случилось раньше, чем стало известно, кто перед нами. Оболочки здесь
	 * нет — её разделы и меню учётной записи существуют только для вошедшего, а
	 * 404 на выдуманный адрес отвечают и анониму.
	 */
</script>

<div class="flex min-h-screen items-center justify-center bg-canvas">
	<ErrorPage />
</div>
