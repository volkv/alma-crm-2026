import { HELP_SECTIONS, helpPageLink, helpPages } from '$lib/help';
import type { PageServerLoad } from './$types';

/**
 * Оглавление справки. Прав у раздела нет: руководство описывает систему
 * целиком, и человек, вошедший менеджером, должен иметь возможность прочитать,
 * что именно ему недоступно и почему.
 *
 * Тексты статей сюда не едут — только заголовки и подписи: разбор разметки
 * делает страница статьи, а весь корпус в данных оглавления был бы лишним
 * килобайтом на каждый переход.
 */
export const load: PageServerLoad = () => ({
	sections: HELP_SECTIONS.map((section) => ({
		...section,
		pages: helpPages(section.key).map(helpPageLink)
	}))
});
