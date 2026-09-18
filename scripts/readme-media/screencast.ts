/**
 * Черновой скринкаст защиты: три сцены README одним проходом по стенду.
 *
 * Ролики README показывают по разделу каждый; защита требует другого — связного
 * прохода, где заявка с сайта становится взаимодействием, взаимодействие идёт по
 * процессу, процесс меняют на ходу, а в конце всё это объясняет отчёт. Собрать
 * такой проход руками нельзя: он идёт тремя ролями, трогает внешние системы и
 * длится три минуты, за которые человек успевает промахнуться мимо кнопки.
 * Скрипт же переснимает его целиком одной командой — и вместе с ним переснимает
 * таймкоды, по которым пишут закадровый текст.
 *
 * Запись идёт **против публичного стенда** и честно: заявка подаётся ключом
 * сайта в `POST /api/v1/applications`, группа уезжает в систему обучения кнопкой
 * с карточки, результат потока приходит ключом системы обучения. Ничего не
 * подделывается — иначе ролик показывал бы систему, которой нет.
 *
 * Что скрипт оставляет на стенде и что убирает за собой — `docs/readme-media.md`,
 * раздел «Скринкаст». Голоса в ролике нет: текст закадра пишется по таймкодам,
 * которые скрипт печатает и кладёт рядом с видео.
 *
 * ```
 * export SCREENCAST_DIR=…            # каталог вне репозитория
 * node scripts/readme-media/screencast.ts
 * node scripts/readme-media/screencast.ts --list
 * ```
 */
import { randomUUID } from 'node:crypto';
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

/**
 * Язык страницы записи.
 *
 * Тем же языком браузер представляется каталогу учётных записей и тем же
 * считает форматы в `Intl`. Собственные подписи Chromium — кнопка выбора файла
 * и порядок частей в поле даты — остаются английскими: в сборке Playwright
 * лежит только английская локаль, и ключ `--lang` её не добавляет
 * (`docs/readme-media.md`, «Скринкаст»).
 */
const LOCALE = 'ru-RU';

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
const BEAT = 1500;

/** Сколько ждать появления экрана или результата действия. */
const WAIT = 30_000;

function requiredEnv(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback;

	if (value === undefined || value === '') {
		throw new Error(`Не задано ${name}: см. docs/readme-media.md`);
	}

	return value;
}

const BASE_URL = requiredEnv('MEDIA_BASE_URL', 'http://localhost:3000').replace(/\/+$/, '');
const PASSWORD = requiredEnv('SEED_DEMO_PASSWORD');
const CMS_KEY = requiredEnv('EXCHANGE_API_KEY_CMS');
const LMS_KEY = requiredEnv('EXCHANGE_API_KEY_LMS');

/**
 * Куда складывается готовый ролик.
 *
 * Вне репозитория: видео на три минуты весит десятки мегабайт, переснимается
 * каждый раз заново и не является ни кодом, ни документацией. По умолчанию —
 * временный каталог машины, на которой снимают.
 */
const OUTPUT = process.env.SCREENCAST_DIR ?? path.join(tmpdir(), 'lct-screencast');

/** Экземпляры внешних систем стенда: ими подписаны сообщения обмена. */
const CMS_INSTANCE = 'itschool-site';
const LMS_INSTANCE = 'moodle-itschool';

/**
 * Вуз заявки — тот, что уже есть в справочнике стенда: заявка сверяется по ИНН и
 * попадает к действующему ответственному, а не заводит двойника.
 */
const APPLICANT = {
	name: 'Московский технический университет связи и информатики',
	inn: '0000000096',
	ogrn: '1260000000094'
} as const;

/** Стадия, которую переименовывает администратор, и как она называется в черновике. */
const RENAMED_STAGE = {
	key: 'communication',
	from: 'Коммуникация и сверка программ',
	to: 'Коммуникация и сверка образовательных программ'
} as const;

/** Кем открыт экран; вход идёт демонстрационной записью каталога. */
type Role = 'manager' | 'lead' | 'admin';

