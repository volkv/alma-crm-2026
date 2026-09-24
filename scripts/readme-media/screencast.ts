/**
 * Скринкаст показа: связный проход по стенду от заявки с сайта до отчёта,
 * с титульной и финальной карточками, таймкодами и субтитрами.
 *
 * Ролики README показывают по разделу каждый; показу нужно другое — один
 * проход, где заявка с сайта становится взаимодействием, взаимодействие идёт по
 * процессу, процесс меняют на ходу, работу передают другому человеку, чужая
 * система подтверждает стадию, а в конце всё это объясняет отчёт. Собрать такой
 * проход руками нельзя: он идёт тремя ролями, трогает внешние системы и длится
 * без малого три минуты, за которые человек успевает промахнуться мимо кнопки.
 * Скрипт переснимает его целиком одной командой — и вместе с ним переснимает
 * таймкоды и субтитры, по которым ролик озвучивают.
 *
 * Запись идёт **против стенда** и честно: заявку подаёт имитатор сайта своим
 * триггером (кнопка «Демо: заявка с сайта» жмёт его же), группу в систему
 * обучения заводит человек кнопкой с карточки, результат потока присылает
 * имитатор системы обучения со своей страницы. Ничего не подделывается — иначе
 * ролик показывал бы систему, которой нет. Управляющие адреса имитаторов
 * (`__state`, `__scenario`) при этом не нужны вовсе: с них снимают состояние
 * стенда целиком, и на стенде они закрыты токеном.
 *
 * Что проход оставляет на стенде и что возвращает обратно —
 * `docs/readme-media.md`, раздел «Скринкаст». Голоса в ролике нет: текст
 * закадра лежит здесь же, рядом со сценами, потому что он задаёт их длину —
 * сцена не может кончиться раньше, чем дочитана её реплика.
 *
 * ```
 * export MEDIA_BASE_URL=https://crm.volkv.com
 * export SEED_DEMO_PASSWORD=…          # пароль демонстрационных записей каталога
 * export SCREENCAST_DIR=…              # каталог вне репозитория, куда лечь ролику
 * node scripts/readme-media/screencast.ts
 * node scripts/readme-media/screencast.ts --list
 * ```
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

import { DEMO_MANAGER_NAME, colleagueInCard, draftMention, sendComment } from './shots.ts';

const run = promisify(execFile);

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
const FRAME = { width: 1280, height: 800 } as const;

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
const WAIT = 30_000;

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

function requiredEnv(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback;

	if (value === undefined || value === '') {
		throw new Error(`Не задано ${name}: см. docs/readme-media.md`);
	}

	return value;
}

const BASE_URL = requiredEnv('MEDIA_BASE_URL', 'http://localhost:3000').replace(/\/+$/, '');
const PASSWORD = requiredEnv('SEED_DEMO_PASSWORD');

/**
 * Куда складывается готовый ролик.
 *
 * Вне репозитория: видео на три минуты весит десятки мегабайт, переснимается
 * каждый раз заново и не является ни кодом, ни документацией. По умолчанию —
 * временный каталог машины, на которой снимают.
 */
const OUTPUT = process.env.SCREENCAST_DIR ?? path.join(tmpdir(), 'lct-screencast');

/**
 * Черновой каталог прохода: части записи, вложение перехода, скачанные файлы.
 *
 * Всё это нужно только во время съёмки и стирается в конце: в каталоге ролика
 * остаются ролик, кадры, таймкоды и субтитры — то, ради чего проход затевался.
 */
const WORK = await mkdtemp(path.join(tmpdir(), 'lct-screencast-'));

/** Стадия, которую переименовывает администратор, и как она называется в черновике. */
const RENAMED_STAGE = {
	key: 'communication',
	from: 'Коммуникация и сверка программ',
	to: 'Коммуникация и сверка образовательных программ'
} as const;

/** Первая стадия процесса учебных заведений: на ней стоит заявка с сайта. */
const FIRST_STAGE = 'Поиск контактных лиц';

/** Обязательные пункты первой стадии: их закрывает менеджер в кадре. */
const FIRST_STAGE_CHECKLIST = [
	'Найдено профильное подразделение',
	'Подтверждён контакт ответственного лица'
] as const;

/**
 * Записи стенда, на которых держатся сцены.
 *
 * Названы поиском, а не идентификатором: идентификаторы у сида свои на каждой
 * установке, а названия — часть демонстрационных данных и видны в кадре.
 */
const STAND = {
	/** Подписанное соглашение: его стадию подтверждает отметка по документу. */
	signed: {
		query: 'соглашение о сотрудничестве',
		title: 'МТУСИ: соглашение о сотрудничестве',
		stage: 'Подписание соглашения',
		/** Место стадии в воронке: клик по столбцу начинается с него. */
		funnelIndex: 5
	},
	/** Занятия идут: стадия требует данных обучения, и их присылает система обучения. */
	classes: {
		query: 'ведение занятий',
		stage: 'Ведение занятий'
	},
	/** Стадия отчёта, по столбцу которой идёт клик в сцене отчёта. */
	narrowed: { stage: 'Корректировка документов', funnelIndex: 4 },
	/** Вуз, которого руководитель передаёт другому менеджеру. */
	institution: { query: 'МТУСИ', name: 'МТУСИ' }
} as const;

/**
 * Кто ведёт вуз до записи и кому его отдают в кадре.
 *
 * Назначение на вуз — это и область доступа: вместе с вузом уезжают незакрытые
 * взаимодействия по нему и право их видеть. Поэтому сцена передачи снимается
 * именно на вузе, а не на владельце одной записи: смена владельца работу
 * передаёт, но из области прежнего ответственного запись не убирает.
 */
const RESPONSIBLE = { from: DEMO_MANAGER_NAME, to: 'Вересова Анна Сергеевна' } as const;

/** Что руководитель пишет менеджеру в карточку заявки, пока тот работает. */
const LEAD_NOTE = 'Заявку вижу: сверку программ ведём к пятнице.';

