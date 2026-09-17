/**
 * Разметка статей справки в HTML.
 *
 * Разбирает `marked` — без плагинов и без расширений синтаксиса, в режиме GFM:
 * справке нужны таблицы, а всё остальное в ней обычный Markdown. Свой
 * разборщик здесь не нужен и был бы хуже: набор разметки, который автор статьи
 * ожидает от Markdown, шире того, что успевает поддержать собственная
 * реализация, и расходиться они начнут молча — на странице, а не на сборке.
 *
 * Санитизации нет и не будет: источник статей — файлы репозитория, а не ввод
 * пользователя. Поэтому разметка HTML внутри статьи проходит как есть, и это
 * осознанное свойство, а не недосмотр.
 *
 * Разбор синхронный (`async: false`): страница собирается на сервере, и
 * асинхронный разбор означал бы обещание там, где его нечем ждать.
 */
import { Marked, type RendererObject, type Tokens } from 'marked';

/** Самый глубокий заголовок HTML: ниже `h6` разметки не бывает. */
const MAX_HEADING_LEVEL = 6;

export type MarkdownOptions = {
	/**
	 * На сколько уровней опустить заголовки статьи.
	 *
	 * Нужен печатной странице: там статья лежит не одна, и её `##` обязан
	 * оказаться глубже, чем заголовок раздела и заголовок самой статьи, — иначе
	 * оглавление документа получится плоским, а читатель PDF ориентируется по
	 * нему.
	 */
	headingOffset?: number;
};

/**
 * Единственная правка вывода `marked`: сдвиг уровня заголовков. Всё остальное
 * — его собственная разметка, и переопределять её здесь нечем и незачем.
 */
function shiftHeadings(headingOffset: number): RendererObject {
	return {
		heading(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, token) {
			const level = Math.min(token.depth + headingOffset, MAX_HEADING_LEVEL);

			return `<h${level}>${this.parser.parseInline(token.tokens)}</h${level}>\n`;
		}
	};
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
	const headingOffset = options.headingOffset ?? 0;

	// Свой экземпляр на вызов, а не общий с настройкой на лету: общий пришлось бы
	// переключать между сдвигами заголовков, и печатная страница со статьёй
	// делили бы изменяемое состояние.
	const markdown = new Marked({ gfm: true, async: false });

	if (headingOffset !== 0) {
		markdown.use({ renderer: shiftHeadings(headingOffset) });
	}

	return markdown.parse(source, { async: false });
}
