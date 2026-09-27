/** Загрузчики страниц «Обучения»: «Потоки и слушатели». */
import { error } from '@sveltejs/kit';
import { defineSectionsServer } from '$lib/platform/sections.server';
import learning from './index';
import { readStreamsPage } from './server/streams';

export default defineSectionsServer(learning, {
	streams: async ({ ctx, workspace, rest }) => {
		// Вложенных страниц у раздела нет: лишний сегмент адреса — незнакомый адрес.
		if (rest.length > 0) {
			error(404, 'Такой страницы нет');
		}

		return readStreamsPage(ctx, workspace.id);
	}
});