/** Кем открыт экран; вход идёт демонстрационной записью каталога. */
type Role = 'manager' | 'lead' | 'admin';

/** Открытая сессия роли: куки каталога и приложения, снятые заранее. */
type Session = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Что проход завёл на стенде: сцены передают это друг другу. */
type Stand = {
	/** Ключ заявки в CMS: его называет сам имитатор, нажатый кнопкой стенда. */
	externalId: string;
	interactionId: string;
	/** Как система назвала взаимодействие: по названию его находят в списке. */
	title: string;
	/** Что из изменённого на стенде предстоит вернуть обратно. */
	moved: boolean;
	institutionMoved: boolean;
	renamed: boolean;
};

type Scene = {
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
	play: (page: Page, stand: Stand, crew: Crew) => Promise<void>;
};

/**
 * Коллеги в сцене: вторая роль, которая работает с тем же делом в то же
 * время, но в кадр не попадает.
 *
 * Живую карточку одной сессией не показать: «сейчас в карточке» и комментарий,
 * пришедший без перезагрузки, — это след чужой работы. Коллега входит своей
 * снятой заранее сессией, в своём браузере без записи, и уходит вместе с
 * концом сцены.
 */
type Crew = {
	/** Открыть адрес стенда от имени роли и дождаться, что страница ожила. */
	join: (role: Role, address: string) => Promise<Page>;
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

/** Сколько секунд читается реплика сцены вслух. */
function readingSeconds(narration: readonly string[]): number {
	const total = narration.reduce((sum, line) => sum + words(line), 0);

	return (total / WORDS_PER_MINUTE) * 60 + TAIL_SECONDS;
}

/** Пауза в долях такта: 1 — «дать прочитать», 0.5 — «не частить». */
async function beat(page: Page, times = 1): Promise<void> {
	await page.waitForTimeout(Math.round(BEAT * times));
}

/** Подвести курсор к элементу — видимым движением, а не прыжком. */
async function pointAt(page: Page, target: Locator): Promise<void> {
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
async function press(page: Page, target: Locator): Promise<void> {
	await target.waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, target);
	await target.click();
}

/** Открыть раздел и дождаться, пока он оживёт и покажет то, ради чего открыт. */
async function visit(
	page: Page,
	address: string,
	expected: string,
	options: { standalone?: boolean } = {}
): Promise<void> {
	await page.goto(`${BASE_URL}${address}`, { waitUntil: 'load' });

	if (options.standalone !== true) {
		await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });
	}

	await page.getByText(expected).first().waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 0.8);
}

/** Прокрутка «как рукой»: несколько коротких движений вместо одного прыжка. */
async function scroll(page: Page, distance: number, steps = 5): Promise<void> {
	for (let step = 0; step < steps; step += 1) {
		await page.mouse.wheel(0, distance / steps);
		await page.waitForTimeout(80);
	}

	await beat(page, 0.4);
}

/**
 * Вход через каталог учётных записей: кнопка на нашей странице, форма Keycloak,
 * возврат в приложение. Другого входа в системе нет, и подделанная сессия
 * снимала бы систему, которой не существует.
 *
 * Браузер входа каждый раз чистый, поэтому сразу после возврата в приложение
 * открывается приветствие подсказок — и закрывается кнопкой «Позже», тем же
 * нажатием, что и у человека, до начала сцены. Признак «показаны» не подкладывается в хранилище:
 * скрытого выключателя в продукте нет (`e2e/helpers/onboarding.ts`,
 * `scripts/readme-media/capture.ts`). Для сессий, снятых заранее
 * (`storageFor`), это гашение не входит в запись вовсе; в единственном живом
 * входе в кадре (`handover`) оно добавляет к сцене меньше секунды.
 */
async function signIn(page: Page, login: Role, typed: boolean): Promise<void> {
	await page.goto(`${BASE_URL}/login`);

	if (typed) {
		await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });
		await beat(page, 1.2);
	}

	await press(page, page.getByRole('button', { name: 'Войти', exact: true }));
	await page.waitForURL(/\/realms\/lct\/protocol\/openid-connect\/auth/, { timeout: WAIT });

	if (typed) {
		await beat(page, 0.5);
		await page.locator('#username').click();
		await page.locator('#username').pressSequentially(login, { delay: 110 });
	} else {
		await page.locator('#username').fill(login);
	}

	// Пароль вводится сразу целиком и в записи остаётся точками: показывать, как
	// его набирают, ролику нечего.
	await page.locator('#password').fill(PASSWORD);
	await page.locator('#kc-login').click();
	await page.waitForURL(`${BASE_URL}/`, { timeout: WAIT });

	await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });

	const tour = page.getByTestId('onboarding-tour');

	await tour.waitFor({ state: 'visible', timeout: WAIT });
	await tour.getByRole('button', { name: 'Позже' }).click();
	await tour.waitFor({ state: 'hidden', timeout: WAIT });
}

/**
 * Сессия роли, снятая заранее.
 *
 * Вход в кадре нужен ровно один раз — там, где в ролике меняется роль.
 * Остальные сцены начинаются с уже открытой сессии: пять записей чужой формы
 * ввода пароля подряд не рассказывают о продукте ничего.
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
function session(storage: Map<Role, Session>, role: Role): Session {
	const state = storage.get(role);

	if (state === undefined) {
		throw new Error(`Сессия роли «${role}» не открыта`);
	}

	return state;
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

const TITLE_CARD = `
	<div class="rule"></div>
	<p class="kicker">ИТ Школа Ростелекома · «Лидеры цифровой трансформации 2026»</p>
	<h1>Система контроля взаимодействия с учебными заведениями</h1>
	<p class="lead">От заявки с сайта до подтверждённого результата — весь процесс под контролем</p>
	<p class="foot">Wine Coding Team</p>
`;

const FINAL_CARD = `
	<div class="rule"></div>
	<h1>Стенд открыт</h1>
	<ul>
		<li><b class="accent">crm.volkv.com</b> — три роли: менеджер, руководитель, администратор</li>
		<li><b class="accent">/help</b> — руководства внутри системы, <b class="accent">/api/docs</b> — описание программного интерфейса</li>
		<li><b class="accent">github.com/volkv/lct-2026</b> — исходный код</li>
	</ul>
	<p class="foot">Wine Coding Team</p>
`;

async function showCard(page: Page, styles: readonly string[], body: string): Promise<void> {
	await page.route(`${BASE_URL}${CARD_PATH}`, (route) =>
		route.fulfill({ contentType: 'text/html; charset=utf-8', body: card(styles, body) })
	);
	await page.goto(`${BASE_URL}${CARD_PATH}`, { waitUntil: 'load' });
	// Шрифт приложения приезжает с того же стенда: без ожидания первый кадр
	// карточки успевает показать запасную гарнитуру.
	await page.evaluate(() => document.fonts.ready);
}

/**
 * Вложение к переходу: страница «скана» протокола.
 *
 * Рисует её `ffmpeg`, которым и так собирается видео: заводить ради одного
 * файла зависимость незачем, а прикладывать к переходу пустой файл — значит
 * показывать работу, которой не было.
 */
