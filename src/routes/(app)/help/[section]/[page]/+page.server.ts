import { error } from '@sveltejs/kit';
import {
	findHelpPage,
	helpNeighbours,
	helpPageLink,
	helpPages,
	helpSection,
	isHelpSectionKey,
	renderHelpPage
} from '$lib/help';
import type { PageServerLoad } from './$types';

/**
 * Одна статья справки. Разметку разбирает сервер: набор разметки закрыт, а
 * разбирать его в браузере значило бы возить туда и текст, и разборщик ради
 * одного и того же результата.
 */
export const load: PageServerLoad = ({ params }) => {
	if (!isHelpSectionKey(params.section)) {
		error(404, 'Такого раздела справки нет');
	}

	const article = findHelpPage(params.section, params.page);

	if (article === null) {
		error(404, 'Такой статьи справки нет');
	}

	const { previous, next } = helpNeighbours(article);

	return {
		section: helpSection(params.section),
		pages: helpPages(params.section).map(helpPageLink),
		article: renderHelpPage(article),
		previous: previous === null ? null : helpPageLink(previous),
		next: next === null ? null : helpPageLink(next)
	};
};
