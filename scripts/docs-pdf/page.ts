/**
 * Печатная страница комплекта: разметка и оформление.
 *
 * Markdown разбирает тот же `marked` и та же обёртка, что собирает встроенную
 * справку (`src/lib/help/markdown.ts`), — второй разборщик означал бы, что
 * таблица из документа на экране и та же таблица в PDF когда-нибудь окажутся
 * разной разметкой. Своё здесь только то, чего на экране нет: оформление под
 * лист A4 и обращение с картинками.
 *
 * Картинки правятся уже в готовом HTML, а не подменой узлов Markdown, и на то
 * есть причина: в README половина из них написана прямо тегом `<img>` внутри
 * `<p align="center">` и таблиц, а такую разметку `marked` пропускает мимо
 * своего разбора. Правило, которое видит только `![…](…)`, молча оставило бы
 * половину README без картинок.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from '../../src/lib/help/markdown.ts';
import type { PageAsset } from './gotenberg.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Куда ведут ссылки вида `/help/user/start-1.png`: это адрес внутри стенда. */
const STATIC_ROOT = resolve(REPO_ROOT, 'static');

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/**
 * Собранные картинки документа.
 *
 * Имена плоские и нумерованные: рядом с печатаемой страницей каталогов нет, а
 * `docs/media/exchange.png` и `static/help/admin/exchange-1.png` в одном
 * документе — обычное дело.
 */
export type AssetBag = {
	/** Кладёт файл в набор и отдаёт имя, под которым на него ссылается страница. */
	add(source: string): string;
	list(): PageAsset[];
};

export function createAssetBag(): AssetBag {
	const names = new Map<string, string>();

	return {
		add(source) {
			const known = names.get(source);

			if (known !== undefined) {
				return known;
			}

			const extension = source.slice(source.lastIndexOf('.') + 1).toLowerCase();
			const name = `asset-${String(names.size + 1).padStart(3, '0')}.${extension}`;

			names.set(source, name);

			return name;
		},
		list() {
			return [...names].map(([source, name]) => ({ source, name }));
		}
	};
}

type ImageRewrite = {
	/** Путь к файлу Markdown: от него считаются относительные ссылки. */
	file: string;
	assets: AssetBag;
};

/** Значение атрибута тега. Перед именем требуется пробел: иначе `src` нашлось бы в `data-src`. */
function attribute(tag: string, name: string): string | null {
	const match = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag);

	return match === null ? null : match[1];
}

function resolveImage(source: string, file: string): string {
	const path = source.startsWith('/')
		? resolve(STATIC_ROOT, `.${source}`)
		: resolve(dirname(file), source);

	if (!existsSync(path)) {
		throw new Error(`«${file}»: картинки «${source}» нет на диске (искали ${path})`);
	}

	return path;
}

/**
 * Что делать с картинкой.
 *
 * Внешние адреса выкидываются: это бейджи состояния сборки и лицензии, они
 * живут на чужом сервере, в печатном документе ничего не значат и при сборке
 * без сети превратились бы в пустые прямоугольники. Анимация заменяется
 * подписью — в PDF от GIF остаётся первый кадр, а обещание «здесь показан
 * проход» остаётся невыполненным. Остальное приезжает файлом.
 */
function rewriteImage(tag: string, context: ImageRewrite): string {
	const source = attribute(tag, 'src');

	if (source === null) {
		throw new Error(`«${context.file}»: тег ${tag} без src`);
	}

	const alt = attribute(tag, 'alt') ?? '';

	if (/^https?:\/\//i.test(source)) {
		return '';
	}

	if (source.toLowerCase().endsWith('.gif')) {
		return `<span class="figure-note">Анимация${alt === '' ? '' : ` «${escapeHtml(alt)}»`} показана в README на GitHub; в печатный комплект она не входит.</span>`;
	}

	// Ширина и высота из разметки не переносятся: они писались под колонку
	// README шириной 900 пикселей, а здесь ширина полосы набора другая, и
	// масштабом распоряжается таблица стилей.
	return `<img src="${escapeHtml(context.assets.add(resolveImage(source, context.file)))}" alt="${escapeHtml(alt)}">`;
}

const MERMAID_BLOCK = /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g;

const MERMAID_NOTE =
	'Схема на языке Mermaid. Картинку по этому тексту рисует GitHub, ' +
	'поэтому в печатном комплекте схема приведена исходником — тем же, что читает GitHub.';