async function drawAttachment(): Promise<string> {
	const file = path.join(WORK, 'protokol-vstrechi.png');
	const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
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
			line('Протокол встречи', 180, 64),
			line('МТУСИ · подготовка DevOps-инженеров', 290, 38),
			line('Демонстрационный файл записи показа', 370, 34)
		].join(','),
		file
	]);

	return file;
}

/**
 * Открыть «Сделано на стадии», если оно есть и ещё закрыто.
 *
 * Отмеченный пункт чек-листа уезжает туда из списка того, что осталось
 * сделать (`$lib/components/interaction-card/primary-action.svelte`), и без
 * этого шага снять его же отметку было бы нечем — блок свёрнут `<details>`, и
 * до раскрытия его пункты не видны браузеру. Раскрытие идёт один раз: клик по
 * уже открытому блоку его закрыл бы.
 */
async function openDoneItems(page: Page): Promise<void> {
	const details = page.locator('[data-slot="card-action-done"]');

	if ((await details.count()) === 0) {
		return;
	}

	const isOpen = await details.evaluate((element) => (element as HTMLDetailsElement).open);

	if (!isOpen) {
		await details.locator('summary').click();
	}
}

/**
 * Привести пункт чек-листа к нужному состоянию.
 *
 * Именно привести, а не «нажать»: чек-лист принадлежит стадии и переживает
 * возврат на неё, поэтому слепое нажатие в возврате стенда закрывало бы пункт,
 * который на стенде открыт. По той же причине сцена не требует, чтобы пункты
 * были открыты с самого начала: следы проверки на общем стенде — обычное дело,
 * а проверяется результат — «ничего не мешает».
 */
async function setChecklistItem(
	page: Page,
	item: string,
	done: boolean,
	options: { shown?: boolean } = {}
): Promise<void> {
	await openDoneItems(page);

	const toggle = page.getByRole('checkbox', { name: item });

	await toggle.waitFor({ state: 'visible', timeout: WAIT });

	if ((await toggle.isChecked()) === done) {
		return;
	}

	if (options.shown === true) {
		await press(page, toggle);
	} else {
		await toggle.click();
		await page.waitForTimeout(400);
	}
}

/**
 * Ключ потока, заведённого только что.
 *
 * Потоков у взаимодействия бывает несколько, и какой из них завела кнопка,
 * видно только сравнением с тем, что было на карточке до нажатия: имя группе
 * даёт система обучения, а не мы.
 */
async function newGroup(page: Page, before: ReadonlySet<string>): Promise<string> {
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const added = [...(await groupKeys(page))].filter((key) => !before.has(key));

		if (added.length > 0) {
			return added[0];
		}

		await page.waitForTimeout(700);
	}

	throw new Error('Система обучения не завела группу: показывать в сцене нечего');
}

/** Открыть карточку вуза поиском по названию и убедиться, что открылась она. */
async function openOrganization(page: Page, query: string, expected: string): Promise<void> {
	await visit(page, `/organizations?q=${encodeURIComponent(query)}`, 'Организации');

	await press(page, page.getByRole('row').nth(1));
	await page.waitForURL(/\/organizations\/[0-9a-f-]{36}/u, { timeout: WAIT });
	await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });

	const heading = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();

	if (!heading.includes(expected)) {
		throw new Error(`По запросу «${query}» открылась не та организация: «${heading}»`);
	}
}

/** Назначить ответственного за вуз целиком, передав ему незакрытые записи. */
async function assignInstitution(page: Page, fullName: string): Promise<void> {
	await openOrganization(page, STAND.institution.query, STAND.institution.name);

	await page.getByLabel('Сотрудник').click();
	await page.getByRole('option', { name: new RegExp(fullName, 'u') }).click();
	await page.getByRole('button', { name: 'Назначить', exact: true }).click();
	await page
		.getByText('Ответственный назначен, доступ изменён')
		.first()
		.waitFor({ state: 'visible', timeout: WAIT });
}

/** Открыть запись стенда поиском по названию и убедиться, что открылась она. */
async function openInteraction(page: Page, query: string, expected: string): Promise<void> {
	await visit(page, `/interactions?q=${encodeURIComponent(query)}`, 'Взаимодействия');

	const row = page.getByRole('row').nth(1);

	await press(page, row);
	await page.waitForURL(/\/interactions\/[0-9a-f-]{36}/u, { timeout: WAIT });
	await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });

	const heading = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();

	if (!heading.includes(expected)) {
		throw new Error(`По запросу «${query}» открылась не та запись: «${heading}»`);
	}
}

/**
 * Клик по столбцу воронки.
 *
 * Диаграмма — холст, и попасть в столбец можно только по точке: столбца в
 * разметке нет. Проба идёт с ожидаемого места стадии в воронке, а дальше — по
 * остальным строкам, потому что порядок и число стадий задаёт действующий
 * процесс, а он настраивается. Успех проверяется не адресом, а тем, что в
 * таблице отчёта осталась ровно названная стадия.
 */
