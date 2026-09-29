/**
 * Механика съёмки проходов по стенду: браузер, сессии ролей, курсор в кадре,
 * запись сцены под её закадровый текст, склейка, кадры, таймкоды и субтитры.
 *
 * Проходов два — скринкаст показа (`screencast.ts`) и полный обзор
 * (`overview.ts`), — а снимаются они одинаково: сцена идёт своей ролью в своём
 * контексте браузера, длится не меньше, чем читается её реплика, и в конце
 * каждая лежит в одном ролике с таймкодами. Сюжетные действия, которые у двух
 * проходов общие, — `acts.ts`.
 *
 * Модуль ничего не делает при импорте, кроме чтения окружения: адрес стенда и
 * пароль демонстрационных записей нужны каждой сцене, и отсутствие их должно
 * остановить запуск до первого открытого браузера.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
	chromium,
	type Browser,
	type BrowserContext,
	type Locator,
	type Page
} from '@playwright/test';

export const run = promisify(execFile);

/**
 * Размер кадра записи: 1280×800.
 *
 * Не 1440×900, хотя таблицы отчёта и процесса в широком окне помещаются целиком.
 * Ролик смотрят на проекторе в зале и в окне видеовстречи, то есть уменьшенным
 * вдвое, и решает не то, сколько колонок влезло, а читается ли подпись под
 * числом. В окне 1280 текст занимает вдвое большую долю кадра, чем в 1920, а
 * раскладка остаётся той же, в которой сняты кадры встроенной справки, — то
 * есть ролик и справка показывают один и тот же экран. Широкие таблицы за это
 * платят горизонтальной прокруткой; она видна в кадре и это честнее, чем
 * нечитаемый мелкий шрифт.
 */
export const FRAME = { width: 1280, height: 800 } as const;

/** Язык страницы записи; тем же языком браузер представляется каталогу. */
const LOCALE = 'ru-RU';

/**
 * Язык самого браузера.
 *
 * Подписи, которые рисует не приложение, а Chromium, — кнопка выбора файла и
 * порядок частей в поле даты — берутся из языка сборки, а не из языка страницы.
 * Их русский требует трёх вещей сразу: полной сборки Chromium вместо
 * «headless shell» (в ней нет файлов локалей вовсе), ключа `--lang` и
 * переменных окружения запуска. Без любой из трёх в кадре остаётся
 * «Choose File» и дата вида 10/01/2026.
 */
const BROWSER_LANGUAGE = { LANGUAGE: 'ru', LC_ALL: 'ru_RU.UTF-8', LANG: 'ru_RU.UTF-8' } as const;

/** Частота кадров готового файла: движение курсора на восьми кадрах рвётся. */
const FPS = 25;

/**
 * Пауза, за которую глаз успевает прочитать экран.
 *
 * Полторы секунды, а не столько, сколько нужно на чтение абзаца: ролик
 * показывают с голосом, и на ключевом состоянии его держит закадровый текст, а
 * не запись. Ускорений нет вовсе — ускоренный интерфейс выглядит быстрее, чем
 * он есть, и это враньё.
 */
const BEAT = 1200;

/** Сколько ждать появления экрана или результата действия. */
export const WAIT = 30_000;

/**
 * Темп чтения закадра: слов в минуту.
 *
 * По нему считается, сколько сцена обязана длиться, чтобы её реплику успели
 * прочитать вслух. Сто сорок — спокойная речь без спешки; диктор, читающий
 * быстрее, получит паузу в конце сцены, а не обрезанную фразу.
 */
const WORDS_PER_MINUTE = 140;

/**
 * Хвост сцены: столько тишины после последнего слова реплики.
 *
 * Секунда с небольшим, а не мгновение: первые кадры контекста уходят на запуск
 * записи, и без запаса сцена в файле оказывается короче прочитанной реплики.
 */
const TAIL_SECONDS = 1.2;

/**
 * Во сколько раз паузы `beat` сцены могут растянуться под её реплику.
 *
 * Потолок нужен сценам-слайдам: у них одно действие на всю реплику, и
 * растяжение без предела превратило бы секундный такт в полминуты молчаливого
 * ожидания внутри действия вместо ровного показа слайда.
 */
const PACE_MAX = 3;

/**
 * Темп текущей сцены и сумма её пауз в тактах без растяжения.
 *
 * Действие сцены короче её реплики: без растяжения оно заканчивалось раньше, и
 * запись стояла на последнем кадре, пока голос договаривал, — картинка
 * обгоняла звук. Растяжение пауз ведёт действие вдоль всей реплики.
 */
