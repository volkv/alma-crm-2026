/**
 * Контракт быстрого поиска — того, что открывается по `Ctrl`/`⌘` + `K`.
 *
 * Лежит рядом с палитрой, а не в `$lib/contracts`: там описаны команды и ответы
 * предметной области — то, чем пользуются и формы, и публичный API, и из чего
 * собран OpenAPI. Поиск же — свойство оболочки: он ничего не меняет, наружу не
 * объявлен и отдаёт не записи, а дорогу к ним. Схема всё равно нужна: ответ
 * разбирает браузер, а «то, что пришло по сети» — это не тип.
 */
import { z } from 'zod';

/**
 * Что ищем. Порядок значений — порядок групп в выдаче.
 *
 * Людей и их контактов здесь нет намеренно. Персональные данные выдаются по
 * отдельному праву и под след просмотра (`docs/access-matrix.md`), а поиск,
 * который отвечает на любую строку из двух букв, таким местом быть не может:
 * след просмотра он превратил бы в шум, а маскирование — в формальность.
 */
export const SEARCH_KINDS = ['organization', 'interaction', 'program', 'product'] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

/**
 * Короче двух символов запрос не выполняется: одна буква совпадает почти со
 * всем, и пять случайных строк на группу — это не подсказка. До этой длины
 * палитра показывает разделы и на сервер не ходит вовсе.
 */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/**
 * Потолок на группу. Палитра отвечает на вопрос «как попасть отсюда туда», а не
 * «сколько таких всего»: за списком человек идёт в раздел, где есть фильтры,
 * сортировка и страницы.
 */
export const SEARCH_GROUP_LIMIT = 5;

/** Строка запроса. Пустая и односимвольная отклоняются словами, а не молча. */
export const searchQuerySchema = z
	.string({ error: 'Не указано, что искать' })
	.trim()
	.min(SEARCH_MIN_QUERY_LENGTH, {
		error: `Поисковый запрос — от ${SEARCH_MIN_QUERY_LENGTH} символов`
	})
	.max(200, { error: 'Поисковый запрос не длиннее 200 символов' });

export const searchHitSchema = z.object({
	kind: z.enum(SEARCH_KINDS),
	id: z.uuid(),
	/** Как запись называется в своём разделе. */
	title: z.string(),
	/** Чем она отличается от похожей: ИНН, код каталога, вуз и стадия. */
	subtitle: z.string().nullable()
});

export const searchResultSchema = z.object({
	/** Находки всех групп подряд, в порядке {@link SEARCH_KINDS}. */
	items: z.array(searchHitSchema)
});

export type SearchHit = z.output<typeof searchHitSchema>;
export type SearchResult = z.output<typeof searchResultSchema>;
