/**
 * Печатная страница комплекта документации.
 *
 * Проверяется здесь ровно то, что сборщик делает с чужим текстом: картинки,
 * которых в печати быть не может, и разметка, которую Chromium напечатал бы
 * пустой. Всё это правится регулярными выражениями по готовому HTML — потому
 * что половина картинок README написана тегом `<img>` мимо Markdown, — и
 * молчаливая осечка такого правила выглядит как дыра в документе, а не как
 * ошибка сборки.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAssetBag, renderSection, REPO_ROOT } from '../../../scripts/docs-pdf/page.ts';

const README = resolve(REPO_ROOT, 'README.md');
const HELP_ARTICLE = resolve(REPO_ROOT, 'src/lib/help/content/user/01-start.md');

describe('renderSection', () => {
	it('sends a relative image along as a flat file name', () => {
		const assets = createAssetBag();
		const html = renderSection('![Сводка](docs/media/home.png)', { file: README, assets });

		expect(html).toContain('src="asset-001.png"');
		expect(assets.list()).toEqual([
			{ source: resolve(REPO_ROOT, 'docs/media/home.png'), name: 'asset-001.png' }
		]);
	});

	it('resolves an absolute image path against the static directory', () => {
		const assets = createAssetBag();

		renderSection('![Сводка](/help/user/start-1.png)', { file: HELP_ARTICLE, assets });

		expect(assets.list()[0].source).toBe(resolve(REPO_ROOT, 'static/help/user/start-1.png'));
	});

	it('gives one name to an image used twice', () => {
		const assets = createAssetBag();
		const html = renderSection('![a](docs/media/home.png)\n\n![b](docs/media/home.png)', {
			file: README,
			assets
		});

		expect(assets.list()).toHaveLength(1);
		expect(html.match(/asset-001\.png/g)).toHaveLength(2);
	});

	it('refuses an image that is not on disk instead of printing an empty box', () => {
		expect(() =>
			renderSection('![нет](docs/media/missing.png)', { file: README, assets: createAssetBag() })
		).toThrow(/missing\.png/);
	});

	it('drops a remote badge together with the link and the paragraph it stood in', () => {
		const html = renderSection(
			'<p align="center">\n  <a href="https://example.test/ci"><img alt="CI" src="https://example.test/badge.svg"></a>\n</p>',
			{ file: README, assets: createAssetBag() }
		);

		expect(html.trim()).toBe('');
	});

	it('replaces an animation with a caption: a PDF would keep only its first frame', () => {
		const html = renderSection('<p><img src="docs/media/tour.gif" alt="Обзор"></p>', {
			file: README,
			assets: createAssetBag()
		});

		expect(html).toContain('class="figure-note"');
		expect(html).toContain('«Обзор»');
		expect(html).not.toContain('<img');
	});

	it('prints a Mermaid diagram as its own source, under a caption that says so', () => {
		const html = renderSection('```mermaid\nflowchart LR\n  A --> B\n```', {
			file: README,
			assets: createAssetBag()
		});

		expect(html).toContain('<figure class="diagram">');
		expect(html).toContain('flowchart LR');
		expect(html).toContain('Mermaid');
	});

	it('opens a collapsed block: on paper there is nothing to unfold', () => {
		const html = renderSection('<details>\n<summary>Ещё</summary>\n\nТекст внутри\n\n</details>', {
			file: README,
			assets: createAssetBag()
		});

		expect(html).toContain('<details open>');
	});

	it('shifts the headings of an article by the offset the guide needs', () => {
		const html = renderSection('## Вход', {
			file: HELP_ARTICLE,
			headingOffset: 1,
			assets: createAssetBag()
		});

		expect(html).toContain('<h3>Вход</h3>');
	});
});