/** Открытая сессия роли: куки каталога и приложения, снятые заранее. */
type Session = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Что проход завёл на стенде: сцены передают это друг другу. */
type Stand = {
	/** Ключ заявки в CMS: уникален на запуск, по нему её видно в журнале обмена. */
	externalId: string;
	interactionId: string;
	/** Как система назвала взаимодействие: по названию его находят в списке. */
	title: string;
	/** Имя группы в системе обучения; его возвращает она сама. */
	groupExternalId: string | null;
	/** Что из изменённого на стенде предстоит вернуть обратно. */
	reassigned: boolean;
	renamed: boolean;
};

type Scene = {
	name: string;
	role: Role;
	caption: string;
	play: (page: Page, stand: Stand) => Promise<void>;
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

/** Пауза в долях такта: 1 — «дать прочитать», 0.5 — «не частить». */
async function beat(page: Page, times = 1): Promise<void> {
	await page.waitForTimeout(Math.round(BEAT * times));
}

/** Подвести курсор к элементу — видимым движением, а не прыжком. */
async function pointAt(page: Page, target: Locator): Promise<void> {
	await target.scrollIntoViewIfNeeded();

	const box = await target.boundingBox();

	if (box === null) {
		throw new Error('Элемента нет на экране: подвести к нему курсор не к чему');
	}

	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
	await page.waitForTimeout(300);
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
	await beat(page);
}

/** Прокрутка «как рукой»: несколько коротких движений вместо одного прыжка. */
async function scroll(page: Page, distance: number, steps = 6): Promise<void> {
	for (let step = 0; step < steps; step += 1) {
		await page.mouse.wheel(0, distance / steps);
		await page.waitForTimeout(90);
	}

	await beat(page, 0.5);
}

/**
 * Вход через каталог учётных записей: кнопка на нашей странице, форма Keycloak,
 * возврат в приложение. Другого входа в системе нет, и подделанная сессия
 * снимала бы систему, которой не существует.
 */
async function signIn(page: Page, login: string, typed: boolean): Promise<void> {
	await page.goto(`${BASE_URL}/login`);

	// В кадре страница входа сначала показывается целиком: с неё начинается
	// ролик, и на ней написано, какими ролями стенд смотрят.
	if (typed) {
		await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });
		await beat(page, 1.6);
	}

	await press(page, page.getByRole('button', { name: 'Войти', exact: true }));
	await page.waitForURL(/\/realms\/lct\/protocol\/openid-connect\/auth/, { timeout: WAIT });

	if (typed) {
		await beat(page, 0.7);
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
}

/**
 * Сессия роли, снятая заранее.
 *
 * Вход в кадре нужен ровно один раз — во вступлении. Остальные сцены начинаются
 * с уже открытой сессии: пять записей чужой формы ввода пароля подряд не
 * рассказывают о продукте ничего.
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

/** Конверт сообщения обмена: версия схемы, событие и кто его послал. */
function envelope(eventType: string, system: 'cms' | 'lms', data: Record<string, unknown>) {
	return {
		schemaVersion: '1.0',
		eventId: randomUUID(),
		eventType,
		occurredAt: new Date().toISOString(),
		source: { system, instance: system === 'cms' ? CMS_INSTANCE : LMS_INSTANCE },
		data
	};
}