async function narrowByFunnel(page: Page, stage: string, likely: number): Promise<void> {
	const canvas = page.getByTestId('report-chart-canvas').first();

	await canvas.scrollIntoViewIfNeeded();

	const box = await canvas.boundingBox();

	if (box === null) {
		throw new Error('Диаграммы отчёта нет на экране');
	}

	const rows = 14;
	const order = [likely, ...Array.from({ length: rows }, (_, index) => index)];

	for (const index of order) {
		const x = box.x + box.width * 0.35;
		const y = box.y + (box.height / rows) * (index + 0.5);

		await page.mouse.move(x, y, { steps: 18 });
		await page.waitForTimeout(140);
		await page.mouse.click(x, y);
		await page.waitForTimeout(900);

		if (!page.url().includes('stage=')) {
			continue;
		}

		if ((await page.locator('table').getByText(stage).count()) > 0) {
			return;
		}

		// Попали в соседний столбец: сужение снимается тем же путём, которым
		// поставлено, — иначе следующая проба считала бы уже отфильтрованное.
		await page.goBack({ waitUntil: 'load' });
		await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });
		await canvas.scrollIntoViewIfNeeded();
	}

	throw new Error(`Клик по воронке не сузил отчёт до стадии «${stage}»`);
}

/** Переименовать стадию черновика: диалог стадии, поле названия, сохранение. */
async function renameStage(page: Page, key: string, name: string): Promise<void> {
	const row = page.getByRole('row').filter({ hasText: key });

	await press(page, row.getByRole('button', { name: 'Изменить' }));

	const dialog = page.getByRole('dialog');

	await dialog.waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 0.6);

	const field = dialog.locator('input[name="name"]');

	await pointAt(page, field);
	await field.fill('');
	await field.pressSequentially(name, { delay: 24 });
	await beat(page, 0.6);

	await press(page, dialog.getByRole('button', { name: 'Сохранить стадию' }));
	await dialog.waitFor({ state: 'hidden', timeout: WAIT });
	await page
		.getByRole('cell', { name, exact: true })
		.first()
		.waitFor({ state: 'visible', timeout: WAIT });
}

/** Ключи учебных групп, названные на карточке: по ним видно, какая заведена сейчас. */
async function groupKeys(page: Page): Promise<Set<string>> {
	const text = await page.locator('main').innerText();

	return new Set([...text.matchAll(/Поток\s+\d+\s+·\s+группа\s+(\S+)/gu)].map((found) => found[1]));
}

/**
 * Перевести взаимодействие на соседнюю стадию через меню «Ещё»: диалог
 * перехода требует причины.
 *
 * Кнопка карточки одна, и это всегда «Перейти к «…»» — шаг вперёд; «Вернуть
 * на «…»» и «Пропустить до «…»» команд там нет, они только в меню «Ещё»
 * (`$lib/components/interaction-card/model.ts`, `primaryCommand`).
 */
async function transition(page: Page, label: string, reason: string): Promise<void> {
	await page.getByRole('button', { name: 'Ещё', exact: true }).click();
	await page.getByRole('menuitem', { name: label }).click();

	const dialog = page.getByRole('dialog');

	await dialog.waitFor({ state: 'visible', timeout: WAIT });
	await dialog.locator('[name="reason"]').fill(reason);
	await dialog.getByRole('button', { name: 'Подтвердить' }).click();
	await dialog.waitFor({ state: 'hidden', timeout: WAIT });
}

