/** Страницы «Обучения» в меню пространства: «Потоки и слушатели». */
import UsersRoundIcon from '@lucide/svelte/icons/users-round';
import { defineSectionsUi } from '$lib/platform/sections';
import manifest from './index';
import StreamsPage from './ui/streams-page.svelte';

export default defineSectionsUi(manifest, {
	streams: {
		component: StreamsPage,
		icon: UsersRoundIcon,
		description:
			'Потоки всех дел пространства: сколько мест заявлено, кто в списках и что пришло из системы обучения.'
	}
});
