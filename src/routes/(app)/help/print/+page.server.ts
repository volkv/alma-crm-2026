import { HELP_SECTIONS, helpPages, renderHelpPage } from '$lib/help';
import type { PageServerLoad } from './$types';

/**
 * Вся справка одной страницей — то, из чего собирается PDF.
 *
 * Источник у неё тот же, что у отдельных статей, и это главное её свойство:
 * руководство в файле не может разойтись с руководством на экране, потому что
 * они собраны из одних и тех же файлов одним и тем же разборщиком.
 *
 * Заголовки статей опускаются на два уровня: на этой странице над ними стоят
 * заголовок документа и заголовок раздела, и без сдвига оглавление будущего
 * PDF получилось бы плоским.
 */
const HEADING_OFFSET = 2;

export const load: PageServerLoad = () => ({
	sections: HELP_SECTIONS.map((section) => ({
		...section,
		articles: helpPages(section.key).map((page) =>
			renderHelpPage(page, { headingOffset: HEADING_OFFSET })
		)
	}))
});