const SCENES: readonly Scene[] = [
	{
		name: 'title',
		role: 'manager',
		caption: 'Титульная карточка',
		narration: [
			'Система контроля взаимодействия с учебными заведениями.',
			'Решение команды Wine Coding Team.'
		],
		play: async (page) => {
			await showCard(page, await appStyles(page.context()), TITLE_CARD);
			await beat(page, 3);
		}
	},
	{
		name: 'hook',
		role: 'manager',
		caption: 'Крючок: число в отчёте раскрывается до подтверждения',
		narration: [
			'Любое число в отчёте раскрывается до факта.',
			'Клик по столбцу — список, из которого оно собрано, карточка — и подтверждение: отметка по подписанному документу.',
			'Это обещание проверяется на каждом экране.'
		],
		play: async (page) => {
			await visit(page, '/reports', 'Отчёты по взаимодействиям');
			await scroll(page, 560);
			await narrowByFunnel(page, STAND.signed.stage, STAND.signed.funnelIndex);
			await beat(page, 0.8);

			// Дальше идём строкой самого отчёта, а не ссылкой «открыть в списке»:
			// список стадию отчёта не понимает и показал бы выборку шире той, из
			// которой собрано число (`src/lib/components/reports/query.ts`).
			await press(page, page.getByRole('link', { name: STAND.signed.title }).first());
			await page.waitForURL(/\/interactions\/[0-9a-f-]{36}/u, { timeout: WAIT });
			await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });

			// Подтверждение стоит в «Сделано на стадии»: пункт закрыт, поэтому
			// свёрнут — раскрываем тем же движением, что и человек. Стадия
			// «Подписание соглашения» требует отметки по документу
			// (`requiresDocumentMark`, не общего `confirmation`), поэтому пункт
			// подписан «Документ с отметкой «Утверждён»»
			// (`src/lib/components/interaction-card/model.ts`), а не «Подтверждено…».
			await press(page, page.locator('[data-slot="card-action-done"] summary'));
			await pointAt(page, page.getByText('Документ с отметкой').first());
			await beat(page, 1.4);
		}
	},
	{
		name: 'intake',
		role: 'admin',
		caption: 'Заявка с сайта: триггер имитатора, взаимодействие, статус обратно на сайт',
		narration: [
			'Заявка приходит с сайта по объявленному контракту обмена.',
			'Кнопка стенда жмёт тот же триггер имитатора, что и посетитель, заполнивший форму.',
			'Журнал показывает обе стороны: что пришло, что ушло и чем ответил получатель.',
			'Заявка стала взаимодействием — с учебным заведением, контактным лицом и ответственным.',
			'Обратно на сайт уходит снимок статуса: заявитель видит, что с обращением происходит.'
		],
		play: async (page, stand) => {
			await visit(page, '/exchange', 'Внешние системы');

			await press(page, page.getByRole('button', { name: 'Демо: заявка с сайта' }));

			const sent = page.getByText(/Имитатор CMS подал заявку/u).first();

			await sent.waitFor({ state: 'visible', timeout: WAIT });

			const key = /заявку\s+(\S+?):/u.exec(await sent.innerText());

			if (key === null) {
				throw new Error('Имитатор не назвал ключ поданной заявки');
			}

			stand.externalId = key[1];
			await beat(page, 1.2);

			await visit(page, `/exchange?q=${stand.externalId}`, 'Внешние системы');

			// Снимок статуса уходит фоновым проходом очереди, а не в той же
			// транзакции: журнал перечитывается, пока он не уедет.
			for (let attempt = 0; attempt < 4; attempt += 1) {
				if ((await page.locator('table').getByText('Отправлено').count()) > 0) {
					break;
				}

				await beat(page, 1.2);
				await page.reload({ waitUntil: 'load' });
				await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });
			}

			await beat(page, 1);

			// Таблица журнала шире окна: правые колонки — попытки и ответ
			// получателя — показываются прокруткой вбок.
			await page.mouse.move(FRAME.width / 2, 330);
			await page.mouse.wheel(500, 0);
			await beat(page, 1.2);

			await press(page, page.getByRole('link', { name: /Заявка с сайта/u }).first());
			await page.waitForURL(/\/interactions\/[0-9a-f-]{36}/u, { timeout: WAIT });
			await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });
			await page
				.getByText('Все стадии процесса')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });

			stand.interactionId = /\/interactions\/([0-9a-f-]{36})/u.exec(page.url())?.[1] ?? '';
			stand.title = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
			await beat(page, 1.6);

			// Вторая сторона обмена: карточка заявки на сайте со снимком статуса,
			// который прислала CRM.
			await visit(page, '/mock-cms/', 'Имитатор CMS сайта', { standalone: true });
			await scroll(page, 420);
			await beat(page, 1.2);
		}
	},
	{
		name: 'work',
		role: 'manager',
		caption:
			'Работа КАМа: кто в деле, закрытый шаг с объяснением, переход с файлом, живой комментарий',
		narration: [
			'Карточка одной колонкой: факты и стадии сверху, над ними — кто сейчас в деле.',
			'Шаг вперёд закрыт, и причина названа словами: два обязательных пункта стадии не закрыты.',
			'Менеджер закрывает их — и переход становится доступен.',
			'Переход просит объяснить, чем закончилась стадия: комментарий и файл остаются в истории, на той стадии, где их приложили.',
			'Руководитель в той же карточке: его комментарий с упоминанием приходит без перезагрузки.'
		],
		play: async (page, stand, crew) => {
			const address = `/interactions/${stand.interactionId}`;
			// Руководитель открывает дело вместе с менеджером, а не до сцены: его
			// аватарка появляется в кадре так же, как её увидел бы человек.
			const [lead] = await Promise.all([
				crew.join('lead', address),
				visit(page, address, 'Все стадии процесса')
			]);

			await colleagueInCard(page);
			await pointAt(page, page.locator('[data-slot="card-presence"]'));

			const stage = await page.getByText(FIRST_STAGE).first().isVisible();

			if (!stage) {
				throw new Error(`Заявка стоит не на стадии «${FIRST_STAGE}»: сцена работы не про неё`);
			}

			await beat(page, 0.8);

			// Недоступный шаг показывается до чек-листа: сначала видно, что кнопка
			// закрыта и почему, и только потом — как это снимают. Чек-лист уже на
			// экране — своей ссылки на него больше нет, пункты стоят прямо под
			// кнопкой (`$lib/components/interaction-card/primary-action.svelte`).
			await pointAt(page, page.getByRole('button', { name: `Перейти к «${RENAMED_STAGE.from}»` }));
			await beat(page, 1.2);

			// Комментарий руководитель набирает, пока менеджер закрывает пункты: в
			// кадре незачем ждать, как печатают в соседнем окне. Отправляет — после
			// перехода, когда менеджер уже смотрит на ленту.
			await Promise.all([
				draftMention(lead, DEMO_MANAGER_NAME, LEAD_NOTE),
				(async () => {
					for (const item of FIRST_STAGE_CHECKLIST) {
						await setChecklistItem(page, item, true, { shown: true });
						await beat(page, 0.6);
					}
				})()
			]);

			await page
				.getByText('Условия стадии выполнены')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1.2);

			await press(page, page.getByRole('button', { name: `Перейти к «${RENAMED_STAGE.from}»` }));

			const dialog = page.getByRole('dialog');

			await dialog.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 0.6);

			await dialog.locator('[name="reason"]').click();
			await dialog
				.locator('[name="reason"]')
				.pressSequentially(
					'Профильное подразделение найдено, контакт подтверждён — идём к сверке программ.',
					{ delay: 20 }
				);
			await beat(page, 0.5);

			await dialog.locator('#card-transition-files').setInputFiles(await drawAttachment());
			await beat(page, 0.6);

			await press(page, dialog.getByRole('button', { name: 'Подтвердить' }));

			// Признак того, что переход состоялся, — чек-лист новой стадии: её
			// название есть на карточке и до перехода, в цепочке стадий.
			await page
				.getByText('Отправлено описание программ')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });

			stand.moved = true;

			await beat(page, 0.8);

			const feed = page.locator('[data-slot="event-feed"]');

			await pointAt(page, feed.getByRole('heading', { name: 'События' }));
			await sendComment(lead, LEAD_NOTE);

			const note = feed.getByText(LEAD_NOTE).first();

			await note.waitFor({ state: 'visible', timeout: WAIT });
			await pointAt(page, note);
			await beat(page, 1.2);
		}
	},
	{
		name: 'process',
		role: 'admin',
		caption: 'Правка живого процесса: черновик, предпросмотр затронутых, применение ко всем',
		narration: [
			'Устройство процесса — настройка, а не код.',
			'Администратор берёт черновик действующего процесса и переименовывает стадию.',
			'До применения видно, кого изменение затронет: сколько записей переедет на другую стадию.',
			'Применили ко всем — и работа продолжается там же, где стояла, уже под новым названием.'
		],
		play: async (page, stand) => {
			await visit(page, '/settings/workflows/b2b', 'Процесс');

			await press(page, page.getByRole('button', { name: 'Черновик изменений' }));
			await page
				.getByText('Черновик изменений — копия действующего процесса.')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1);

			await renameStage(page, RENAMED_STAGE.key, RENAMED_STAGE.to);

			// Таблица стадий шире окна и после правки стоит прокрученной вбок;
			// новое название целиком видно в цепочке стадий наверху страницы.
			await scroll(page, -1200);
			await page.getByText(RENAMED_STAGE.to).first().waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1.2);

			await press(page, page.getByRole('button', { name: 'Применить ко всем' }).first());

			const dialog = page.getByRole('dialog');

			await dialog.waitFor({ state: 'visible', timeout: WAIT });
			await dialog
				.getByText('Переедут на другую стадию')
				.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1.8);

			await press(page, dialog.getByRole('button', { name: 'Применить ко всем' }));
			await page
				.getByText('Действующий процесс открыт только на чтение')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });

			stand.renamed = true;
			await beat(page, 1);

			await visit(page, `/interactions/${stand.interactionId}`, 'Все стадии процесса');
			await pointAt(page, page.getByText(RENAMED_STAGE.to).first());
			await beat(page, 1.4);
		}
	},
	{
		name: 'handover',
		role: 'lead',
		caption: 'Роли и передача: руководитель отдаёт вуз другому менеджеру',
		signsIn: true,
		narration: [
			'Вход идёт через общий каталог учётных записей, и права приезжают вместе с ним.',
			'Руководитель ведёт свою область и видит работу подчинённых.',
			'Он отдаёт вуз другому менеджеру — вместе с вузом переезжают незакрытые взаимодействия и право их видеть.'
		],
		play: async (page, stand) => {
			await signIn(page, 'lead', true);
			await beat(page, 0.8);

			await openOrganization(page, STAND.institution.query, STAND.institution.name);

			// Кто ведёт вуз сейчас — видно до правки: назначение меняет область
			// доступа, и подменить в кадре чужую строку на свою нельзя.
			await pointAt(page, page.getByRole('cell', { name: RESPONSIBLE.from, exact: true }));
			await beat(page, 1);

			await press(page, page.getByLabel('Сотрудник'));
			await press(page, page.getByRole('option', { name: new RegExp(RESPONSIBLE.to, 'u') }));
			await beat(page, 0.5);

			await pointAt(
				page,
				page.getByText('Передать незавершённые взаимодействия новому ответственному')
			);
			await beat(page, 0.8);

			await press(page, page.getByRole('button', { name: 'Назначить', exact: true }));
			await page
				.getByText('Ответственный назначен, доступ изменён')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });

			stand.institutionMoved = true;

			await pointAt(page, page.getByRole('cell', { name: RESPONSIBLE.to, exact: true }));
			await beat(page, 1.4);
		}
	},
	{
		name: 'handover-gone',
		role: 'manager',
		caption: 'Роли и передача: у прежнего ответственного записей по вузу больше нет',
		narration: [
			'У прежнего ответственного записей по этому вузу больше нет: область доступа — это данные, а не спрятанная кнопка.'
		],
		play: async (page) => {
			await visit(page, `/interactions?q=${STAND.institution.query}`, 'Взаимодействия');
			await page
				.getByText('Ничего не найдено')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1.6);
		}
	},
	{
		name: 'lms',
		role: 'lead',
		caption: 'Система обучения подтверждает стадию «Ведение занятий»',
		narration: [
			'Стадия «Ведение занятий» — единственная, чьё исполнение доказывает чужая система.',
			'Учебную группу заводит человек кнопкой с карточки, а не автоматика: ошибочный шаг не должен превращаться в группу в чужой системе.',
			'Система обучения возвращает числа сама — зачислено, завершили, отчислены — и этой записью стадия подтверждена.',
			'Двигать работу дальше по-прежнему решает сотрудник.'
		],
		play: async (page) => {
			await openInteraction(page, STAND.classes.query, 'ведение занятий');

			// Адрес карточки запоминается: со страницы имитатора возвращаются сюда,
			// а не «назад» — назад стоит отправленная форма имитатора.
			const card = page.url();

			await page
				.getByText(STAND.classes.stage)
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1);

			await scroll(page, 1100);

			const before = await groupKeys(page);

			// Заявка на поток — своим диалогом: кнопка на панели «Система обучения»
			// открывает форму, а не держит её на карточке постоянно.
			await press(page, page.getByRole('button', { name: 'Заявить поток' }));

			const sendDialog = page.getByRole('dialog');

			await sendDialog.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 0.6);

			await press(page, page.getByLabel('Для кого обучение'));
			await press(page, page.getByRole('option', { name: 'Обучение студентов' }));
			await beat(page, 0.4);

			// Даты — не нативный `<input type="date">`, а поле в формате «12.09.2026»
			// (`$lib/components/form/date-field.svelte`): значение отдаётся тем же
			// текстом, каким его набирает человек.
			await sendDialog.locator('#card-planned-seats').fill('30');
			await sendDialog.locator('#card-starts-on').fill('01.10.2026');
			await sendDialog.locator('#card-ends-on').fill('31.05.2027');
			await beat(page, 0.6);

			await press(page, sendDialog.getByRole('button', { name: 'Отправить в LMS' }));
			await sendDialog.waitFor({ state: 'hidden', timeout: WAIT });

			const group = await newGroup(page, before);

			await beat(page, 1.2);

			// Вторая сторона: числа потока присылает сама система обучения — со
			// своей страницы, тем же триггером, что и по расписанию.
			await visit(page, '/mock-lms/', 'Имитатор системы обучения', { standalone: true });
			await page.locator('input[name="groupExternalId"]').fill(group);
			await beat(page, 0.5);
			await press(page, page.getByRole('button', { name: 'Отправить результат в CRM' }));
			await beat(page, 1);

			await page.goto(card, { waitUntil: 'load' });
			await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });
			await scroll(page, 1100);
			await page
				.getByText('зачислено', { exact: true })
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1);

			// Подтверждение стадии — тем же путём, что и в сцене `hook`: пункт
			// «Сделано на стадии» свёрнут, пока его не раскрыли.
			await press(page, page.locator('[data-slot="card-action-done"] summary'));
			await pointAt(page, page.getByText('записью в системе обучения').first());
			await beat(page, 1.4);
		}
	},
	{
		name: 'reports',
		role: 'manager',
		caption: 'Отчёт: срез и движение, клик по столбцу, выгрузки',
		narration: [
			'Отчёт отвечает на два разных вопроса и не смешивает их: срез — где работа стоит на дату, движение — что случилось за период.',
			'Клик по столбцу сужает тот же отчёт.',
			'Выгрузка — та же ссылка с другим расширением: PDF сводкой или целиком, и числа совпадают с экраном.'
		],
		play: async (page) => {
			await visit(page, '/reports', 'Отчёты по взаимодействиям');
			await pointAt(page, page.getByTestId('report-row-count').first());
			await beat(page, 1);

			await scroll(page, 560);
			await narrowByFunnel(page, STAND.narrowed.stage, STAND.narrowed.funnelIndex);
			await scroll(page, -560);
			await pointAt(page, page.getByTestId('report-row-count').first());
			await beat(page, 1.2);

			await press(page, page.getByRole('link', { name: 'Движение', exact: true }));
			await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });
			await page
				.getByText('Каждая строка — один переход')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });
			await scroll(page, 420);
			await beat(page, 1.2);
			await scroll(page, -420);

			// PDF бывает сводкой или целиком: переключатель стоит вплотную к кнопке и
			// меняет только её ссылку. «Целиком» выключен, когда в выборке больше
			// строк, чем берёт полный PDF, — тогда сцена молча остаётся на «Сводке»,
			// а не спотыкается о недоступную кнопку.
			const fullLayout = page.getByTestId('report-pdf-layout-full');

			if (await fullLayout.isEnabled()) {
				await press(page, fullLayout);
				await beat(page, 0.6);
			}

			const saved = new Map<string, string>();

			// Имя формата — то же, что в `data-testid="report-export-{format}"`
			// (`src/routes/(app)/reports/+page.svelte`): подпись кнопки у PDF теперь
			// несёт вид («PDF · целиком»), и по видимому тексту её не найти.
			for (const format of ['xlsx', 'pdf'] as const) {
				const download = page.waitForEvent('download', { timeout: WAIT });

				await press(page, page.getByTestId(`report-export-${format}`));

				const file = await download;
				// Имя даём своё: у выгрузки его назначает заголовок ответа, и
				// показывать в ролике надо не имя файла, а сам файл.
				const target = path.join(WORK, `report.${format}`);

				await file.saveAs(target);
				saved.set(format, target);
				console.log(`выгрузка ${format.toUpperCase()}: ${target}`);
				await beat(page, 0.6);
			}

			const pdf = saved.get('pdf');

			if (pdf === undefined) {
				throw new Error('Отчёт не отдал PDF: показывать нечего');
			}

			// Скачанный файл открывается тут же: иначе выгрузка в кадре выглядит
			// нажатием, после которого ничего не происходит.
			await page.goto(`file://${pdf}`, { waitUntil: 'load' });
			await beat(page, 2.4);
		}
	},
	{
		name: 'final',
		role: 'manager',
		caption: 'Финальная карточка',
		narration: [
			'Стенд открыт: три роли, руководства внутри и описание программного интерфейса.',
			'Код — в репозитории команды.'
		],
		play: async (page) => {
			await showCard(page, await appStyles(page.context()), FINAL_CARD);
			await beat(page, 3);
		}
	}
];

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