let pace = 1;
let beaten = 0;

/** Замер прошлой записи сцены: действие без растяжения и сумма пауз, секунды. */
type Measured = { acted: number; beats: number };
type Pacing = Map<string, Measured>;

/**
 * Замеры прошлой записи из `pacing.json` каталога прохода. Файла нет — проход
 * снимается впервые, паузы идут без растяжения, а запись оставляет замеры для
 * следующей.
 */
async function readPacing(file: string): Promise<Pacing> {
	let raw: string;

	try {
		raw = await readFile(file, 'utf8');
	} catch (failure) {
		if ((failure as NodeJS.ErrnoException).code === 'ENOENT') {
			return new Map();
		}

		throw failure;
	}

	return new Map(Object.entries(JSON.parse(raw) as Record<string, Measured>));
}

/** Темп сцены: паузы растягиваются так, чтобы действие заняло реплику целиком. */
function paceFor<S>(scene: Scene<S>, timing: Timing | null, pacing: Pacing): number {
	const measured = pacing.get(scene.name);

	if (measured === undefined || measured.beats <= 0) {
		return 1;
	}

	const room = readingSeconds(scene, timing) - TAIL_SECONDS - measured.acted;

	return Math.min(PACE_MAX, 1 + Math.max(0, room) / measured.beats);
}

function requiredEnv(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback;

	if (value === undefined || value === '') {
		throw new Error(`Не задано ${name}: см. docs/readme-media.md`);
	}

	return value;
}

export const BASE_URL = requiredEnv('MEDIA_BASE_URL', 'http://localhost:3000').replace(/\/+$/, '');
const PASSWORD = requiredEnv('SEED_DEMO_PASSWORD');

/** Кем открыт экран; вход идёт демонстрационной записью каталога. */
export type Role = 'manager' | 'lead' | 'admin';

/** Открытая сессия роли: куки каталога и приложения, снятые заранее. */
type Session = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Снятые заранее сессии всех ролей прохода. */
export type Sessions = Map<Role, Session>;

/**
 * Коллеги в сцене: вторая роль, которая работает с тем же делом в то же
 * время, но в кадр не попадает.
 *
 * Живую карточку одной сессией не показать: «сейчас в карточке» и комментарий,
 * пришедший без перезагрузки, — это след чужой работы. Коллега входит своей
 * снятой заранее сессией, в своём браузере без записи, и уходит вместе с
 * концом сцены.
 */
export type Crew = {
	/** Открыть адрес стенда от имени роли и дождаться, что страница ожила. */
	join: (role: Role, address: string) => Promise<Page>;
	/**
	 * Черновой каталог прохода: вложения, которые сцена прикладывает, и файлы,
	 * которые она скачивает. Стирается в конце съёмки.
	 */
	work: string;
};

export type Scene<S> = {
	name: string;
	role: Role;
	caption: string;
	/**
	 * Реплика закадра, по фразе на строку.
	 *
	 * Она же задаёт минимальную длину сцены и она же уезжает в субтитры: текст
	 * и запись обязаны переписываться вместе, иначе субтитры расходятся с
	 * картинкой молча.
	 */
	narration: readonly string[];
	/** Сцена начинается со входа в кадре: сессия ей не передаётся. */
	signsIn?: boolean;
	play: (page: Page, stand: S, crew: Crew) => Promise<void>;
};

/**
 * Курсор в кадре.
 *
 * Playwright двигает настоящую мышь страницы, но своего курсора у записи нет:
 * в ролике кнопки нажимались бы сами собой. Пятно рисуется страницей по тем же
 * событиям мыши, которые получает интерфейс, поэтому оно всегда там, где
 * произошло нажатие, а не там, где его ожидал сценарий.
 */
const CURSOR = `
(() => {
	const draw = () => {
		const dot = document.createElement('div');

		Object.assign(dot.style, {
			position: 'fixed',
			left: '0',
			top: '0',
			width: '22px',
			height: '22px',
			marginLeft: '-11px',
			marginTop: '-11px',
			borderRadius: '50%',
			border: '2px solid rgba(255, 79, 18, 0.95)',
			background: 'rgba(255, 79, 18, 0.25)',
			boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.65)',
			pointerEvents: 'none',
			zIndex: '2147483647',
			transform: 'translate(-100px, -100px)'
		});

		document.body.appendChild(dot);

		addEventListener(
			'mousemove',
			(event) => {
				dot.style.transform = 'translate(' + event.clientX + 'px, ' + event.clientY + 'px)';
			},
			true
		);
		addEventListener('mousedown', () => (dot.style.background = 'rgba(255, 79, 18, 0.75)'), true);
		addEventListener('mouseup', () => (dot.style.background = 'rgba(255, 79, 18, 0.25)'), true);
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', draw);
	} else {
		draw();
	}
})();
`;

