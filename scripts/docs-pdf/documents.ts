/**
 * Состав комплекта документации: что в него входит и в каком порядке.
 *
 * Список вынесен из сборщика, потому что меняется он чаще самого сборщика:
 * появился документ — здесь прибавилась строка. Порядок строк — это порядок
 * разделов в общем файле и нумерация отдельных файлов в `dist/docs-pdf/`.
 *
 * Заголовок документа берётся из его же текста — из первого `#`: два списка
 * названий разошлись бы на первой переименованной странице. Исключение одно и
 * объявлено полем `title`: у подробного описания первый заголовок содержит название
 * продукта, а в оглавлении комплекта нужно имя документа.
 */
import type { HelpSectionKey } from '../../src/lib/help/article.ts';

/** Картинка, которая приложена к документу отдельным листом. */
export type KitFigure = {
	/** Путь от корня репозитория. */
	source: string;
	caption: string;
};

export type KitDocument =
	| {
			kind: 'markdown';
			/** Имя файла в `dist/docs-pdf/` без номера и расширения. */
			slug: string;
			/** Путь от корня репозитория. */
			source: string;
			/** Имя в оглавлении, если первый заголовок текста для этого не годится. */
			title?: string;
			figures?: readonly KitFigure[];
	  }
	| {
			kind: 'help';
			slug: string;
			/** Раздел встроенной справки: его статьи идут в том же порядке, что на `/help`. */
			section: HelpSectionKey;
	  };

/**
 * Три вида модели ArchiMate. В самом `architecture.md` они стоят ссылками на
 * файлы — на экране GitHub этого достаточно, в печатном комплекте ссылка на
 * файл не открывается ничем. Поэтому виды приложены к документу листами, и
 * лист альбомный: у всех трёх ширина вдвое больше высоты, и на книжной
 * странице от них осталась бы полоска в треть листа.
 */
const ARCHIMATE_VIEWS: readonly KitFigure[] = [
	{
		source: 'docs/archi/business.png',
		caption: '1. Бизнес: роли, контрагенты, процессы b2b и b2c, объекты дела и три сцены показа'
	},
	{
		source: 'docs/archi/application.png',
		caption: '2. Приложение: транспорт, модули сервера, контракты и владельцы данных'
	},
	{
		source: 'docs/archi/technology.png',
		caption: '3. Технология: сервисы Compose, обратный прокси, контур сети и схема роста'
	}
];

export const KIT_DOCUMENTS: readonly KitDocument[] = [
	{ kind: 'markdown', slug: 'product', source: 'docs/product.md', title: 'Обзор продукта' },
	{
		kind: 'markdown',
		slug: 'architecture',
		source: 'docs/architecture.md',
		figures: ARCHIMATE_VIEWS
	},
	{ kind: 'markdown', slug: 'requirements', source: 'docs/requirements.md' },
	{ kind: 'markdown', slug: 'workflow', source: 'docs/workflow.md' },
	{ kind: 'markdown', slug: 'reports', source: 'docs/reports.md' },
	{ kind: 'markdown', slug: 'exchange-contract', source: 'docs/exchange-contract.md' },
	{ kind: 'markdown', slug: 'security', source: 'docs/security.md' },
	{ kind: 'markdown', slug: 'performance', source: 'docs/performance.md' },
	{ kind: 'markdown', slug: 'why-sveltekit', source: 'docs/why-sveltekit.md' },
	{ kind: 'markdown', slug: 'api', source: 'docs/api.md' },
	{ kind: 'markdown', slug: 'deployment', source: 'docs/deployment.md' },
	{ kind: 'markdown', slug: 'access-matrix', source: 'docs/access-matrix.md' },
	{ kind: 'markdown', slug: 'libraries', source: 'docs/libraries.md' },
	{ kind: 'help', slug: 'help-user', section: 'user' },
	{ kind: 'help', slug: 'help-admin', section: 'admin' }
];
