/**
 * Комплект документации одним файлом: `pnpm run docs:pdf`.
 *
 * Собирает `dist/docs-pdf/` — по PDF на каждый документ репозитория и общий
 * `lct-crm-documentation.pdf` с титулом и оглавлением. Печатает ту же службу,
 * что печатает отчёты и договоры в самой системе (Gotenberg, Chromium), но
 * приложение для этого не нужно: сборщик читает файлы с диска и ходит в службу
 * напрямую. Поэтому комплект собирается и там, где ни базы, ни стенда нет —
 * например, на прогоне CI.
 *
 * Источник текста — файлы репозитория, а не отдельная копия «для печати»:
 * README, `docs/*.md` и статьи встроенной справки из `src/lib/help/content/`.
 * Руководства в комплекте не могут разойтись с руководствами в системе,
 * потому что это одни и те же файлы, разобранные одним и тем же `marked`.
 *
 *   pnpm run docs:pdf                 # в dist/docs-pdf
 *   pnpm run docs:pdf -- --out build/kit
 *
 * Служба берётся из `GOTENBERG_URL` (по умолчанию http://localhost:3001 — это
 * `docker compose up -d gotenberg`).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	compareHelpPages,
	helpSection,
	parseHelpArticle,
	type HelpPage
} from '../../src/lib/help/article.ts';
import { KIT_DOCUMENTS, type KitDocument } from './documents.ts';
import { htmlToPdf, mergePdfs, pageCount, type PdfPart } from './gotenberg.ts';
import {
	coverPage,
	createAssetBag,
	footerHtml,
	printPage,
	renderFigures,
	renderSection,
	REPO_ROOT,
	type ContentsEntry
} from './page.ts';

const DEFAULT_OUT_DIR = 'dist/docs-pdf';
const MERGED_FILE_NAME = 'lct-crm-documentation.pdf';

/**
 * Сдвиг заголовков статьи справки. Над ней в документе стоят заголовок
 * руководства и заголовок самой статьи, поэтому её `##` обязан стать `h3`:
 * иначе печатное руководство получилось бы плоским списком одинаковых
 * заголовков. То же правило и на `/help/print`, только уровней там на один
 * больше — руководства там оба в одной странице.
 */
const HELP_HEADING_OFFSET = 1;

const FIRST_HEADING = /^#\s+(.+?)\s*$/m;

function documentTitle(document: KitDocument, markdown: string): string {
	if (document.kind === 'help') {
		return helpSection(document.section).title;
	}

	if (document.title !== undefined) {
		return document.title;
	}

	const heading = FIRST_HEADING.exec(markdown);

	if (heading === null) {
		throw new Error(`«${document.source}»: в тексте нет заголовка первого уровня`);
	}

	return heading[1];
}

/** Статьи раздела справки — с диска, в том же порядке, что и на `/help`. */
async function helpArticles(section: HelpPage['section']): Promise<HelpPage[]> {
	const directory = resolve(REPO_ROOT, 'src/lib/help/content', section);
	const files = (await readdir(directory)).filter((file) => file.endsWith('.md')).sort();

	const articles = await Promise.all(
		files.map(async (file) => {
			const path = resolve(directory, file);

			return parseHelpArticle(path, await readFile(path, 'utf8'));
		})
	);

	return articles.sort(compareHelpPages);
}

type BuiltDocument = {
	fileName: string;
	title: string;
	pdf: Buffer;
	pages: number;
};

/**
 * Один документ комплекта.
 *
 * Части у документа могут быть разной ориентации — текст книжный, приложение с
 * видами модели альбомное, — а одна печать Gotenberg знает только одну
 * ориентацию. Поэтому части печатаются по отдельности и склеиваются в тот же
 * единственный файл, который потом попадает и в `dist/`, и в общий комплект.
 */
async function buildDocument(document: KitDocument, position: number): Promise<BuiltDocument> {
	const assets = createAssetBag();
	const fileName = `${String(position).padStart(2, '0')}-${document.slug}.pdf`;

	let title: string;
	let body: string;

	if (document.kind === 'help') {
		const section = helpSection(document.section);
		const articles = await helpArticles(document.section);

		title = section.title;
		body = [
			`<h1>${section.title}</h1>`,
			`<p class="lead">${section.description}</p>`,
			'<ol class="lead-contents">',
			...articles.map((article) => `<li>${article.title} — ${article.summary}</li>`),
			'</ol>',
			...articles.map(
				(article) =>
					`<section class="article"><h2>${article.title}</h2>` +
					renderSection(article.markdown, {
						file: resolve(REPO_ROOT, 'src/lib/help/content', article.section, `${article.slug}.md`),
						headingOffset: HELP_HEADING_OFFSET,
						assets
					}) +
					'</section>'
			)
		].join('\n');
	} else {
		const file = resolve(REPO_ROOT, document.source);
		const markdown = await readFile(file, 'utf8');

		title = documentTitle(document, markdown);
		body = renderSection(markdown, { file, assets });
	}

	const footer = footerHtml(title);
	const parts: PdfPart[] = [
		{
			name: '1-body.pdf',
			body: await htmlToPdf({
				html: printPage({ title, body }),
				footer,
				assets: assets.list()
			})
		}
	];

	if (document.kind === 'markdown' && document.figures !== undefined) {
		const plates = createAssetBag();
		const platesHtml = `<h1 class="plates-title">Приложение. Виды модели архитектуры</h1>${renderFigures(document.figures, { assets: plates })}`;

		parts.push({
			name: '2-plates.pdf',
			body: await htmlToPdf({
				html: printPage({ title, body: platesHtml }),
				footer: footerHtml(title, 'Приложение'),
				assets: plates.list(),
				landscape: true
			})
		});
	}

	const pdf =
		parts.length === 1
			? parts[0].body
			: await mergePdfs(parts, { Title: title, Author: 'Wine Coding Team' });

	return { fileName, title, pdf, pages: await pageCount(pdf) };
}