/** Слов в реплике: по ним считается и длина сцены, и доля каждой фразы в ней. */
function words(line: string): number {
	return line.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word)).length;
}

/**
 * Длительности начитанных реплик: секунды звучания по имени сцены.
 *
 * Пока голоса нет, длину реплики даёт темп `WORDS_PER_MINUTE`. Когда реплики
 * уже начитаны, сцене нужна их настоящая длина: живой голос читает не ровно
 * сто сорок слов в минуту, и сцена по расчёту либо обрывает фразу, либо тянет
 * лишнюю паузу.
 */
type Timing = ReadonlyMap<string, number>;

/**
 * Длительности из файла `NARRATION_TIMING` — JSON `{ "<сцена>": секунды }`.
 *
 * Файл описывает проход целиком: сцена без длительности или длительность сцены,
 * которой в проходе нет, — ошибка до запуска браузера. Иначе ролик молча снялся
 * бы частью по голосу, частью по расчёту.
 */
async function narrationTiming<S>(scenes: readonly Scene<S>[]): Promise<Timing | null> {
	const file = process.env.NARRATION_TIMING;

	if (file === undefined || file === '') {
		return null;
	}

	const raw: unknown = JSON.parse(await readFile(file, 'utf8'));

	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error(`${file}: ожидается объект «сцена → секунды»`);
	}

	const timing = new Map(Object.entries(raw));
	const names = new Set(scenes.map((scene) => scene.name));

	for (const name of names) {
		const seconds = timing.get(name);

		if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
			throw new Error(`${file}: нет длительности реплики сцены «${name}»`);
		}
	}

	for (const name of timing.keys()) {
		if (!names.has(name)) {
			throw new Error(`${file}: сцены «${name}» в проходе нет`);
		}
	}

	return timing as Timing;
}

/** Сколько секунд сцена обязана длиться, чтобы её реплика прозвучала целиком. */
function readingSeconds<S>(scene: Scene<S>, timing: Timing | null): number {
	const spoken =
		timing?.get(scene.name) ??
		(scene.narration.reduce((sum, line) => sum + words(line), 0) / WORDS_PER_MINUTE) * 60;

	return spoken + TAIL_SECONDS;
}

/** Пауза в долях такта: 1 — «дать прочитать», 0.5 — «не частить». */
export async function beat(page: Page, times = 1): Promise<void> {
	beaten += (BEAT * times) / 1000;
	await page.waitForTimeout(Math.round(BEAT * times * pace));
}

/** Дождаться, что страница приложения ожила: SvelteKit закончил гидратацию. */
export async function hydrated(page: Page): Promise<void> {
	await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });
}

/** Подвести курсор к элементу — видимым движением, а не прыжком. */
export async function pointAt(page: Page, target: Locator): Promise<void> {
	// Ожидание видимости — не перестраховка: сразу после гидратации SvelteKit
	// заменяет разметку целиком, и элемент, найденный мгновением раньше, к
	// моменту измерения уже не тот.
	await target.waitFor({ state: 'visible', timeout: WAIT });
	await target.scrollIntoViewIfNeeded();

	const box = await target.boundingBox();

	if (box === null) {
		throw new Error('Элемента нет на экране: подвести к нему курсор не к чему');
	}

	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
	await page.waitForTimeout(260);
}

/** Нажать так, как нажимает человек: сначала довести курсор, потом кликнуть. */
export async function press(page: Page, target: Locator): Promise<void> {
	await target.waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, target);
	await target.click();
}

/** Открыть раздел и дождаться, пока он оживёт и покажет то, ради чего открыт. */
export async function visit(
	page: Page,
	address: string,
	expected: string,
	options: { standalone?: boolean } = {}
): Promise<void> {
	await page.goto(`${BASE_URL}${address}`, { waitUntil: 'load' });

	if (options.standalone !== true) {
		await hydrated(page);
	}

	await page.getByText(expected).first().waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 0.8);
}

