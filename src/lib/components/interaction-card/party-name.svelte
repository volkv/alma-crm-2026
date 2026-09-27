<script lang="ts">
	import { resolve } from '$app/paths';

	/**
	 * Сторона дела по имени — ссылкой на карточку организации: договоры,
	 * контакты, площадки и реквизиты ведут там, и из дела туда один переход.
	 * Откроется ли карточка, решает её страница по области доступа того, кто
	 * смотрит.
	 */
	let { organizationId, name }: { organizationId: string; name: string } = $props();
</script>

<a
	class="w-fit max-w-full rounded-sm text-sm font-medium break-words text-link focus-ring hover:text-link-hover hover:underline"
	href={resolve('/(app)/organizations/[id=uuid]', { id: organizationId })}>{name}</a
>