function timecode(seconds: number): string {
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

/**
 * Субтитры из того же текста, которым мерили сцену.
 *
 * Внутри сцены фразы делят её время по числу слов: у записи нет ни голоса, ни
 * его разметки, и другого основания дать длинной фразе больше времени, чем
 * короткой, тоже нет. Файл — подсказка диктору и запасной вариант показа без
 * звука, а не расшифровка озвучки: после записи голоса метки уточняют по нему.
 */
function subtitles(parts: readonly { scene: Scene; start: number; seconds: number }[]): string {
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
async function record(
	browser: Browser,
	scene: Scene,
	stand: Stand,
	storage: Map<Role, Session>,
	directory: string
): Promise<string> {
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
			await other.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });

			return other;
		}
	};

	const startedAt = Date.now();
	let acted: number;

	try {
		await page.mouse.move(FRAME.width / 2, FRAME.height / 2);
		await scene.play(page, stand, crew);

		acted = (Date.now() - startedAt) / 1000;

		const left = readingSeconds(scene.narration) * 1000 - (Date.now() - startedAt);

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
		`${scene.name}: действие ${acted.toFixed(1)} с, реплика ${readingSeconds(scene.narration).toFixed(1)} с`
	);

	// Файл дописывается при закрытии контекста, а не страницы.
	await context.close();

	const target = path.join(directory, `${scene.name}.mp4`);

	await toMp4(await video.path(), target);

	return target;
}