/** Прокрутка «как рукой»: несколько коротких движений вместо одного прыжка. */
export async function scroll(page: Page, distance: number, steps = 5): Promise<void> {
	for (let step = 0; step < steps; step += 1) {
		await page.mouse.wheel(0, distance / steps);
		await page.waitForTimeout(80);
	}

	await beat(page, 0.4);
}

/**
 * Вход через каталог учётных записей: наша страница входа сама уводит на форму
 * Keycloak, возврат в приложение. В кадре (`typed`) сцена начинается с формы
 * каталога и нажимает кнопку роли в блоке быстрого входа демо-стенда — ту же,
 * что нажимает зритель; вне кадра имя и пароль вводятся в поля. Другого входа в системе нет, и подделанная сессия
 * снимала бы систему, которой не существует.
 *
 * Браузер входа каждый раз чистый, поэтому сразу после возврата в приложение
 * открывается приветствие подсказок — и закрывается кнопкой «Позже», тем же
 * нажатием, что и у человека, до начала сцены. Признак «показаны» не подкладывается в хранилище:
 * скрытого выключателя в продукте нет (`e2e/helpers/onboarding.ts`,
 * `scripts/readme-media/capture.ts`). Для сессий, снятых заранее
 * (`storageFor`), это гашение не входит в запись вовсе; во входе в кадре оно
 * добавляет к сцене меньше секунды.
 */
export async function signIn(page: Page, login: Role, typed: boolean): Promise<void> {
	await page.goto(`${BASE_URL}/login`);
	await page.waitForURL(/\/realms\/lct\/protocol\/openid-connect\/auth/, { timeout: WAIT });

	if (typed) {
		// Кнопки роли дорисовывает скрипт темы каталога; пароль за ними — тот,
		// с которым каталог заводил демо-записи.
		const roleButton = page.locator(`[data-testid="demo-sign-in"] button[data-login="${login}"]`);

		await roleButton.waitFor({ state: 'visible', timeout: WAIT });
		await beat(page, 1.2);
		await press(page, roleButton);
	} else {
		await page.locator('#username').fill(login);
		await page.locator('#password').fill(PASSWORD);
		await page.locator('#kc-login').click();
	}

	await page.waitForURL(`${BASE_URL}/`, { timeout: WAIT });

	await hydrated(page);

	const tour = page.getByTestId('onboarding-tour');

	await tour.waitFor({ state: 'visible', timeout: WAIT });
	await tour.getByRole('button', { name: 'Позже' }).click();
	await tour.waitFor({ state: 'hidden', timeout: WAIT });
}

/**
 * Сессия роли, снятая заранее.
 *
 * Вход в кадре нужен ровно там, где в ролике меняется роль и это стоит
 * показать. Остальные сцены начинаются с уже открытой сессии: записи чужой
 * формы ввода пароля подряд не рассказывают о продукте ничего.
 */
async function storageFor(browser: Browser, login: Role): Promise<Session> {
	const context = await browser.newContext({ viewport: FRAME, locale: LOCALE });

	try {
		const page = await context.newPage();

		await signIn(page, login, false);
		await page.close();

		return await context.storageState();
	} finally {
		await context.close();
	}
}

/** Снятая сессия роли; её отсутствие — ошибка сценария, а не повод войти ещё раз. */
function session(storage: Sessions, role: Role): Session {
	const state = storage.get(role);

	if (state === undefined) {
		throw new Error(`Сессия роли «${role}» не открыта`);
	}

	return state;
}

/**
 * Поработать на стенде от имени роли вне записи: возврат стенда после прохода
 * идёт тем же интерфейсом и теми же правами, что и сама запись.
 */
export async function withRole(
	browser: Browser,
	storage: Sessions,
	role: Role,
	work: (page: Page) => Promise<void>
): Promise<void> {
	const context = await browser.newContext({
		viewport: FRAME,
		locale: LOCALE,
		storageState: session(storage, role)
	});

	try {
		await work(await context.newPage());
	} finally {
		await context.close();
	}
}

/**
 * Карточка ролика — обычная страница стенда, а не картинка.
 *
 * Стили берутся у самого приложения: карточка обязана быть в тех же цветах,
 * шрифте и ритме, что экран, который появится следующим кадром, — иначе ролик
 * начинается с чужой заставки. Адрес карточки принадлежит стенду, но до стенда
 * не доходит: запрос перехватывается здесь же, поэтому на сервере такой
 * страницы заводить не нужно, а относительные адреса шрифтов и стилей всё
 * равно разрешаются.
 */