/** Markdown документа или статьи в разметку печатной страницы. */
export function renderSection(
	markdown: string,
	options: { file: string; headingOffset?: number; assets: AssetBag }
): string {
	const context: ImageRewrite = { file: options.file, assets: options.assets };

	let html = renderMarkdown(markdown, { headingOffset: options.headingOffset ?? 0 });

	html = html.replace(/<img\b[^>]*>/gi, (tag) => rewriteImage(tag, context));
	html = html.replace(
		MERMAID_BLOCK,
		(_match, code: string) =>
			`<figure class="diagram"><pre><code>${code}</code></pre><figcaption>${MERMAID_NOTE}</figcaption></figure>`
	);

	// Свёрнутый блок печатается пустым: Chromium показывает только его
	// заголовок. В документе, который нельзя развернуть, скрывать нечего.
	html = html.replaceAll('<details>', '<details open>');

	// После выброшенных бейджей остаются пустые ссылки и пустые абзацы —
	// в печати это дыры на пол-листа.
	let previous = '';

	while (previous !== html) {
		previous = html;
		html = html.replace(/<a\b[^>]*>\s*<\/a>/gi, '');
	}

	return html.replace(/<p\b[^>]*>(?:\s|&nbsp;|·|<br\s*\/?>)*<\/p>/gi, '');
}

/** Приложение с картинками: по листу на картинку, лист альбомный. */
export function renderFigures(
	figures: readonly { source: string; caption: string }[],
	options: { assets: AssetBag }
): string {
	return figures
		.map((figure) => {
			const name = options.assets.add(resolve(REPO_ROOT, figure.source));

			return `<figure class="plate"><img src="${escapeHtml(name)}" alt="${escapeHtml(figure.caption)}"><figcaption>${escapeHtml(figure.caption)}</figcaption></figure>`;
		})
		.join('\n');
}

const STYLE = `
	* { box-sizing: border-box; }
	body {
		font: 10.5pt/1.55 'Noto Sans', 'DejaVu Sans', sans-serif;
		color: #10151f;
		margin: 0;
		overflow-wrap: anywhere;
	}
	h1, h2, h3, h4, h5, h6 { line-height: 1.25; break-after: avoid; margin: 0 0 8pt; }
	h1 { font-size: 20pt; margin-top: 0; }
	h2 { font-size: 15pt; margin-top: 18pt; border-bottom: 0.5pt solid #cbd5e1; padding-bottom: 3pt; }
	h3 { font-size: 12.5pt; margin-top: 14pt; }
	h4, h5, h6 { font-size: 11pt; margin-top: 12pt; }
	p, ul, ol, dl { margin: 0 0 8pt; }
	li { margin: 0 0 3pt; }
	ul, ol { padding-left: 16pt; }
	a { color: #0b57d0; text-decoration: none; }
	hr { border: 0; border-top: 0.5pt solid #cbd5e1; margin: 14pt 0; }
	blockquote {
		margin: 0 0 8pt;
		padding: 2pt 0 2pt 10pt;
		border-left: 2pt solid #cbd5e1;
		color: #334155;
	}
	table { border-collapse: collapse; width: 100%; margin: 0 0 10pt; font-size: 8.5pt; }
	thead { display: table-header-group; }
	tr { break-inside: avoid; }
	th, td { border: 0.5pt solid #cbd5e1; padding: 3pt 4pt; text-align: left; vertical-align: top; }
	th { background: #eef2f7; font-weight: 600; }
	code {
		font-family: 'DejaVu Sans Mono', monospace;
		font-size: 0.88em;
		background: #f1f5f9;
		padding: 0 2pt;
		border-radius: 2pt;
	}
	pre {
		background: #f6f8fa;
		border: 0.5pt solid #e2e8f0;
		border-radius: 3pt;
		padding: 6pt 8pt;
		margin: 0 0 10pt;
		white-space: pre-wrap;
		font-size: 8.5pt;
		line-height: 1.4;
	}
	pre code { background: none; padding: 0; font-size: inherit; }
	img { max-width: 100%; height: auto; border: 0.5pt solid #e2e8f0; border-radius: 3pt; }
	td img, th img { border: 0; }
	figure { margin: 0 0 10pt; break-inside: avoid; }
	figcaption { font-size: 8.5pt; color: #475569; margin-top: 4pt; }
	.figure-note { display: block; font-size: 9pt; color: #475569; font-style: italic; }
	.diagram pre { margin-bottom: 4pt; }
	/* Лист приложения: картинка во всю полосу и подпись под ней. */
	.plate { break-before: page; text-align: center; }
	.plate:first-of-type { break-before: auto; }
	.plate img { border: 0.5pt solid #cbd5e1; }
	.plate figcaption { text-align: left; margin-top: 6pt; }
	.plates-title { font-size: 13pt; margin: 0 0 10pt; }
	/* Руководство: вводная часть, оглавление статей и статья с нового листа. */
	.lead { font-size: 11pt; color: #334155; }
	.lead-contents { font-size: 9.5pt; color: #334155; margin-bottom: 0; }
	.article { break-before: page; }
	/* Титул и оглавление комплекта. */
	.cover { height: 9.2in; display: flex; flex-direction: column; justify-content: center; }
	.cover-kicker { font-size: 11pt; letter-spacing: 0.08em; text-transform: uppercase; color: #475569; }
	.cover-title { font-size: 26pt; line-height: 1.2; margin: 0 0 6pt; }
	.cover-lead { font-size: 13pt; color: #334155; margin: 0 0 24pt; }
	.cover-meta { display: grid; grid-template-columns: max-content 1fr; gap: 4pt 14pt; font-size: 10pt; }
	.cover-meta dt { color: #475569; }
	.cover-meta dd { margin: 0; }
	.contents { break-before: page; }
	.contents td.number { text-align: right; white-space: nowrap; }
	.note { font-size: 9pt; color: #475569; }
`;

