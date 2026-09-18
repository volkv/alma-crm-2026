/**
 * Встроенная справка: один источник для экрана и для файла.
 *
 * Статьи лежат рядом в `content/` обычными файлами Markdown и попадают в
 * сборку как есть (`import.meta.glob(..., '?raw')`). Это важнее, чем кажется:
 * в образе нет ни каталога с текстами, ни чтения с диска на запрос, а значит,
 * версия справки — это ровно та версия, которой собрано приложение. Руководство
 * на экране и руководство в файле не могут разойтись, потому что взяты из
 * одного места.
 *
 * Правила разбора — состав разделов, поля шапки, адрес и порядок — вынесены в
 * `article.ts`: их читает не только приложение, но и сборщик комплекта
 * документации, который запускается обычным Node и `import.meta.glob` не
 * понимает. Здесь остаётся только то, что относится к сборке: где взять
 * исходники и что из них показать.
 */
import { compareHelpPages, parseHelpArticle, type HelpPage, type HelpSectionKey } from './article';
import { renderMarkdown, type MarkdownOptions } from './markdown';

export {
	HELP_SECTIONS,
	HELP_SECTION_KEYS,
	helpSection,
	isHelpSectionKey,
	type HelpPage,
	type HelpSection,
	type HelpSectionKey
} from './article';

const sources = import.meta.glob('./content/**/*.md', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

function loadPages(): HelpPage[] {
	return Object.entries(sources)
		.map(([path, source]) => parseHelpArticle(path, source))
		.sort(compareHelpPages);
}

const pages = loadPages();

/** Статьи раздела по порядку. */
export function helpPages(section: HelpSectionKey): HelpPage[] {
	return pages.filter((page) => page.section === section);
}

export function findHelpPage(section: HelpSectionKey, slug: string): HelpPage | null {
	return pages.find((page) => page.section === section && page.slug === slug) ?? null;
}

/** Соседи статьи внутри её раздела: по ним рисуются «предыдущая» и «следующая». */
export function helpNeighbours(page: HelpPage): {
	previous: HelpPage | null;
	next: HelpPage | null;
} {
	const siblings = helpPages(page.section);
	const position = siblings.findIndex((candidate) => candidate.slug === page.slug);

	return {
		previous: siblings[position - 1] ?? null,
		next: siblings[position + 1] ?? null
	};
}

/** Статья в том виде, в каком её показывает страница. */
export type RenderedHelpPage = Omit<HelpPage, 'markdown'> & { html: string };

export function renderHelpPage(page: HelpPage, options?: MarkdownOptions): RenderedHelpPage {
	const { markdown, ...rest } = page;

	return { ...rest, html: renderMarkdown(markdown, options) };
}

/**
 * Статья без текста — то, что нужно оглавлению и навигации. Отдельная функция,
 * потому что исходник статьи в браузер отдавать незачем: страница показывает
 * разобранный HTML, а весь корпус справки в данных страницы — это лишние
 * килобайты на каждый переход.
 */
export type HelpPageLink = Omit<HelpPage, 'markdown'>;

export function helpPageLink(page: HelpPage): HelpPageLink {
	const { markdown: _markdown, ...rest } = page;

	return rest;
}