const CARD_PATH = '/__screencast-card';

async function appStyles(context: BrowserContext): Promise<string[]> {
	const response = await context.request.get(`${BASE_URL}/login`);
	const html = await response.text();
	const links = [...html.matchAll(/<link\b[^>]*>/gu)]
		.filter((tag) => tag[0].includes('stylesheet'))
		.map((tag) => /href="([^"]+)"/u.exec(tag[0])?.[1])
		.filter((href): href is string => href !== undefined);

	if (links.length === 0) {
		throw new Error('На странице входа нет ни одной таблицы стилей: карточку не в чем рисовать');
	}

	return links.map((href) => new URL(href, `${BASE_URL}/login`).href);
}

function card(styles: readonly string[], body: string): string {
	return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
${styles.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n')}
<style>
	body {
		margin: 0;
		height: 100vh;
		display: flex;
		align-items: center;
		background: var(--color-canvas);
		color: var(--color-foreground);
		font-family: var(--font-sans);
	}
	.card { padding: 0 96px; max-width: 1040px; }
	.rule { width: 96px; height: 6px; border-radius: 999px; background: var(--color-primary); }
	.kicker {
		margin: 28px 0 0;
		font-size: 18px;
		letter-spacing: 0.02em;
		color: var(--color-muted-foreground);
	}
	h1 { margin: 16px 0 0; font-size: 46px; line-height: 1.15; font-weight: 700; }
	.lead { margin: 24px 0 0; font-size: 24px; line-height: 1.4; color: var(--color-muted-foreground); }
	ul { margin: 28px 0 0; padding: 0; list-style: none; font-size: 21px; line-height: 1.75; }
	li b { font-weight: 500; }
	.accent { color: var(--color-primary); }
	.foot { margin: 36px 0 0; font-size: 18px; color: var(--color-faint); }
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

/** Показать титульную или финальную карточку ролика: разметка тела — у прохода. */
export async function showCard(page: Page, body: string): Promise<void> {
	const styles = await appStyles(page.context());

	await page.route(`${BASE_URL}${CARD_PATH}`, (route) =>
		route.fulfill({ contentType: 'text/html; charset=utf-8', body: card(styles, body) })
	);
	await page.goto(`${BASE_URL}${CARD_PATH}`, { waitUntil: 'load' });
	// Шрифт приложения приезжает с того же стенда: без ожидания первый кадр
	// карточки успевает показать запасную гарнитуру.
	await page.evaluate(() => document.fonts.ready);
}

/**
 * Слайд презентации на весь кадр: PNG страницы колоды.
 *
 * Адрес — тот же, что у карточки, и так же не доходит до сервера. Кадр
 * 16:10, слайд 16:9: слайд встаёт по ширине, сверху и снизу — тёмные поля.
 */
export async function showSlide(page: Page, file: string): Promise<void> {
	const image = (await readFile(file)).toString('base64');
	const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
	html, body { margin: 0; height: 100%; background: #1c1d22; }
	body { display: flex; align-items: center; justify-content: center; }
	img { display: block; width: 100%; height: auto; }
</style></head><body><img src="data:image/png;base64,${image}" alt=""></body></html>`;

	await page.route(`${BASE_URL}${CARD_PATH}`, (route) =>
		route.fulfill({ contentType: 'text/html; charset=utf-8', body })
	);
	await page.goto(`${BASE_URL}${CARD_PATH}`, { waitUntil: 'load' });
}

/**
 * Страница «скана» для вложения: заголовок и строки текста на светлом листе.
 *
 * Рисует её `ffmpeg`, которым и так собирается видео: заводить ради одного
 * файла зависимость незачем, а прикладывать к делу пустой файл — значит
 * показывать работу, которой не было.
 */
export async function drawScan(
	directory: string,
	name: string,
	lines: readonly [string, ...string[]]
): Promise<string> {
	const file = path.join(directory, name);
	const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
	const [heading, ...rest] = lines;
	const line = (text: string, y: number, size: number) =>
		`drawtext=fontfile=${font}:text='${text}':fontcolor=0x2a2a2a:fontsize=${size}:x=90:y=${y}`;

	await run('ffmpeg', [
		'-y',
		'-loglevel',
		'error',
		'-f',
		'lavfi',
		'-i',
		'color=c=0xf4f4f4:s=1240x1754',
		'-frames:v',
		'1',
		'-vf',
		[
			line(heading, 180, 64),
			...rest.map((text, index) => line(text, 290 + index * 80, index === 0 ? 38 : 34))
		].join(','),
		file
	]);

	return file;
}

/** Webm Playwright — в mp4 с H.264: его открывает и презентация, и браузер. */
async function toMp4(source: string, target: string): Promise<void> {
	await run('ffmpeg', [
		'-y',
		'-loglevel',
		'error',
		'-i',
		source,
		'-c:v',
		'libx264',
		'-preset',
		'slow',
		'-crf',
		'20',
		'-pix_fmt',
		'yuv420p',
		'-fps_mode',
		'cfr',
		'-r',
		String(FPS),
		'-vf',
		`scale=${FRAME.width}:${FRAME.height}`,
		'-movflags',
		'+faststart',
		target
	]);
}

async function durationOf(file: string): Promise<number> {
	const { stdout } = await run('ffprobe', [
		'-v',
		'error',
		'-show_entries',
		'format=duration',
		'-of',
		'default=noprint_wrappers=1:nokey=1',
		file
	]);

	return Number.parseFloat(stdout.trim());
}

/**
 * Ключевой кадр сцены: её конец, а не середина.
 *
 * Сцена кончается тем состоянием, ради которого снята, — подтверждением,
 * применённым процессом, готовым файлом. Полутора секунд от конца хватает,
 * чтобы не попасть на переход к следующей сцене.
 */
async function grabFrame(file: string, at: number, target: string): Promise<void> {
	await run('ffmpeg', [
		'-y',
		'-loglevel',
		'error',
		'-ss',
		at.toFixed(2),
		'-i',
		file,
		'-frames:v',
		'1',
		target
	]);
}

export function timecode(seconds: number): string {
	const whole = Math.floor(seconds);

	return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

/** Метка субтитра: часы, минуты, секунды и миллисекунды через запятую. */
function srtStamp(seconds: number): string {
	const whole = Math.floor(seconds);
	const ms = Math.round((seconds - whole) * 1000);
	const pad = (value: number, size = 2) => String(value).padStart(size, '0');

	return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)},${pad(ms, 3)}`;
}

/** Сцена в готовом ролике: где начинается и сколько длится. */
export type Mark<S> = { scene: Scene<S>; file: string; start: number; seconds: number };

/**
 * Субтитры из того же текста, которым мерили сцену.
 *
 * Внутри сцены фразы делят её время по числу слов: у записи нет ни голоса, ни
 * его разметки, и другого основания дать длинной фразе больше времени, чем
 * короткой, тоже нет. Файл — подсказка диктору и запасной вариант показа без
 * звука, а не расшифровка озвучки: после записи голоса метки уточняют по нему.
 */
function subtitles<S>(parts: readonly Mark<S>[]): string {
	const cues: string[] = [];
	let index = 0;

	for (const part of parts) {
		const total = part.scene.narration.reduce((sum, line) => sum + words(line), 0);

		if (total === 0) {
			continue;
		}

		let at = part.start;

		for (const line of part.scene.narration) {
			const length = (words(line) / total) * part.seconds;

			index += 1;
			cues.push(`${index}\n${srtStamp(at)} --> ${srtStamp(at + length)}\n${line}\n`);
			at += length;
		}
	}

	return `${cues.join('\n')}`;
}

/**
 * Запись одной сцены.
 *
 * Своя сессия и свой контекст на сцену: роль в ролике меняется целиком — вместе
 * с меню, правами и набором экранов, — и половинчатая смена показывала бы
 * систему, в которую так не входят. Сцена не кончается раньше, чем дочитана её
 * реплика: закадровый текст задаёт нижнюю границу, а не подгоняется под
 * картинку.
 */
async function record<S>(
	browser: Browser,
	scene: Scene<S>,
	stand: S,
	storage: Sessions,
	directory: string,
	timing: Timing | null,
	pacing: Pacing
): Promise<{ file: string; measured: Measured }> {
	const context = await browser.newContext({
		viewport: FRAME,
		deviceScaleFactor: 1,
		locale: LOCALE,
		recordVideo: { dir: directory, size: FRAME },
		storageState: scene.signsIn === true ? undefined : session(storage, scene.role),
		acceptDownloads: true
	});

	await context.addInitScript({ content: CURSOR });

	const page = await context.newPage();
	const video = page.video();

	if (video === null) {
		await context.close();

		throw new Error('Запись видео не включилась');
	}

	const colleagues: BrowserContext[] = [];
	const crew: Crew = {
		join: async (role, address) => {
			const colleague = await browser.newContext({
				viewport: FRAME,
				locale: LOCALE,
				storageState: session(storage, role)
			});

			colleagues.push(colleague);

			const other = await colleague.newPage();

			await other.goto(`${BASE_URL}${address}`, { waitUntil: 'load' });
			await hydrated(other);

			return other;
		},
		work: directory
	};

	pace = paceFor(scene, timing, pacing);
	beaten = 0;

	const startedAt = Date.now();
	let acted: number;

	try {
		await page.mouse.move(FRAME.width / 2, FRAME.height / 2);
		await scene.play(page, stand, crew);

		acted = (Date.now() - startedAt) / 1000;

		const left = readingSeconds(scene, timing) * 1000 - (Date.now() - startedAt);

		if (left > 0) {
			await page.waitForTimeout(left);
		}
	} catch (failure) {
		await context.close();

		throw failure;
	} finally {
		for (const colleague of colleagues) {
			await colleague.close();
		}
	}

	// Действие и реплика печатаются рядом: сцена, которую держит действие, а не
	// текст, — первая, где искать лишние секунды ролика.
	console.log(
		`${scene.name}: действие ${acted.toFixed(1)} с, реплика ${readingSeconds(scene, timing).toFixed(1)} с, темп ×${pace.toFixed(2)}`
	);

	// Замер без растяжения: следующая запись считает темп от него, а не от
	// уже растянутого действия.
	const measured = { acted: acted - beaten * (pace - 1), beats: beaten };

	// Файл дописывается при закрытии контекста, а не страницы.
	await context.close();

	const target = path.join(directory, `${scene.name}.mp4`);

	await toMp4(await video.path(), target);

	return { file: target, measured };
}

export type Pass<S> = {
	/** Сцены в порядке ролика. */
	scenes: readonly Scene<S>[];
	/** Что проход заводит и меняет на стенде; сцены передают это друг другу. */
	stand: S;
	/** Каталог вне репозитория, куда ложатся ролик, кадры, таймкоды и субтитры. */
	output: string;
	/** Имя файла ролика в `output`. */
	file: string;
	/** Что из прохода попадает в `timecodes.json` сверх сцен: ключи заведённых записей. */
	summary: (stand: S) => Record<string, string>;
	/**
	 * Вернуть стенд: зовётся и после удачной записи, и после обрыва — сцена,
	 * упавшая посередине, не должна оставлять стенд в промежуточном виде.
	 */
	restore: (browser: Browser, stand: S, storage: Sessions) => Promise<void>;
};

/** Список сцен с ролью и длиной реплики — без браузера и без стенда. */
function list<S>(scenes: readonly Scene<S>[], timing: Timing | null): void {
	for (const scene of scenes) {
		const seconds = readingSeconds(scene, timing).toFixed(1);

		console.log(
			`${scene.name.padEnd(14)} ${scene.role.padEnd(8)} ${seconds.padStart(5)} с — ${scene.caption}`
		);
	}

	const total = scenes.reduce((sum, scene) => sum + readingSeconds(scene, timing), 0);
	const spoken = scenes.reduce(
		(sum, scene) => sum + scene.narration.reduce((count, line) => count + words(line), 0),
		0
	);

	console.log(`\nзакадр: ${spoken} слов, не меньше ${timecode(total)} записи`);
}

/**
 * Снять проход целиком: сессии ролей, сцена за сценой, склейка, ключевые
 * кадры, `timecodes.json` и `subtitles.srt`, затем возврат стенда.
 *
 * `--only=a,b` снимает только названные сцены — проверка сцены без прохода
 * целиком; сцене, которой нужен итог предыдущих, это не поможет.
 * С ключом `--list` печатает сцены и ничего не снимает, с `--narration` —
 * реплики сцен в JSON, по которым их начитывают. Длина сцен берётся из
 * `NARRATION_TIMING`, если он задан. Возвращает сцены с их местом в ролике,
 * `null` — если ролик не снимался.
 */
export async function film<S>(pass: Pass<S>): Promise<Mark<S>[] | null> {
	const flags = process.argv.slice(2);

	if (flags.includes('--narration')) {
		const scenes = pass.scenes.map((scene) => ({
			scene: scene.name,
			narration: scene.narration
		}));

		console.log(JSON.stringify({ scenes }, null, '\t'));

		return null;
	}

	const only = flags.find((flag) => flag.startsWith('--only='))?.slice('--only='.length);
	const scenes =
		only === undefined
			? pass.scenes
			: pass.scenes.filter((scene) => only.split(',').includes(scene.name));

	if (only !== undefined && scenes.length !== only.split(',').length) {
		throw new Error(`--only: в проходе нет части сцен из «${only}»`);
	}

	const timing = await narrationTiming(pass.scenes);
	const pacingFile = path.join(pass.output, 'pacing.json');
	const pacing = await readPacing(pacingFile);

	if (flags.includes('--list')) {
		list(scenes, timing);

		return null;
	}

	const work = await mkdtemp(path.join(tmpdir(), 'lct-film-'));

	await mkdir(path.join(pass.output, 'frames'), { recursive: true });

	const browser = await chromium.launch({
		// Полная сборка вместо «headless shell»: только в ней есть файлы локалей,
		// без которых подписи браузера в кадре остаются английскими.
		channel: 'chromium',
		args: [`--lang=${LOCALE}`],
		env: { ...process.env, ...BROWSER_LANGUAGE } as Record<string, string>
	});
	const storage: Sessions = new Map();

	try {
		for (const role of ['manager', 'lead', 'admin'] as const) {
			storage.set(role, await storageFor(browser, role));
		}

		const parts: { scene: Scene<S>; file: string; seconds: number }[] = [];

		for (const scene of scenes) {
			const { file, measured } = await record(
				browser,
				scene,
				pass.stand,
				storage,
				work,
				timing,
				pacing
			);
			const seconds = await durationOf(file);

			pacing.set(scene.name, {
				acted: Number(measured.acted.toFixed(2)),
				beats: Number(measured.beats.toFixed(2))
			});

			parts.push({ scene, file, seconds });
			console.log(`${scene.name}: ${seconds.toFixed(1)} с`);
		}

		const concat = path.join(work, 'parts.txt');

		await writeFile(concat, parts.map((part) => `file '${part.file}'`).join('\n'), 'utf8');

		const target = path.join(pass.output, pass.file);

		await run('ffmpeg', [
			'-y',
			'-loglevel',
			'error',
			'-f',
			'concat',
			'-safe',
			'0',
			'-i',
			concat,
			'-c',
			'copy',
			target
		]);

		let offset = 0;
		const marks: Mark<S>[] = parts.map((part) => {
			const start = offset;

			offset += part.seconds;

			return { ...part, start };
		});

		for (const mark of marks) {
			await grabFrame(
				target,
				Math.max(mark.start, mark.start + mark.seconds - 1.5),
				path.join(pass.output, 'frames', `${mark.scene.name}.png`)
			);
		}

		const timecodes = {
			file: target,
			recordedAt: new Date().toISOString(),
			baseUrl: BASE_URL,
			frame: FRAME,
			totalSeconds: Number(offset.toFixed(2)),
			total: timecode(offset),
			...pass.summary(pass.stand),
			scenes: marks.map((mark) => ({
				scene: mark.scene.name,
				role: mark.scene.role,
				caption: mark.scene.caption,
				start: timecode(mark.start),
				end: timecode(mark.start + mark.seconds),
				seconds: Number(mark.seconds.toFixed(2)),
				narration: mark.scene.narration
			}))
		};

		await writeFile(
			path.join(pass.output, 'timecodes.json'),
			`${JSON.stringify(timecodes, null, '\t')}\n`,
			'utf8'
		);
		await writeFile(path.join(pass.output, 'subtitles.srt'), subtitles(marks), 'utf8');
		await writeFile(
			pacingFile,
			`${JSON.stringify(Object.fromEntries(pacing), null, '\t')}\n`,
			'utf8'
		);

		console.log(`\n${target}`);
		console.log(`длительность: ${timecode(offset)}\n`);

		for (const mark of marks) {
			console.log(
				`${timecode(mark.start)}–${timecode(mark.start + mark.seconds)}  ${mark.scene.name.padEnd(14)} ${mark.scene.caption}`
			);
		}

		return marks;
	} catch (failure) {
		// Отказ печатается здесь, а не только пробрасывается: следом идёт возврат
		// стенда, и его собственная неудача иначе заменила бы собой причину.
		console.error(
			`проход прерван: ${failure instanceof Error ? failure.message : String(failure)}`
		);

		throw failure;
	} finally {
		await pass.restore(browser, pass.stand, storage);
		await browser.close();
		await rm(work, { recursive: true, force: true });
	}
}