/**
 * Убрать за собой.
 *
 * Стенд общий и его смотрят: стадия заявки, ответственный и название стадии
 * возвращаются тем же путём, которым менялись, — интерфейсом и от имени роли,
 * которой это по силам. Возвращается только то, что этот проход действительно
 * изменил: лишняя публикация процесса оставила бы в журнале запись об
 * изменении, которого не было. Порядок обязателен: пока запись числится за
 * другим менеджером, прежний ответственный её не видит и вернуть стадию не
 * может.
 */
async function restore(browser: Browser, stand: Stand, storage: Map<Role, Session>): Promise<void> {
	const withRole = async (role: Role, work: (page: Page) => Promise<void>): Promise<void> => {
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
	};

	if (stand.institutionMoved) {
		await withRole('lead', async (page) => {
			await assignInstitution(page, RESPONSIBLE.from);

			console.log(`вуз возвращён: ${RESPONSIBLE.from}`);
		});
	}

	if (stand.moved) {
		await withRole('manager', async (page) => {
			await page.goto(`${BASE_URL}/interactions/${stand.interactionId}`, { waitUntil: 'load' });
			await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });

			await transition(
				page,
				`Вернуть на «${FIRST_STAGE}»`,
				'Возврат стенда к исходному состоянию после записи показа.'
			);

			// Чек-лист возвращается следом: стадия, на которую вернулись, иначе
			// осталась бы закрытой, и следующий проход начался бы не с того, с чего
			// начинается стенд.
			for (const item of FIRST_STAGE_CHECKLIST) {
				await setChecklistItem(page, item, false);
			}

			console.log(`стадия возвращена: ${FIRST_STAGE}`);
		});
	}

	if (stand.renamed) {
		await withRole('admin', async (page) => {
			await page.goto(`${BASE_URL}/settings/workflows/b2b`, { waitUntil: 'load' });
			await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });
			await page.getByRole('button', { name: 'Черновик изменений' }).click();
			await page
				.getByText('Черновик изменений — копия действующего процесса.')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });

			await renameStage(page, RENAMED_STAGE.key, RENAMED_STAGE.from);

			await page.getByRole('button', { name: 'Применить ко всем' }).first().click();

			const dialog = page.getByRole('dialog');

			await dialog.waitFor({ state: 'visible', timeout: WAIT });
			await dialog.getByRole('button', { name: 'Применить ко всем' }).click();
			await page
				.getByText('Действующий процесс открыт только на чтение')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });

			console.log(`процесс возвращён: стадия «${RENAMED_STAGE.from}»`);
		});
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args.includes('--list')) {
		for (const scene of SCENES) {
			const seconds = readingSeconds(scene.narration).toFixed(1);

			console.log(
				`${scene.name.padEnd(14)} ${scene.role.padEnd(8)} ${seconds.padStart(5)} с — ${scene.caption}`
			);
		}

		const total = SCENES.reduce((sum, scene) => sum + readingSeconds(scene.narration), 0);
		const spoken = SCENES.reduce(
			(sum, scene) => sum + scene.narration.reduce((count, line) => count + words(line), 0),
			0
		);

		console.log(`\nзакадр: ${spoken} слов, не меньше ${timecode(total)} записи`);

		await rm(WORK, { recursive: true, force: true });

		return;
	}

	await mkdir(path.join(OUTPUT, 'frames'), { recursive: true });

	const stand: Stand = {
		externalId: '',
		interactionId: '',
		title: '',
		moved: false,
		institutionMoved: false,
		renamed: false
	};

	const browser = await chromium.launch({
		// Полная сборка вместо «headless shell»: только в ней есть файлы локалей,
		// без которых подписи браузера в кадре остаются английскими.
		channel: 'chromium',
		args: [`--lang=${LOCALE}`],
		env: { ...process.env, ...BROWSER_LANGUAGE } as Record<string, string>
	});
	const storage = new Map<Role, Session>();

	try {
		for (const role of ['manager', 'lead', 'admin'] as const) {
			storage.set(role, await storageFor(browser, role));
		}

		const parts: { scene: Scene; file: string; seconds: number }[] = [];

		for (const scene of SCENES) {
			const file = await record(browser, scene, stand, storage, WORK);
			const seconds = await durationOf(file);

			parts.push({ scene, file, seconds });
			console.log(`${scene.name}: ${seconds.toFixed(1)} с`);
		}

		const list = path.join(WORK, 'parts.txt');

		await writeFile(list, parts.map((part) => `file '${part.file}'`).join('\n'), 'utf8');

		const target = path.join(OUTPUT, 'screencast-draft.mp4');

		await run('ffmpeg', [
			'-y',
			'-loglevel',
			'error',
			'-f',
			'concat',
			'-safe',
			'0',
			'-i',
			list,
			'-c',
			'copy',
			target
		]);

		let offset = 0;
		const marks = parts.map((part) => {
			const start = offset;

			offset += part.seconds;

			return { ...part, start };
		});

		for (const mark of marks) {
			await grabFrame(
				target,
				Math.max(mark.start, mark.start + mark.seconds - 1.5),
				path.join(OUTPUT, 'frames', `${mark.scene.name}.png`)
			);
		}

		const timecodes = {
			file: target,
			recordedAt: new Date().toISOString(),
			baseUrl: BASE_URL,
			frame: FRAME,
			totalSeconds: Number(offset.toFixed(2)),
			total: timecode(offset),
			interactionId: stand.interactionId,
			externalId: stand.externalId,
			interactionTitle: stand.title,
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
			path.join(OUTPUT, 'timecodes.json'),
			`${JSON.stringify(timecodes, null, '\t')}\n`,
			'utf8'
		);
		await writeFile(path.join(OUTPUT, 'subtitles.srt'), subtitles(marks), 'utf8');

		console.log(`\n${target}`);
		console.log(`длительность: ${timecode(offset)}\n`);

		for (const mark of marks) {
			console.log(
				`${timecode(mark.start)}–${timecode(mark.start + mark.seconds)}  ${mark.scene.name.padEnd(14)} ${mark.scene.caption}`
			);
		}
	} catch (failure) {
		// Отказ печатается здесь, а не только пробрасывается: следом идёт возврат
		// стенда, и его собственная неудача иначе заменила бы собой причину.
		console.error(
			`проход прерван: ${failure instanceof Error ? failure.message : String(failure)}`
		);

		throw failure;
	} finally {
		await restore(browser, stand, storage);
		await browser.close();
		await rm(WORK, { recursive: true, force: true });
	}
}

await main();