async function exchangeCall(
	address: string,
	key: string,
	body: Record<string, unknown>
): Promise<Record<string, unknown>> {
	const response = await fetch(`${BASE_URL}${address}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});

	const text = await response.text();

	if (!response.ok) {
		throw new Error(`${address} ответил ${response.status}: ${text}`);
	}

	return JSON.parse(text) as Record<string, unknown>;
}

/** Заявка с сайта — тем же телом, что описано в контракте обмена. */
async function submitApplication(externalId: string): Promise<{ interactionId: string }> {
	const answer = await exchangeCall(
		'/api/v1/applications',
		CMS_KEY,
		envelope('application.submitted', 'cms', {
			externalId,
			revision: 1,
			form: 'b2b',
			applicant: {
				kind: 'educational_institution',
				name: APPLICANT.name,
				inn: APPLICANT.inn,
				ogrn: APPLICANT.ogrn,
				educationLevel: 'vo'
			},
			contact: {
				lastName: 'Кузьмина',
				firstName: 'Наталья',
				email: 'kuzmina@mtuci.example.org',
				phone: '+7 900 000-00-11',
				position: 'Проректор по цифровому развитию'
			},
			interest: 'Программа подготовки DevOps-инженеров',
			programCodes: ['VO-BAK-01'],
			productCodes: ['RT-DEVOPS'],
			comment: 'Просим связаться до конца недели.',
			transferStatus: 'not_started',
			attachments: []
		})
	);

	const data = answer.data as { interactionId?: string };

	if (typeof data.interactionId !== 'string') {
		throw new Error('Приём заявки не вернул идентификатор взаимодействия');
	}

	console.log(`заявка ${externalId}: ${String(answer.result)} → ${data.interactionId}`);

	return { interactionId: data.interactionId };
}

/** Результат потока из системы обучения: числа и подтверждение стадии. */
async function submitGroupResult(stand: Stand): Promise<void> {
	if (stand.groupExternalId === null) {
		throw new Error('Группа в системе обучения не заведена: результат посылать некуда');
	}

	const answer = await exchangeCall(
		'/api/v1/exchange/learning-groups/results',
		LMS_KEY,
		envelope('learning_group.result', 'lms', {
			groupExternalId: stand.groupExternalId,
			requestExternalId: `crm-group-${stand.interactionId}-1`,
			period: { start: '2026-10-01', end: '2027-05-31' },
			finishedOn: '2027-05-20',
			counters: { enrolled: 45, completed: 38, expelled: 4 }
		})
	);

	const data = answer.data as { stageConfirmed?: boolean; note?: string };

	console.log(
		`результат группы ${stand.groupExternalId}: стадия подтверждена — ${String(data.stageConfirmed)}; ${String(data.note)}`
	);
}

/**
 * Вложение к переходу: страница «скана» протокола.
 *
 * Рисует её `ffmpeg`, которым и так собирается видео: заводить ради одного
 * файла зависимость незачем, а прикладывать к переходу пустой файл — значит
 * показывать работу, которой не было.
 */
async function drawAttachment(): Promise<string> {
	const file = path.join(OUTPUT, 'protokol-vstrechi.png');
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

/** Прочитать имя группы с карточки: его вернула система обучения, а не мы. */
async function readGroupExternalId(page: Page): Promise<string> {
	const text = await page
		.getByText(/Поток 1 · группа/)
		.first()
		.innerText();
	const found = /группа\s+(\S+)/u.exec(text);

	if (found === null) {
		throw new Error(`На карточке нет имени группы: «${text}»`);
	}

	return found[1];
}

/**
 * Строка нашего взаимодействия в списке.
 *
 * Заявок с сайта на стенде несколько, и называются они одинаково — вузом и
 * интересом заявителя. Поэтому список открывается отсортированным по
 * активности: запись, которую только что вели, стоит первой. Название сверяется
 * до того, как со строкой что-то делают: ошибиться здесь значит переназначить
 * чужую работу.
 */
async function ourRow(page: Page, stand: Stand): Promise<Locator> {
	await visit(page, '/interactions?q=Заявка+с+сайта&sort=-lastActivityAt', 'Взаимодействия');

	const row = page.getByRole('row').nth(1);
	const text = (await row.innerText()).replace(/\s+/gu, ' ');
	const expected = stand.title.replace(/\s+/gu, ' ').slice(0, 60);

	if (expected === '' || !text.includes(expected)) {
		throw new Error(`Первой строкой списка стоит не наша заявка: «${text}»`);
	}

	return row;
}

const SCENES: readonly Scene[] = [
	{
		name: 'intro',
		role: 'manager',
		caption: 'Вступление: вход через каталог учётных записей и сводка дня',
		play: async (page) => {
			await signIn(page, 'manager', true);
			await page.getByText('Требуют действия').first().waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1.4);
			await scroll(page, 420);
		}
	},
	{
		name: 'exchange',
		role: 'admin',
		caption: 'Сцена 1: заявка с сайта, статус обратно, группа в LMS и её результат',
		play: async (page, stand) => {
			await visit(page, `/exchange?q=${stand.externalId}`, 'Внешние системы');
			await beat(page, 1.2);

			// Снимок статуса уходит фоновым проходом очереди, а не в той же
			// транзакции: журнал перечитывается, пока он не уедет.
			for (let attempt = 0; attempt < 4; attempt += 1) {
				// Состояние ищется в таблице: тем же словом назван пункт списка
				// фильтров, и он есть на странице всегда.
				if ((await page.locator('table').getByText('Отправлено').count()) > 0) {
					break;
				}

				await beat(page, 1.5);
				await page.reload({ waitUntil: 'load' });
				await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });
			}

			await beat(page, 1.4);

			// Таблица журнала шире окна: правые колонки — попытки, ответ получателя
			// и ссылка на взаимодействие — показываются прокруткой вбок.
			await page.mouse.move(FRAME.width / 2, 330);
			await page.mouse.wheel(500, 0);
			await beat(page, 1.6);

			const link = page
				.getByRole('link', { name: new RegExp(APPLICANT.name.slice(0, 20)) })
				.first();

			await press(page, link);
			await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });
			await page.getByText('Что происходит').first().waitFor({ state: 'visible', timeout: WAIT });

			stand.title = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();

			await beat(page, 1.6);
			await scroll(page, 900);

			await page.locator('#plannedSeats').fill('45');
			await page.locator('#startsOn').fill('2026-10-01');
			await page.locator('#endsOn').fill('2027-05-31');
			await beat(page, 0.8);

			await press(page, page.getByRole('button', { name: 'Отправить в LMS' }));
			await page
				.getByText(/Поток 1 · группа/)
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1.6);

			stand.groupExternalId = await readGroupExternalId(page);

			await submitGroupResult(stand);

			await page.reload({ waitUntil: 'load' });
			await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: WAIT });
			await scroll(page, 900);
			await page
				.getByText(/зачислено 45/)
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1.8);

			// Журнал целиком, а не по ключу заявки: у сообщений системы обучения
			// свой ключ, и все четыре направления видны только общим списком.
			await visit(page, '/exchange', 'Внешние системы');
			await beat(page, 1.6);
		}
	},
	{
		name: 'work',
		role: 'manager',
		caption: 'Сцена 2, работа: что мешает, чек-лист и переход с комментарием и файлом',
		play: async (page, stand) => {
			await visit(page, `/interactions/${stand.interactionId}`, 'Что мешает');
			await beat(page, 1.8);

			await press(page, page.getByRole('link', { name: 'Открыть чек-лист стадии' }));
			await beat(page, 1.2);

			for (const item of [
				'Найдено профильное подразделение',
				'Подтверждён контакт ответственного лица'
			]) {
				await press(page, page.getByRole('switch', { name: item }));
				await beat(page, 0.8);
			}

			await beat(page, 0.8);
			await scroll(page, -900);
			await page
				.getByText('Ничего не мешает: шаг вперёд доступен.')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1.6);

			await press(page, page.getByRole('button', { name: `Перейти: ${RENAMED_STAGE.from}` }));

			const dialog = page.getByRole('dialog');

			await dialog.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 0.8);

			await dialog.locator('[name="reason"]').click();
			await dialog
				.locator('[name="reason"]')
				.pressSequentially(
					'Профильное подразделение найдено, контакт подтверждён — идём к сверке программ.',
					{
						delay: 22
					}
				);
			await beat(page, 0.6);

			await dialog.locator('#transitionFiles').setInputFiles(await drawAttachment());
			await beat(page, 0.8);

			await press(page, dialog.getByRole('button', { name: 'Подтвердить' }));

			// Признак того, что переход состоялся, — чек-лист новой стадии: её
			// название есть на карточке и до перехода, в цепочке стадий.
			await page
				.getByText('Отправлено описание программ')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });
			await scroll(page, -900);
			await beat(page, 1.8);
		}
	},
	{
		name: 'roles',
		role: 'lead',
		caption: 'Сцена 2, роли: руководитель переназначает ответственного с передачей работы',
		play: async (page, stand) => {
			const row = await ourRow(page, stand);

			await beat(page, 1.4);

			await press(page, row.getByRole('checkbox', { name: 'Выбрать строку' }));
			await beat(page, 0.8);

			await press(page, page.getByRole('button', { name: 'Назначить ответственного' }));

			const dialog = page.getByRole('dialog');

			await dialog.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 0.8);

			// Список выбирается подписью поля: у нашей обёртки `Select` роль
			// «combobox» несёт скрытое поле формы, а не кнопка, которую видно.
			await press(page, dialog.getByLabel('Ответственный'));
			await press(page, page.getByRole('option', { name: /Вересова/ }));
			await beat(page, 0.6);

			await press(page, dialog.getByRole('button', { name: 'Назначить', exact: true }));
			await dialog.waitFor({ state: 'hidden', timeout: WAIT });

			stand.reassigned = true;
			await beat(page, 1.2);

			await visit(page, `/interactions/${stand.interactionId}`, 'Кто должен действовать');
			await page.getByText('Вересова').first().waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1.8);
		}
	},
	{
		name: 'process',
		role: 'admin',
		caption: 'Сцена 2, правила: черновик процесса, предпросмотр затронутых и применение ко всем',
		play: async (page, stand) => {
			await visit(page, '/settings/process/b2b', 'Процесс группы');
			await beat(page, 1.2);

			await press(page, page.getByRole('button', { name: 'Черновик изменений' }));
			await page
				.getByText('Черновик изменений — копия действующего процесса.')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1.4);

			await renameStage(page, RENAMED_STAGE.key, RENAMED_STAGE.to);

			// Таблица стадий шире окна и после правки стоит прокрученной вбок;
			// новое название целиком видно в цепочке стадий наверху страницы.
			await scroll(page, -1200);
			await page.getByText(RENAMED_STAGE.to).first().waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1.6);

			await press(page, page.getByRole('button', { name: 'Применить ко всем' }).first());

			const dialog = page.getByRole('dialog');

			await dialog.waitFor({ state: 'visible', timeout: WAIT });
			await dialog
				.getByText('Переедут на другую стадию')
				.waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 2.2);

			await press(page, dialog.getByRole('button', { name: 'Применить ко всем' }));
			await page
				.getByText('Действующий процесс открыт только на чтение')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });

			stand.renamed = true;
			await beat(page, 1.2);

			await visit(page, `/interactions/${stand.interactionId}`, 'Что происходит');
			await page.getByText(RENAMED_STAGE.to).first().waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 2);
		}
	},
	{
		name: 'reports',
		role: 'manager',
		caption: 'Сцена 3: отчёт за период, воронка, путь от числа к карточке, выгрузки и справка',
		play: async (page) => {
			await visit(page, '/reports', 'Отчёты по взаимодействиям');
			await beat(page, 1.6);
			await scroll(page, 500);

			await selectFunnelBar(page);
			await beat(page, 1.6);
			await scroll(page, 600);
			await beat(page, 1.2);

			await press(page, page.getByRole('link', { name: 'Открыть эти взаимодействия в списке' }));
			await page.getByText('Взаимодействия').first().waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1.4);

			await press(page, page.getByRole('row').nth(1));
			await page.getByText('Что происходит').first().waitFor({ state: 'visible', timeout: WAIT });
			await beat(page, 1.6);

			await visit(page, '/reports?mode=movement', 'Каждая строка — один переход');
			await beat(page, 1.4);
			await scroll(page, 420);
			await beat(page, 1.2);
			await scroll(page, -420);

			for (const format of ['XLSX', 'PDF']) {
				const download = page.waitForEvent('download', { timeout: WAIT });

				await press(page, page.getByRole('link', { name: format, exact: true }).first());

				const file = await download;

				console.log(`выгрузка ${format}: ${file.suggestedFilename()}`);
				await file.delete();
				await beat(page, 0.8);
			}

			await beat(page, 0.8);
			await visit(page, '/help', 'Руководство пользователя');
			await beat(page, 1.4);
			await visit(page, '/api/docs', 'LCT CRM API', { standalone: true });
			await beat(page, 1.8);
		}
	}
];

/** Переименовать стадию черновика: диалог стадии, поле названия, сохранение. */
async function renameStage(page: Page, key: string, name: string): Promise<void> {
	const row = page.getByRole('row').filter({ hasText: key });

	await press(page, row.getByRole('button', { name: 'Изменить' }));

	const dialog = page.getByRole('dialog');

	await dialog.waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 0.8);

	const field = dialog.locator('input[name="name"]');

	await pointAt(page, field);
	await field.fill('');
	await field.pressSequentially(name, { delay: 26 });
	await beat(page, 0.8);

	await press(page, dialog.getByRole('button', { name: 'Сохранить стадию' }));
	await dialog.waitFor({ state: 'hidden', timeout: WAIT });
	await page
		.getByRole('cell', { name, exact: true })
		.first()
		.waitFor({ state: 'visible', timeout: WAIT });
}

/**
 * Клик по столбцу воронки.
 *
 * Диаграмма — холст, и попасть в столбец можно только по точке. Столбцы
 * горизонтальные и разной длины, поэтому проба идёт у самого начала оси, где
 * есть даже самый короткий из них, и сверху вниз — пока адрес не получит
 * фильтр стадии.
 */
async function selectFunnelBar(page: Page): Promise<void> {
	const canvas = page.getByTestId('report-chart-canvas').first();

	await canvas.scrollIntoViewIfNeeded();

	const box = await canvas.boundingBox();

	if (box === null) {
		throw new Error('Диаграммы отчёта нет на экране');
	}

	const rows = 14;

	for (let index = 0; index < rows; index += 1) {
		const x = box.x + box.width * 0.42;
		const y = box.y + (box.height / rows) * (index + 0.5);

		await page.mouse.move(x, y, { steps: 18 });
		await page.waitForTimeout(160);
		await page.mouse.click(x, y);
		await page.waitForTimeout(700);

		if (page.url().includes('stage=')) {
			return;
		}
	}

	throw new Error('Клик по воронке не сузил отчёт: ни в один столбец не попали');
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

function timecode(seconds: number): string {
	const whole = Math.floor(seconds);

	return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Запись одной сцены.
 *
 * Своя сессия и свой контекст на сцену: роль в ролике меняется целиком — вместе
 * с меню, правами и набором экранов, — и половинчатая смена показывала бы
 * систему, в которую так не входят.
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
		// Вступление входит в кадре: сессия ему не передаётся.
		storageState: scene.name === 'intro' ? undefined : session(storage, scene.role)
	});

	await context.addInitScript({ content: CURSOR });

	const page = await context.newPage();
	const video = page.video();

	if (video === null) {
		await context.close();

		throw new Error('Запись видео не включилась');
	}

	try {
		await page.mouse.move(FRAME.width / 2, FRAME.height / 2);
		await scene.play(page, stand);
	} catch (failure) {
		await context.close();

		throw failure;
	}

	// Файл дописывается при закрытии контекста, а не страницы.
	await context.close();

	const target = path.join(directory, `${scene.name}.mp4`);

	await toMp4(await video.path(), target);

	return target;
}

/**
 * Убрать за собой.
 *
 * Стенд общий и его смотрят: ответственный и название стадии возвращаются тем же
 * путём, которым менялись, — интерфейсом и от имени той же роли. Возвращается
 * только то, что этот проход действительно изменил: лишняя публикация процесса
 * оставила бы в журнале запись об изменении, которого не было.
 */
async function restore(browser: Browser, stand: Stand, storage: Map<Role, Session>): Promise<void> {
	if (stand.reassigned) {
		const lead = await browser.newContext({
			viewport: FRAME,
			locale: LOCALE,
			storageState: session(storage, 'lead')
		});

		try {
			const page = await lead.newPage();
			const row = await ourRow(page, stand);

			await row.getByRole('checkbox', { name: 'Выбрать строку' }).click();
			await page.getByRole('button', { name: 'Назначить ответственного' }).click();

			const dialog = page.getByRole('dialog');

			await dialog.waitFor({ state: 'visible', timeout: WAIT });
			await dialog.getByLabel('Ответственный').click();
			await page.getByRole('option', { name: /Менеджер Демо/ }).click();
			await dialog.getByRole('button', { name: 'Назначить', exact: true }).click();
			await dialog.waitFor({ state: 'hidden', timeout: WAIT });

			console.log('ответственный возвращён: Менеджер Демо');
		} finally {
			await lead.close();
		}
	}

	if (stand.renamed) {
		const admin = await browser.newContext({
			viewport: FRAME,
			locale: LOCALE,
			storageState: session(storage, 'admin')
		});

		try {
			const page = await admin.newPage();

			await page.goto(`${BASE_URL}/settings/process/b2b`);
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
		} finally {
			await admin.close();
		}
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args.includes('--list')) {
		for (const scene of SCENES) {
			console.log(`${scene.name.padEnd(10)} ${scene.role.padEnd(8)} — ${scene.caption}`);
		}

		return;
	}

	await mkdir(OUTPUT, { recursive: true });

	const stand: Stand = {
		externalId: `site-demo-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`,
		interactionId: '',
		title: '',
		groupExternalId: null,
		reassigned: false,
		renamed: false
	};

	// Заявка подаётся до записи: снимок её статуса уезжает в CMS фоновым
	// проходом очереди, и к сцене обмена он уже должен быть доставлен.
	stand.interactionId = (await submitApplication(stand.externalId)).interactionId;

	const directory = await mkdtemp(path.join(tmpdir(), 'lct-screencast-'));
	const browser = await chromium.launch();
	const storage = new Map<Role, Session>();

	try {
		for (const role of ['manager', 'lead', 'admin'] as const) {
			storage.set(role, await storageFor(browser, role));
		}

		const parts: { name: string; caption: string; file: string; seconds: number }[] = [];

		for (const scene of SCENES) {
			const file = await record(browser, scene, stand, storage, directory);
			const seconds = await durationOf(file);

			parts.push({ name: scene.name, caption: scene.caption, file, seconds });
			console.log(`${scene.name}: ${seconds.toFixed(1)} с`);
		}

		const list = path.join(directory, 'parts.txt');

		await writeFile(list, parts.map((part) => `file '${part.file}'`).join('\n'), 'utf8');

		const target = path.join(
			OUTPUT,
			`screencast-draft-${new Date().toISOString().slice(0, 10)}.mp4`
		);

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
			const at = offset;

			offset += part.seconds;

			return {
				scene: part.name,
				caption: part.caption,
				start: timecode(at),
				end: timecode(offset),
				seconds: Number(part.seconds.toFixed(2))
			};
		});

		const timecodes = {
			file: target,
			recordedAt: new Date().toISOString(),
			baseUrl: BASE_URL,
			frame: FRAME,
			totalSeconds: Number(offset.toFixed(2)),
			total: timecode(offset),
			interactionId: stand.interactionId,
			externalId: stand.externalId,
			groupExternalId: stand.groupExternalId,
			scenes: marks
		};

		await writeFile(
			path.join(OUTPUT, 'timecodes.json'),
			`${JSON.stringify(timecodes, null, '\t')}\n`,
			'utf8'
		);

		console.log(`\n${target}`);
		console.log(`длительность: ${timecode(offset)}\n`);

		for (const mark of marks) {
			console.log(`${mark.start}–${mark.end}  ${mark.scene.padEnd(10)} ${mark.caption}`);
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
		await rm(directory, { recursive: true, force: true });
	}
}

await main();