/** Даёт строку вида `2026-09-18` — дата сборки на титуле. */
function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function headCommit(): string {
	return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
		cwd: REPO_ROOT,
		encoding: 'utf8'
	}).trim();
}

async function projectVersion(): Promise<string> {
	const manifest = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
		version: string;
	};

	return manifest.version;
}

/**
 * Титул и оглавление печатаются дважды.
 *
 * Номер листа, с которого начинается документ, зависит от того, сколько листов
 * занял сам титул с оглавлением, — а это станет известно только после печати.
 * Первый проход печатается с прочерками и нужен ровно затем, чтобы их
 * посчитать; второй — с настоящими номерами. Если объём при этом изменился,
 * номера в оглавлении стали бы враньём, и сборка останавливается.
 */
async function buildCover(
	entries: readonly ContentsEntry[],
	meta: { builtOn: string; commit: string; version: string }
): Promise<Buffer> {
	const footer = footerHtml('Комплект документации LCT CRM');
	const draft = await htmlToPdf({
		html: coverPage({ ...meta, entries }),
		footer,
		assets: []
	});
	const coverPages = await pageCount(draft);

	let nextPage = coverPages + 1;
	const numbered = entries.map((entry) => {
		const firstPage = nextPage;

		nextPage += entry.pages;

		return { ...entry, firstPage };
	});

	const cover = await htmlToPdf({
		html: coverPage({ ...meta, entries: numbered }),
		footer,
		assets: []
	});
	const numberedPages = await pageCount(cover);

	if (numberedPages !== coverPages) {
		throw new Error(
			`Оглавление с номерами заняло ${numberedPages} л. вместо ${coverPages} л.: номера листов в нём не сойдутся`
		);
	}

	return cover;
}

async function prepareOutDir(outDir: string): Promise<void> {
	await mkdir(outDir, { recursive: true });

	// Старые файлы убираются, иначе переименованный или выброшенный документ
	// остался бы в каталоге и уехал бы в артефакт вместе с новым комплектом.
	for (const file of await readdir(outDir)) {
		if (file.endsWith('.pdf')) {
			await unlink(resolve(outDir, file));
		}
	}
}

function kilobytes(body: Buffer): string {
	return `${Math.round(body.byteLength / 1024)} КиБ`;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const outIndex = args.indexOf('--out');
	const outDir = resolve(
		process.cwd(),
		outIndex === -1 ? DEFAULT_OUT_DIR : (args[outIndex + 1] ?? DEFAULT_OUT_DIR)
	);

	const meta = { builtOn: today(), commit: headCommit(), version: await projectVersion() };

	await prepareOutDir(outDir);

	const built: BuiltDocument[] = [];

	// Последовательно, а не пачкой: печать каждого документа занимает у службы
	// целый Chromium, и десяток параллельных запросов кладёт её очередь.
	for (const [position, document] of KIT_DOCUMENTS.entries()) {
		const result = await buildDocument(document, position + 1);

		await writeFile(resolve(outDir, result.fileName), result.pdf);
		built.push(result);

		console.log(
			`${result.fileName} — ${result.title}: ${result.pages} л., ${kilobytes(result.pdf)}`
		);
	}

	const cover = await buildCover(
		built.map((document) => ({
			title: document.title,
			fileName: document.fileName,
			pages: document.pages,
			firstPage: null
		})),
		meta
	);

	const merged = await mergePdfs(
		[
			{ name: '00-cover.pdf', body: cover },
			...built.map((document) => ({ name: document.fileName, body: document.pdf }))
		],
		{
			Title: 'Система контроля взаимодействия с учебными заведениями — комплект документации',
			Author: 'Wine Coding Team',
			Subject: `LCT CRM ${meta.version}, коммит ${meta.commit}, собран ${meta.builtOn}`
		}
	);

	await writeFile(resolve(outDir, MERGED_FILE_NAME), merged);

	console.log(
		`\n${MERGED_FILE_NAME} — ${await pageCount(merged)} л., ${kilobytes(merged)}\n` +
			`Каталог: ${outDir}\nКоммит: ${meta.commit}, дата сборки: ${meta.builtOn}`
	);
}

await main();
