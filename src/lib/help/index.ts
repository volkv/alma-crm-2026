/**
 * Встроенная справка: один источник для экрана и для будущего PDF.
 *
 * Статьи лежат рядом в `content/` обычными файлами Markdown и попадают в
 * сборку как есть (`import.meta.glob(..., '?raw')`). Это важнее, чем кажется:
 * в образе нет ни каталога с текстами, ни чтения с диска на запрос, а значит,
 * версия справки — это ровно та версия, которой собрано приложение. Руководство
 * на экране и руководство в файле не могут разойтись, потому что взяты из
 * одного места.
 *
 * Порядок и принадлежность разделу объявлены во фронтматтере, а не выведены из
 * имени файла: переименование файла не должно молча переставлять статью в
 * оглавлении. Имя файла даёт только адрес статьи.
 */
import { z } from 'zod';
import { renderMarkdown, type MarkdownOptions } from './markdown';

/** Кому адресована статья. Разделов ровно два, и это разные читатели. */
export const HELP_SECTION_KEYS = ['user', 'admin'] as const;

export type HelpSectionKey = (typeof HELP_SECTION_KEYS)[number];

export type HelpSection = {
	key: HelpSectionKey;
	title: string;
	description: string;
};

export const HELP_SECTIONS: readonly HelpSection[] = [
	{
		key: 'user',
		title: 'Руководство пользователя',
		description:
			'Как вести взаимодействия с учебными заведениями: от входа до отчёта. Для менеджера и руководителя.'
	},
	{
		key: 'admin',
		title: 'Руководство администратора',
		description: 'Как настроена система: процесс, доступ, интеграции, журнал и обслуживание стенда.'
	}
];

export function isHelpSectionKey(value: string): value is HelpSectionKey {
	return (HELP_SECTION_KEYS as readonly string[]).includes(value);
}

export function helpSection(key: HelpSectionKey): HelpSection {
	// Раздел, которого нет в списке, — это опечатка в коде, а не отсутствующая
	// страница: ключи закрыты типом.
	const section = HELP_SECTIONS.find((candidate) => candidate.key === key);

	if (section === undefined) {
		throw new Error(`Раздел справки «${key}» не описан`);
	}

	return section;
}

/**
 * Шапка статьи. Проверяется схемой, как и всё остальное в проекте: статья без
 * заголовка или с чужим разделом не должна попасть в оглавление молча — она
 * должна уронить сборку оглавления при первом же обращении.
 */
const frontmatterSchema = z.object({
	title: z.string().min(1),
	/** Место в разделе. Числа не обязаны идти подряд — важен только порядок. */
	order: z.coerce.number().int().min(1),
	role: z.enum(HELP_SECTION_KEYS),
	/** Одна строка о том, что внутри: её показывает оглавление. */
	summary: z.string().min(1)
});

export type HelpPage = {
	section: HelpSectionKey;
	/** Хвост адреса статьи: `/help/user/<slug>`. */
	slug: string;
	title: string;
	order: number;
	summary: string;
	/** Исходный текст статьи без шапки. */
	markdown: string;
};

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

/** Разбирает шапку: по паре «ключ: значение» на строку, без вложенности. */
function parseFrontmatter(source: string, path: string): { data: unknown; body: string } {
	const match = FRONTMATTER.exec(source);

	if (match === null) {
		throw new Error(`Статья справки «${path}» без шапки: нужны title, order, role и summary`);
	}

	const data: Record<string, string> = {};

	for (const line of match[1].split('\n')) {
		if (line.trim() === '') {
			continue;
		}

		const separator = line.indexOf(':');

		if (separator === -1) {
			throw new Error(`Шапка статьи «${path}»: строка «${line}» не похожа на «ключ: значение»`);
		}

		data[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
	}

	return { data, body: source.slice(match[0].length) };
}

/**
 * Адрес статьи из имени файла: `content/user/02-interactions.md` даёт
 * `interactions`. Числовой префикс — только чтобы файлы лежали в каталоге в том
 * же порядке, в каком читаются; в адрес он не попадает, иначе вставка статьи в
 * середину переписала бы ссылки на все следующие.
 */
const SOURCE_PATH = /^\.\/content\/(user|admin)\/\d+-([a-z0-9-]+)\.md$/;

const sources = import.meta.glob('./content/**/*.md', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

function loadPages(): HelpPage[] {
	const pages = Object.entries(sources).map(([path, source]) => {
		const location = SOURCE_PATH.exec(path);

		if (location === null) {
			throw new Error(
				`Файл справки «${path}» назван не по правилу content/<раздел>/<номер>-<адрес>.md`
			);
		}

		const { data, body } = parseFrontmatter(source, path);
		const frontmatter = frontmatterSchema.safeParse(data);

		if (!frontmatter.success) {
			throw new Error(
				`Шапка статьи «${path}» не прошла проверку: ${frontmatter.error.issues
					.map((issue) => `${issue.path.join('.')} — ${issue.message}`)
					.join('; ')}`
			);
		}

		if (frontmatter.data.role !== location[1]) {
			throw new Error(
				`Статья «${path}» лежит в разделе «${location[1]}», а в шапке указан «${frontmatter.data.role}»`
			);
		}

		return {
			section: frontmatter.data.role,
			slug: location[2],
			title: frontmatter.data.title,
			order: frontmatter.data.order,
			summary: frontmatter.data.summary,
			markdown: body
		} satisfies HelpPage;
	});

	return pages.sort((left, right) =>
		left.section === right.section
			? left.order - right.order
			: HELP_SECTION_KEYS.indexOf(left.section) - HELP_SECTION_KEYS.indexOf(right.section)
	);
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
