/**
 * Запись коротких роликов README против поднятого стенда.
 *
 * Снимок показывает экран, ролик — работу: как переходят между разделами, где
 * что открывается и сколько это занимает. Записывает его тот же браузер, что
 * снимает кадры, а GIF собирает `ffmpeg` — иначе ролик пришлось бы писать
 * экранной записью с рабочего стола, и обновить его через месяц не смог бы
 * никто.
 *
 * Требуется `ffmpeg` в `PATH`. Запуск и предварительные условия —
 * `docs/readme-media.md`.
 *
 * ```
 * node scripts/readme-media/record.ts          # все ролики
 * node scripts/readme-media/record.ts tour     # только названный
 * node scripts/readme-media/record.ts --list
 * ```
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { seedId } from '../seed/ids.ts';
import type { ShotRole } from './shots.ts';

const run = promisify(execFile);

/** Куда складываются ролики: тот же каталог, на который ссылается README. */
const OUTPUT = path.join(import.meta.dirname, '..', '..', 'docs', 'media');

/**
 * Размер кадра записи.
 *
 * Меньше окна съёмки: GIF без потерь и с палитрой на кадр растёт от размера
 * быстрее, чем от длины, а README всё равно показывает ролик в 960 точек.
 */
const FRAME = { width: 1280, height: 800 } as const;

/**
 * Частота кадров готового GIF.
 *
 * Восемь, а не двадцать пять: ролик показывает переходы между экранами, а не
 * движение, и каждый лишний кадр — это ещё одна полная картинка в файле.
 * README с роликом на десять мегабайт не открывается с телефона.
 */
const FPS = 8;

/** Ширина готового GIF: та же, в какой README показывает картинки. */
const WIDTH = 900;

/**
 * Сколько цветов оставлять в палитре ролика.
 *
 * Не 256: интерфейс — это заливки, рамки и текст, а мягкие фоны темы дают
 * полутона, которых на экране всё равно не различить, зато в файле они весят.
 * Сто двадцать восемь цветов отнимают у ролика около пятой части веса и ничего
 * не меняют на глаз — README открывают с телефона, и лишний мегабайт там
 * дороже неразличимого оттенка.
 */
const COLORS = 128;

function requiredEnv(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback;

	if (value === undefined || value === '') {
		throw new Error(`Не задано ${name}: см. docs/readme-media.md`);
	}

	return value;
}

const BASE_URL = requiredEnv('MEDIA_BASE_URL', 'http://localhost:3000').replace(/\/+$/, '');
const PASSWORD = requiredEnv('SEED_DEMO_PASSWORD');

type Clip = {
	name: string;
	role: ShotRole;
	caption: string;
	play: (page: Page) => Promise<void>;
};

/** Пауза, за которую глаз успевает прочитать экран. */
const BEAT = 1200;

/** Открыть раздел и дать ему ожить и отрисоваться. */
async function visit(page: Page, address: string, expected: string): Promise<void> {
	await page.goto(`${BASE_URL}${address}`, { waitUntil: 'load' });
	await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: 20_000 });
	await page.getByText(expected).first().waitFor({ state: 'visible', timeout: 20_000 });
	await page.waitForTimeout(BEAT);
}

const CLIPS: readonly Clip[] = [
	{
		name: 'tour',
		role: 'manager',
		caption: 'Обзор: сводка, доска, карточка, отчёты, справочники, данные, справка',
		play: async (page) => {
			await visit(page, '/', 'Мой день');
			await visit(page, '/interactions', 'Взаимодействия');
			await visit(page, '/interactions?view=board', 'Взаимодействия');
			await visit(
				page,
				`/interactions/${seedId('interaction', 'batse-kontrol')}`,
				'Все стадии процесса'
			);

			// Вкладки «История» больше нет: карточка одной колонкой, и лента
			// событий стоит ниже — до неё докручивают, а не переключают вкладку.
			await page.mouse.wheel(0, 700);
			await page.waitForTimeout(BEAT);

			await visit(page, '/reports', 'Отчёты по взаимодействиям');
			await page.mouse.wheel(0, 600);
			await page.waitForTimeout(BEAT);

			await visit(page, '/organizations', 'Организации');
			await visit(page, '/data/dashboard', 'Данные');
			await visit(page, '/help', 'Руководство пользователя');
		}
	},
	{
		name: 'exchange-pass',
		role: 'admin',
		caption: 'Обмен: журнал внешних систем, процесс и его черновик изменений',
		play: async (page) => {
			await visit(page, '/exchange', 'Внешние системы');
			await page.mouse.wheel(0, 300);
			await page.waitForTimeout(BEAT);

			await visit(page, '/settings/process', 'Процесс');
			await visit(page, '/settings/process/b2b', 'Черновик изменений');
			await page.mouse.wheel(0, 900);
			await page.waitForTimeout(BEAT);
			await page.mouse.wheel(0, 900);
			await page.waitForTimeout(BEAT);
		}
	}
];

