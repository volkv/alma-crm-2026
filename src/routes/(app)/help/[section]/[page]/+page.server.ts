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
import { actorFromEvent } from '$lib/server/actor';
import { loadAutomationMap } from '$lib/server/automation-map';
import type { PageServerLoad } from './$types';

/**
 * Место в статье, где встаёт живая карта автоматизации. Карта — не снимок
 * экрана, а те же данные, что у продукта, под права читающего: картинка
 * устаревала бы с каждой правкой реестра.
 */
const AUTOMATION_MAP_MARKER = '<!-- automation-map -->';

/**
 * Одна статья справки. Разметку разбирает сервер: набор разметки закрыт, а
 * разбирать его в браузере значило бы возить туда и текст, и разборщик ради
 * одного и того же результата.
 */
export const load: PageServerLoad = async (event) => {
	const { params } = event;

	if (!isHelpSectionKey(params.section)) {
		error(404, 'Такого раздела справки нет');
	}

	const article = findHelpPage(params.section, params.page);

	if (article === null) {
		error(404, 'Такой статьи справки нет');
	}

	const { previous, next } = helpNeighbours(article);
	const rendered = renderHelpPage(article);
	const [head, tail = null] = rendered.html.split(AUTOMATION_MAP_MARKER);

	return {
		section: helpSection(params.section),
		pages: helpPages(params.section).map(helpPageLink),
		article: { ...rendered, html: head },
		tail,
		automationMap: tail === null ? null : await loadAutomationMap(actorFromEvent(event)),
		previous: previous === null ? null : helpPageLink(previous),
		next: next === null ? null : helpPageLink(next)
	};
};