/** Готовая страница на печать: одна разметка для всех документов комплекта. */
export function printPage(options: { title: string; body: string }): string {
	return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(options.title)}</title>
<style>${STYLE}</style></head>
<body>${options.body}</body></html>`;
}

/**
 * Подвал печати: название документа и номер страницы внутри него. Номера
 * подставляет сам движок печати, и считает он их внутри одного файла — общей
 * сквозной нумерации у склеенного комплекта нет, поэтому подвал честно называет
 * документ, к которому относится номер, а место документа в комплекте показано
 * в оглавлении.
 *
 * Части одного документа печатаются по отдельности, и у второй части счёт
 * пошёл бы заново — «1/3» после «17/17». Поэтому вместо номера ей ставится
 * пометка `mark`: соврать о номере хуже, чем его не назвать.
 */
export function footerHtml(title: string, mark?: string): string {
	// Ширина и поля — на самой строке, а не на `body`: контейнер, в который
	// Chromium вкладывает подвал, ширины `body` не задаёт, и строка без
	// `width: 100%` съезжает в левый угол вместе с номером страницы.
	return `<!doctype html><html><head><meta charset="utf-8"><style>
		body { font: 8pt 'Noto Sans', 'DejaVu Sans', sans-serif; color: #64748b; margin: 0; }
		.line { display: flex; justify-content: space-between; width: 100%; padding: 0 0.6in; box-sizing: border-box; }
	</style></head><body><div class="line">
		<span>${escapeHtml(title)}</span>
		<span>${mark === undefined ? '<span class="pageNumber"></span>/<span class="totalPages"></span>' : escapeHtml(mark)}</span>
	</div></body></html>`;
}

export type ContentsEntry = {
	title: string;
	/** Номер листа в общем файле; `null`, пока листы ещё не посчитаны. */
	firstPage: number | null;
	pages: number;
	fileName: string;
};

/** Титул комплекта и его оглавление — первые листы общего файла. */
export function coverPage(options: {
	builtOn: string;
	commit: string;
	version: string;
	entries: readonly ContentsEntry[];
}): string {
	const rows = options.entries
		.map(
			(entry) =>
				`<tr><td>${escapeHtml(entry.title)}</td><td><code>${escapeHtml(entry.fileName)}</code></td>` +
				`<td class="number">${entry.firstPage === null ? '—' : entry.firstPage}</td>` +
				`<td class="number">${entry.pages}</td></tr>`
		)
		.join('');

	const body = `
	<section class="cover">
		<p class="cover-kicker">Комплект документации</p>
		<h1 class="cover-title">Система контроля взаимодействия с учебными заведениями</h1>
		<p class="cover-lead">Альма CRM — решение команды Wine Coding Team для хакатона «Лидеры цифровой трансформации 2026», задача ИТ Школы Ростелекома.</p>
		<dl class="cover-meta">
			<dt>Собран</dt><dd>${escapeHtml(options.builtOn)}</dd>
			<dt>Коммит</dt><dd><code>${escapeHtml(options.commit)}</code></dd>
			<dt>Версия</dt><dd>${escapeHtml(options.version)}</dd>
			<dt>Стенд</dt><dd>https://alma.volkv.com</dd>
			<dt>Исходный текст</dt><dd>docs/ и src/lib/help/content/ репозитория</dd>
		</dl>
	</section>
	<section class="contents">
		<h2>Состав комплекта</h2>
		<table>
			<thead><tr><th>Документ</th><th>Отдельный файл</th><th class="number">Лист</th><th class="number">Листов</th></tr></thead>
			<tbody>${rows}</tbody>
		</table>
		<p class="note">«Лист» — номер страницы в этом файле; в подвале страницы стоит её номер внутри своего документа, потому что документы собраны по отдельности и лежат рядом отдельными файлами.</p>
	</section>`;

	return printPage({ title: 'Комплект документации Альма CRM', body });
}
