/**
 * Статья справки: разделы, шапка и место статьи в разделе.
 *
 * Отдельно от `index.ts`, потому что читателей у этих правил два. Приложение
 * забирает статьи через `import.meta.glob` — специю Vite, которой в обычном
 * Node нет; сборщик комплекта документации (`scripts/docs-pdf/`) запускается
 * как раз обычным Node и читает те же файлы с диска. Общим у них обязано быть
 * всё, что определяет оглавление: состав разделов, набор полей шапки, правило
 * адреса и порядок статей. Разъехаться этому нельзя — иначе справка на экране и
 * справка в PDF молча окажутся разными документами.
 *
 * Поэтому здесь нет ни одного импорта сборки: только `zod`, который одинаково
 * работает и в Vite, и в Node.
 */
import { z } from 'zod';

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
 *
 * Начало пути не проверяется: приложение приходит сюда с ключом `import.meta.glob`
 * (`./content/user/01-start.md`), сборщик комплекта — с путём файла на диске.
 * Значение имеют только три последних части.
 */
const SOURCE_PATH = /(?:^|\/)content\/(user|admin)\/\d+-([a-z0-9-]+)\.md$/;

/** Статья из исходного файла: шапка проверена, адрес и раздел сверены с путём. */
export function parseHelpArticle(path: string, source: string): HelpPage {
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
	};
}

/** Порядок статей: сначала разделы в объявленном порядке, внутри — по `order`. */
export function compareHelpPages(left: HelpPage, right: HelpPage): number {
	return left.section === right.section
		? left.order - right.order
		: HELP_SECTION_KEYS.indexOf(left.section) - HELP_SECTION_KEYS.indexOf(right.section);
}