async function signIn(context: BrowserContext, login: string): Promise<void> {
	const page = await context.newPage();

	try {
		await page.goto(`${BASE_URL}/login`);
		await page.getByRole('button', { name: 'Войти', exact: true }).click();
		await page.waitForURL(/\/realms\/lct\/protocol\/openid-connect\/auth/);
		await page.locator('#username').fill(login);
		await page.locator('#password').fill(PASSWORD);
		await page.locator('#kc-login').click();
		await page.waitForURL(`${BASE_URL}/`);

		// Подсказки первого входа закрываются здесь же, на странице входа, и тем
		// же нажатием, которым их закрывает человек: браузер записи каждый раз
		// чистый, и тур открылся бы поверх первого же экрана ролика. Кнопка
		// «Позже» стоит на приветствии — первом, что видит вошедший впервые.
		// Признак «показаны» принадлежит браузеру, поэтому дальше он молчит.
		await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: 20_000 });

		const tour = page.getByTestId('onboarding-tour');

		await tour.waitFor({ state: 'visible', timeout: 20_000 });
		await tour.getByRole('button', { name: 'Позже' }).click();
		await tour.waitFor({ state: 'hidden', timeout: 20_000 });
	} finally {
		await page.close();
	}
}

/**
 * Webm в GIF.
 *
 * Палитра считается по самому ролику (`palettegen`), а не берётся стандартная:
 * интерфейс почти весь из оттенков серого и одного синего, и на общей палитре
 * из 216 цветов он покрывается рябью.
 */
async function toGif(source: string, target: string): Promise<void> {
	await run('ffmpeg', [
		'-y',
		'-i',
		source,
		'-vf',
		`fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${COLORS}:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`,
		'-loop',
		'0',
		target
	]);
}

async function record(clip: Clip): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'lct-media-'));
	const browser = await chromium.launch();

	try {
		const context = await browser.newContext({
			viewport: FRAME,
			deviceScaleFactor: 1,
			recordVideo: { dir: directory, size: FRAME }
		});

		// Вход не попадает в ролик: он идёт своей страницей, а записывать чужую
		// форму ввода пароля незачем.
		if (clip.role !== 'anonymous') {
			await signIn(context, clip.role);
		}

		const page = await context.newPage();

		await clip.play(page);

		const video = page.video();

		if (video === null) {
			throw new Error('запись видео не включилась');
		}

		// Файл дописывается при закрытии контекста, а не страницы: до этого
		// момента `path()` указывает на ещё не готовый файл.
		await context.close();

		const target = path.join(OUTPUT, `${clip.name}.gif`);

		await toGif(await video.path(), target);

		return target;
	} finally {
		await browser.close();
		await rm(directory, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args.includes('--list')) {
		for (const clip of CLIPS) {
			console.log(`${clip.name.padEnd(16)} ${clip.role.padEnd(10)} — ${clip.caption}`);
		}

		return;
	}

	const names = args.filter((argument) => !argument.startsWith('--'));
	const selected = names.length === 0 ? CLIPS : CLIPS.filter((clip) => names.includes(clip.name));
	const unknown = names.filter((name) => !CLIPS.some((clip) => clip.name === name));

	if (unknown.length > 0) {
		throw new Error(`Роликов с такими именами нет: ${unknown.join(', ')}. Список — «--list»`);
	}

	await mkdir(OUTPUT, { recursive: true });

	for (const clip of selected) {
		console.log(`${clip.name}: ${await record(clip)}`);
	}
}

await main();
