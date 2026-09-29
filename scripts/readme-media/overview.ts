/**
 * Полный видеообзор стенда для экспертов: шесть–восемь минут по разделам
 * README подряд — от сводки менеджера до программного интерфейса.
 *
 * Скринкаст показа (`screencast.ts`) рассказывает одну историю за три минуты и
 * поэтому оставляет за кадром половину продукта: карточку вуза с паспортом из
 * официальных источников, пакет документов и скан подписанного экземпляра с
 * отметкой, список слушателей потока, удаление стадии с переносом записей,
 * новый процесс и модули пространства, данные об обучении, карту
 * автоматизации, сбой и восстановление обмена и статус системы. Обзор идёт тем же проходом и теми же действиями
 * (`acts.ts`), но между ними показывает всё это — тоже вживую и тоже честно:
 * ничего не подделывается, внешние стороны отвечают со своих страниц.
 *
 * Механика — та же (`film.ts`): своя роль и свой контекст на сцену, курсор в
 * кадре, реплика закадра задаёт минимальную длину сцены. Сверх ролика, кадров,
 * `timecodes.json` и `subtitles.srt` обзор пишет `voiceover.md` — текст закадра
 * по сценам с таймкодами, готовый для диктора.
 *
 * Стенд общий. Всё, что обзор меняет обратимо, — стадию и название заявки,
 * ответственного за вуз, название стадии процесса, доступность имитатора
 * сайта — он возвращает сам, тем же интерфейсом; что остаётся до ночного
 * сброса — `docs/readme-media.md`.
 *
 * ```
 * export MEDIA_BASE_URL=https://alma.volkv.com
 * export SEED_DEMO_PASSWORD=…          # пароль демонстрационных записей каталога
 * export OVERVIEW_DIR=…                # каталог вне репозитория, куда лечь ролику
 * node scripts/readme-media/overview.ts
 * node scripts/readme-media/overview.ts --list
 * ```
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';

import {
	freshStand,
	handOver,
	openApplication,
	openInteraction,
	openOrganization,
	renameLiveStage,
	reportAndExport,
	reportFunnels,
	restorePass,
	runLearningGroup,
	showApplicationLog,
	showHandedOver,
	showSiteSide,
	standSummary,
	submitApplication,
	traceNumber,
	workTheCard,
	type Stand
} from './acts.ts';
import {
	BASE_URL,
	WAIT,
	beat,
	glance,
	drawScan,
	film,
	hydrated,
	pointAt,
	press,
	scroll,
	showCard,
	showSlide,
	signIn,
	timecode,
	visit,
	withRole,
	type Crew,
	type Mark,
	type Scene,
	type Sessions
} from './film.ts';
import { draftMention, openInbox, sendComment } from './shots.ts';

/**
 * Куда складывается готовый обзор.
 *
 * Вне репозитория, как и скринкаст: семь минут видео весят десятки мегабайт и
 * переснимаются одной командой. По умолчанию — временный каталог машины.
 */
const OUTPUT = process.env.OVERVIEW_DIR ?? path.join(tmpdir(), 'lct-overview');

/** Имя ролика в каталоге вывода. */
const FILE = 'overview-draft.mp4';

/**
 * Что обзор меняет сверх общих действий.
 *
 * `retitled` — прежнее название заявки: руководитель переименовывает её, чтобы
 * показать отказ сохранения поверх чужой правки, и название возвращается
 * после записи. `cmsDown` — имитатор сайта сделан недоступным в сцене сбоя
 * обмена и ещё не возвращён.
 */
type OverviewStand = Stand & { retitled: string | null; cmsDown: boolean };

/** Вуз, на котором показана карточка организации: у него настоящий сайт и ИНН в ЕГРЮЛ. */
const PARTNER = {
	query: 'СПбПУ',
	name: 'СПбПУ',
	/** ИНН из ЕГРЮЛ: в демонстрационной карточке он вымышленный, и сверка это покажет. */
	inn: '7804040077'
} as const;

/** Взаимодействие на стадии встречи: на нём пакет документов и приглашение в календарь. */
const MEETING = {
	query: 'встреча с подразделением',
	expected: 'встреча с подразделением',
	/** Кого из контактов вуза зовут на встречу. */
	invitees: ['Щербак Антон Валентинович', 'Эльдарова Замира Руслановна'],
	location: 'МТУСИ, Авиамоторная ул., 8а, ауд. 214',
	/** Дата и время встречи — значение поля `datetime-local`. */
	start: '2026-10-06T11:00'
} as const;

/**
 * Скан подписанного экземпляра: менеджер загружает его новой редакцией
 * собранного соглашения — отдельно загруженный файл стадию подписания не
 * закрыл бы.
 */
const SIGNED_COPY = {
	/** Пункт «Что загружаете»: новая редакция PDF собранного соглашения. */
	target: /^Новая редакция: Соглашение .* · PDF · /u,
	change: 'подписанный сторонами скан',
	note: 'подписано обеими сторонами'
} as const;

/** Взаимодействие, которое менеджер заводит вручную в начале прохода. */
const NEW_INTERACTION = {
	title: 'СПбПУ: подготовка аналитиков данных, 2026/2027',
	institution: 'СПбПУ'
} as const;

/** Руководитель демо-стенда — адресат ответа в чате взаимодействия. */
const DEMO_LEAD_NAME = 'Руководитель Демо';

/** Ответ менеджера руководителю в ленте взаимодействия. */
const CHAT_REPLY = 'принял, контакт подтверждён — готовлю описание программ.';

/** Новый процесс, который администратор начинает заводить и не заводит. */
const NEW_WORKFLOW = 'Корпоративные продажи';

/** Стадия, которую администратор удаляет в черновике, чтобы увидеть перенос записей. */
const REMOVED_STAGE = { key: 'contact_search', name: 'Поиск контактных лиц' } as const;

/**
 * Поимённый список потока: вымышленные люди с адресами в зарезервированном
 * домене. Колонки — те, что ждёт загрузка (`ROSTER_FILE_FORMATS_HINT`).
 */
const ROSTER = [
	'ФИО,Почта,Телефон',
	'Алексеева Дарья Игоревна,d.alekseeva@student.example.org,+7 900 100-00-01',
	'Борисов Кирилл Андреевич,k.borisov@student.example.org,',
	'Власова Полина Сергеевна,p.vlasova@student.example.org,+7 900 100-00-03'
].join('\n');

const TITLE_CARD = `
	<div class="rule"></div>
	<p class="kicker">ИТ Школа Ростелекома · «Лидеры цифровой трансформации 2026»</p>
	<h1>Альма CRM</h1>
	<p class="lead">От первого контакта с вузом до подтверждённого результата — проще, быстрее и под контролем</p>
	<p class="foot">Wine Coding Team</p>
`;

const FINAL_CARD = `
	<div class="rule"></div>
	<h1>Спасибо за внимание</h1>
	<ul>
		<li><b class="accent">alma.volkv.com</b> — три роли: менеджер, руководитель, администратор; пароль — на странице входа</li>
		<li><b class="accent">/help</b> — руководства внутри системы, <b class="accent">/api/docs</b> — описание программного интерфейса</li>
		<li><b class="accent">github.com/volkv/alma-crm-2026</b> — исходный код и документация</li>
		<li><b class="accent">alma.volkv.com/video-presentation.mp4</b> — эта видеопрезентация</li>
	</ul>
	<p class="foot">Wine Coding Team</p>
`;

/**
 * Каталог слайдов презентации: PNG страниц колоды под именами сцен
 * (`import.png`, `steps.png` …). Колода собирается вне репозитория, поэтому
 * каталог приходит переменной окружения. Съёмка без него не начинается:
 * сцена-слайд без картинки оборвала бы запись посередине.
 */
const SLIDES = process.env.OVERVIEW_SLIDES ?? '';

/** Картинки, которые берут сцены-слайды. */
const SLIDE_FILES = [
	'design',
	'import',
	'steps',
	'security',
	'stack',
	'architecture',
	'performance'
] as const;

type SlideFile = (typeof SLIDE_FILES)[number];

/** Заставка главы: номер и название части на карточке оформления стенда. */
function chapter(
	number: number,
	title: string,
	narration: readonly string[]
): Scene<OverviewStand> {
	return {
		name: `chapter-${number}`,
		role: 'manager',
		caption: `Часть ${number}. ${title}`,
		narration,
		play: async (page) => {
			await showCard(
				page,
				`<div class="rule"></div><p class="kicker">Часть ${number}</p><h1>${title}</h1>`
			);
			await beat(page, 1);
		}
	};
}

/** Слайд презентации на весь кадр. */
function slide(
	name: string,
	file: SlideFile,
	caption: string,
	narration: readonly string[]
): Scene<OverviewStand> {
	return {
		name,
		role: 'manager',
		caption,
		narration,
		play: async (page) => {
			await showSlide(page, path.join(SLIDES, `${file}.png`));
			await beat(page, 1);
		}
	};
}

/** Открыть карточку заявки, заведённой в начале прохода. */
async function openStandCard(page: Page, stand: Stand): Promise<void> {
	await visit(page, `/interactions/${stand.interactionId}`, 'Все стадии процесса');
}

/** Сохранить план карточки с новым названием: диалог «Изменить план». */
async function retitle(page: Page, title: string, reason: string): Promise<void> {
	await page.getByRole('button', { name: 'Изменить план' }).click();

	const dialog = page.getByRole('dialog');

	await dialog.waitFor({ state: 'visible', timeout: WAIT });
	await dialog.locator('#card-plan-title').fill(title);
	await dialog.locator('#card-plan-reason').fill(reason);
	await dialog.getByRole('button', { name: 'Сохранить план' }).click();
	await dialog.waitFor({ state: 'hidden', timeout: WAIT });
}

/**
 * Сводка «Мой день»: счётчики разделов, раздел с подсказкой, что сделать, и
 * переход в список с тем же числом взаимодействий и меткой среза над ним.
 */
async function myDay(page: Page): Promise<void> {
	await visit(page, '/', 'Мой день');
	await pointAt(page, page.locator('[data-slot="day-counters"]'));
	await beat(page, 1);

	// Плитка счётчика — якорь к своему разделу ниже.
	await press(page, page.locator('[data-slot="day-counters"] a').first());
	await beat(page, 0.6);

	// Раздел со ссылкой в список: у короткого раздела (одно взаимодействие без
	// ответственного) её нет — все его взаимодействия и так на экране.
	const section = page
		.locator('[data-slot="day-card"]')
		.filter({ has: page.locator('footer a') })
		.first();

	await pointAt(page, section.locator('header p'));
	await beat(page, 1.2);

	// В список ведёт ссылка раздела: одна «Все N в списке» или по ссылке на
	// часть каждого пространства — первая из них.
	const list = section.locator('footer a').first();

	await pointAt(page, list);
	await beat(page, 0.6);
	await press(page, list);
	await page.waitForURL(/[?&]day=/u, { timeout: WAIT });
	await hydrated(page);

	const slice = page.getByText(/^Мой день: /u).first();

	await slice.waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, slice);
	await beat(page, 1.4);
	await scroll(page, 420);
	await beat(page, 0.8);
}

/**
 * Защита от перетирания: менеджер правит план, руководитель в той же карточке
 * успевает сохранить своё — и сохранение менеджера отказывает, называя, кто и
 * когда изменил запись.
 */
async function staleEdit(page: Page, stand: OverviewStand, lead: Page): Promise<void> {
	const original = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();

	await press(page, page.getByRole('button', { name: 'Изменить план' }));

	const dialog = page.getByRole('dialog');

	await dialog.waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 0.5);

	const reason = dialog.locator('#card-plan-reason');

	await pointAt(page, reason);
	await reason.click();
	await reason.pressSequentially('Вуз просит начать соглашение с ноября.', { delay: 22 });
	await beat(page, 0.4);

	// Правка руководителя — настоящая, через тот же диалог его карточки.
	// Название, а не сроки: его прежнее значение известно наверняка и
	// возвращается после записи одним полем.
	stand.retitled = original;
	await retitle(lead, `${original}, набор 2026`, 'Уточнил набор по письму вуза.');
	await beat(page, 1);

	await press(page, dialog.getByRole('button', { name: 'Сохранить план' }));

	const refusal = dialog.getByText(/Запись изменил .+ в \d{1,2}:\d{2}/u).first();

	await refusal.waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, refusal);
	await beat(page, 1.4);
	await pointAt(page, reason);
	await beat(page, 1);
}

/**
 * Карточка вуза: «Сведения» с сайта с источником и датой, подбор программ с
 * объяснением, договоры и лицензии — и сверка реквизитов с ЕГРЮЛ в форме
 * правки, без сохранения.
 */
async function partnerCard(page: Page): Promise<void> {
	await openOrganization(page, PARTNER.query, PARTNER.name);
	await beat(page, 1);

	await pointAt(page, page.getByText('Сведения с сайта вуза').first());
	await beat(page, 0.6);

	// Раздел «Сведения» читается кнопкой и держится в кэше сутки: на свежем
	// стенде его читают в кадре, после — показывают прочитанное.
	const read = page.getByRole('button', { name: 'Прочитать «Сведения» на сайте' });

	if ((await read.count()) > 0) {
		await press(page, read);
		await page
			.getByText('Кандидаты в контакты')
			.first()
			.waitFor({ state: 'attached', timeout: WAIT });
	}

	await pointAt(page, page.getByText(/^Сайт .+, прочитан /u).first());
	await beat(page, 1);

	// Кандидаты в контакты свёрнуты под строкой рекомендаций: раскрываются
	// тем же нажатием, что и у человека.
	await press(page, page.locator('[aria-controls="org-site-details"]').first());
	await pointAt(page, page.getByText(/^Источник: /u).first());
	await beat(page, 1);
	await pointAt(page, page.getByRole('button', { name: 'Добавить в контакты' }).nth(1));
	await beat(page, 0.8);

	await pointAt(page, page.getByText('Подходящие программы школы').first());
	await beat(page, 0.4);
	await pointAt(page, page.getByText('Почему:').first());
	await beat(page, 1.6);

	await pointAt(page, page.getByText('Договоры и лицензии', { exact: true }).first());
	await beat(page, 0.4);
	await pointAt(page, page.getByText('Истекает', { exact: true }).first());
	await beat(page, 0.6);
	await pointAt(page, page.getByRole('button', { name: 'Запустить продление' }).first());
	await beat(page, 1);

	await scroll(page, -6000, 8);
	await press(
		page,
		page
			.getByRole('link', { name: 'Изменить', exact: true })
			.or(page.getByRole('button', { name: 'Изменить', exact: true }))
			.first()
	);
	await page
		.getByText('Паспорт из официальных источников')
		.first()
		.waitFor({ state: 'visible', timeout: WAIT });
	await hydrated(page);

	const query = page.getByLabel('ИНН или название организации');

	// В поле уже стоит ИНН из карточки — вымышленный, как и все реквизиты
	// стенда: настоящий набирается поверх, как это сделал бы человек.
	await pointAt(page, query);
	await query.fill('');
	await query.pressSequentially(PARTNER.inn, { delay: 60 });
	await press(page, page.getByRole('button', { name: 'Проверить в ЕГРЮЛ' }));
	await page
		.getByRole('button', { name: /Перенести отмеченное в форму/u })
		.waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, page.getByText('Из источника', { exact: true }).first());
	await beat(page, 0.6);
	await pointAt(page, page.getByText('ЕГРЮЛ (Dadata)').nth(2));
	await beat(page, 1.6);
}

/**
 * Документы взаимодействия: пакет по шаблону, скан подписанного экземпляра новой
 * редакцией собранного соглашения с отметкой «Утверждён» и повторная сборка,
 * которая подписанное не трогает.
 */
async function documents(page: Page, crew: Crew): Promise<void> {
	await openInteraction(page, MEETING.query, MEETING.expected);
	await beat(page, 0.8);

	await press(page, page.getByRole('button', { name: 'Собрать пакет документов' }));

	const pack = page.getByRole('dialog');

	await pack.waitFor({ state: 'visible', timeout: WAIT });
	await pack.locator('#card-package-city').fill('Москва');
	await pack.locator('#card-package-operator-signer').fill('директор Школы Орлов К. В.');
	await pack.locator('#card-package-counterparty-signer').fill('ректор Ерохин С. Д.');
	await beat(page, 0.6);
	await press(page, pack.getByRole('button', { name: 'Собрать', exact: true }));

	// Пакет собирается по документу: что собралось — «Собран», что нет —
	// причина словами. Ожидание — на первый итог, а не на всплывашку: при
	// частичной сборке диалог остаётся открытым.
	await page
		.getByText('Собран', { exact: true })
		.or(page.getByText(/^Пакет собран: /u))
		.first()
		.waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 0.6);

	const refused = pack.getByText(/^Не собран: /u).first();

	if ((await refused.count()) > 0) {
		await pointAt(page, refused);
		await beat(page, 1.6);
		await press(page, pack.getByRole('button', { name: 'Закрыть', exact: true }).first());
	}

	await pack.waitFor({ state: 'hidden', timeout: WAIT });
	await beat(page, 0.6);

	const scan = await drawScan(crew.work, 'soglashenie-podpisano.png', [
		'Соглашение о сотрудничестве',
		'МТУСИ · подписанный экземпляр',
		'Демонстрационный файл записи обзора'
	]);

	await press(page, page.getByRole('button', { name: 'Загрузить', exact: true }));

	const upload = page.getByRole('dialog');

	await upload.waitFor({ state: 'visible', timeout: WAIT });
	await press(page, upload.locator('#card-upload-target'));
	await press(page, page.getByRole('option', { name: SIGNED_COPY.target }));
	await pointAt(page, upload.getByText(/^Скан подписанного экземпляра собранного документа/u));
	await beat(page, 1.4);
	await upload.locator('#card-upload-note').fill(SIGNED_COPY.change);
	await upload.locator('#card-document-file').setInputFiles(scan);
	await beat(page, 0.6);
	await press(page, upload.getByRole('button', { name: 'Загрузить', exact: true }));
	await upload.waitFor({ state: 'hidden', timeout: WAIT });
	await beat(page, 0.6);

	// Скан встал на место PDF-редакции: строка с пометкой «Скан» — та же
	// бумага, и отметку ставят на ней.
	const scanned = page.locator('li').filter({ hasText: 'Скан, загружен' }).first();

	await pointAt(page, scanned);
	await beat(page, 0.8);
	await press(page, scanned.getByRole('button', { name: /^Действия с «/u }));
	await press(page, page.getByRole('menuitem', { name: 'Поставить отметку' }));

	const mark = page.getByRole('dialog');

	await mark.waitFor({ state: 'visible', timeout: WAIT });
	await press(page, mark.locator('#card-mark-fact'));
	await press(page, page.getByRole('option', { name: 'Утверждён', exact: true }));
	await mark.locator('#card-mark-note').fill(SIGNED_COPY.note);
	await beat(page, 1);
	await press(page, mark.getByRole('button', { name: 'Поставить отметку' }));
	await mark.waitFor({ state: 'hidden', timeout: WAIT });
	await pointAt(
		page,
		page
			.locator('[data-slot="status-badge"]')
			.filter({ hasText: `Утверждён: ${SIGNED_COPY.note}` })
			.first()
	);
	await beat(page, 1);

	// Повторная сборка: подписанное соглашение в ней не отмечено и
	// пересобирается только явным выбором. Диалог закрывается без сборки.
	await press(page, page.getByRole('button', { name: 'Собрать пакет документов' }));

	const again = page.getByRole('dialog');

	await again.waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, again.getByText(/^Подписан — пересборка создаст/u).first());
	await beat(page, 1.6);
	await press(page, again.getByRole('button', { name: 'Отмена', exact: true }));
	await again.waitFor({ state: 'hidden', timeout: WAIT });
}

/**
 * Приглашение на встречу со стадии встречи: контакты вуза, место, время и
 * файл календаря с повесткой по чек-листу стадии.
 */
async function meetingInvite(page: Page, crew: Crew): Promise<void> {
	await openInteraction(page, MEETING.query, MEETING.expected);
	await beat(page, 0.8);

	await page.getByRole('button', { name: 'Ещё', exact: true }).click();
	await press(page, page.getByRole('menuitem', { name: 'Пригласить на встречу' }));

	const meeting = page.getByRole('dialog');

	await meeting.waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 1);
	await meeting.locator('#card-meeting-start').fill(MEETING.start);
	await meeting.locator('#card-meeting-location').fill(MEETING.location);
	await beat(page, 1);

	for (const person of MEETING.invitees) {
		await press(page, meeting.getByRole('checkbox', { name: new RegExp(person, 'u') }));
	}

	await beat(page, 0.8);

	const download = page.waitForEvent('download', { timeout: WAIT });

	await press(page, meeting.getByRole('button', { name: 'Скачать .ics', exact: true }));

	// Приглашение открывается как текст: браузер показывает календарный файл
	// только скачиванием, а в ролике важно, что внутри — дата, место,
	// участники и повестка.
	const invite = path.join(crew.work, 'invite.txt');

	await (await download).saveAs(invite);
	await page.goto(`file://${invite}`, { waitUntil: 'load' });
	// Файл — подтверждение, а не предмет рассказа: пара секунд, без растяжения.
	await glance(page, 2);
}

/** Поимённый список к только что заведённому потоку: проверка файла, загрузка, передача. */
async function roster(page: Page, group: string, crew: Crew): Promise<void> {
	const file = path.join(crew.work, 'slushateli.csv');

	await writeFile(file, `${ROSTER}\n`, 'utf8');

	// Кнопка списка названа номером потока, а не ключом группы: номер
	// читается из заголовка потока «Поток N · группа <ключ>».
	const text = await page.locator('main').innerText();
	const flow = new RegExp(`Поток\\s+(\\d+)\\s+·\\s+группа\\s+${group}(?!\\S)`, 'u').exec(text);

	if (flow === null) {
		throw new Error(`На карточке нет потока группы ${group}`);
	}

	await press(
		page,
		page.getByRole('button', { name: new RegExp(`^Слушатели потока ${flow[1]} — `, 'u') })
	);

	const dialog = page.getByRole('dialog');

	await dialog.waitFor({ state: 'visible', timeout: WAIT });
	await dialog.locator('#card-roster-file').setInputFiles(file);
	await beat(page, 0.4);
	await press(page, dialog.getByRole('button', { name: 'Проверить файл' }));
	await dialog
		.getByText('Что станет со строками файла')
		.waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 1.4);
	await press(page, dialog.getByRole('button', { name: /^Загрузить строк: / }));
	await dialog.getByText('Список загружен').waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 0.6);
	await press(page, dialog.getByRole('button', { name: 'Передать список в LMS' }));
	await dialog.getByText(/передано в LMS: [1-9]/u).waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 1.4);
}

/**
 * Удаление стадии в черновике: сколько записей на ней стоит, куда они
 * переедут, предпросмотр применения — и отмена черновика. Применять удаление
 * на общем стенде нельзя: ключ удалённой стадии занят навсегда, и вернуть
 * процесс к прежнему виду было бы нечем.
 */
async function removalPreview(page: Page): Promise<void> {
	await visit(page, '/settings/workflows/b2b', 'Процесс');
	await press(page, page.getByRole('button', { name: 'Черновик изменений' }));
	await page
		.getByText('Стадии и переходы правятся в черновике')
		.first()
		.waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 0.6);

	const row = page.getByRole('row').filter({ hasText: REMOVED_STAGE.key });

	await press(page, row.getByRole('button', { name: /^Удалить стадию/u }));

	const remove = page.getByRole('dialog');

	await remove.waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, remove.getByText('Сейчас на этой стадии стоит').first());
	await beat(page, 1.2);
	await pointAt(page, remove.getByText('Куда перенести записи').first());
	await beat(page, 0.6);
	await press(page, remove.getByRole('button', { name: 'Удалить стадию', exact: true }));
	await remove.waitFor({ state: 'hidden', timeout: WAIT });

	await scroll(page, -1200);
	await press(page, page.getByRole('button', { name: 'Применить ко всем' }).first());

	const preview = page.getByRole('dialog');

	await preview.waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, preview.getByText('Переедут на другую стадию').first());
	await beat(page, 0.8);
	await pointAt(page, preview.getByText('Куда переедут').first());
	await beat(page, 1.6);
	await press(page, preview.getByRole('button', { name: 'Отмена', exact: true }));
	await preview.waitFor({ state: 'hidden', timeout: WAIT });

	await press(page, page.getByRole('button', { name: 'Отменить черновик' }));
	await press(
		page,
		page
			.getByRole('alertdialog')
			.or(page.getByRole('dialog'))
			.getByRole('button', { name: 'Отменить черновик' })
	);
	await page
		.getByRole('button', { name: 'Черновик изменений' })
		.waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 0.6);
}

/**
 * Гибкость без кода: диалог нового процесса — ключ из названия, пустой или
 * копией действующего — и модули пространства с тем, что каждый даёт и что
 * выключить нельзя. Процесс не заводится: стенд общий, а заведённый процесс
 * удалить нечем.
 */
async function flexibility(page: Page): Promise<void> {
	await visit(page, '/settings/workflows', 'Процессы');
	await press(page, page.getByRole('button', { name: 'Создать процесс' }));

	const dialog = page.getByRole('dialog');

	await dialog.waitFor({ state: 'visible', timeout: WAIT });

	const name = dialog.getByLabel('Название');

	await pointAt(page, name);
	await name.pressSequentially(NEW_WORKFLOW, { delay: 40 });
	await pointAt(page, dialog.getByLabel('Ключ'));
	await beat(page, 0.8);

	await press(page, dialog.getByLabel('С чего начать'));
	await pointAt(page, page.getByRole('option', { name: /^Копия «/u }).first());
	await beat(page, 1.2);
	await page.keyboard.press('Escape');
	await beat(page, 0.4);
	await press(page, dialog.getByRole('button', { name: 'Отмена', exact: true }));
	await dialog.waitFor({ state: 'hidden', timeout: WAIT });

	await visit(page, '/settings/workspaces/b2b', 'Модули');
	await pointAt(page, page.getByText(/— стадий: \d+/u).first());
	await beat(page, 0.6);

	const modules = page.locator('[data-tour="workspace-modules"]');

	await pointAt(page, modules.getByText('Модуль добавляет пространству панели карточки').first());
	await beat(page, 0.8);
	await pointAt(page, modules.getByText('Оплата', { exact: true }).first());
	await beat(page, 0.6);
	await pointAt(page, modules.getByText(/не выбраны в составе карточки процесса/u).first());
	await beat(page, 1.2);
	await pointAt(
		page,
		modules.getByText('Выключить нельзя, пока стадии процесса его требуют.').first()
	);
	await beat(page, 1.4);
	await pointAt(page, page.getByText('Сотрудники', { exact: true }).first());
	await beat(page, 1.2);
}

/** Матрица прав из базы: что может каждая роль. */
async function rolesMatrix(page: Page): Promise<void> {
	await visit(page, '/settings/roles', 'Роли и права');
	await beat(page, 0.8);
	await scroll(page, 520);
	await beat(page, 1.2);
}

/** Карточка коммерческого обучения: свой процесс, стоимость и оплата. */
async function b2cCard(page: Page): Promise<void> {
	await visit(page, '/w/b2c/interactions?view=table', 'Взаимодействия');
	await beat(page, 0.6);
	await press(page, page.getByRole('row').nth(1));
	await page.waitForURL(/\/interactions\/[0-9a-f-]{36}/u, { timeout: WAIT });
	await hydrated(page);
	await page.getByText('Все стадии процесса').first().waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 1);
	await pointAt(page, page.getByText('Стоимость и оплата', { exact: true }).first());
	await beat(page, 1.4);
}

/** Новое взаимодействие вручную: менеджер заводит работу с вузом окном над списком. */
async function createInteraction(page: Page): Promise<void> {
	await visit(page, '/interactions', 'Взаимодействия');
	await press(page, page.getByRole('button', { name: 'Создать взаимодействие' }).first());

	const dialog = page.getByRole('dialog');

	await dialog.waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 0.6);

	const title = dialog.locator('#title');

	await pointAt(page, title);
	await title.pressSequentially(NEW_INTERACTION.title, { delay: 45 });

	const institution = dialog.locator('#institution');

	await press(page, institution);
	await institution.pressSequentially(NEW_INTERACTION.institution, { delay: 90 });

	// Вуз — из справочника: строка выдачи по краткому наименованию.
	const found = dialog
		.locator('li button')
		.filter({ hasText: NEW_INTERACTION.institution })
		.first();

	await found.waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, found);
	await beat(page, 0.6);
	await press(page, found);
	await beat(page, 1);
	await beat(page, 1);
	await press(page, dialog.getByRole('button', { name: 'Создать взаимодействие' }));
	await page.waitForURL(/\/interactions\/[0-9a-f-]{36}/u, { timeout: WAIT });
	await hydrated(page);
	await page.getByText('Все стадии процесса').first().waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 1.6);
}

/**
 * Чат взаимодействия: упоминание руководителя пришло в колокольчик, оттуда — к
 * комментарию, и менеджер отвечает с упоминанием в той же ленте.
 */
async function chat(page: Page, stand: Stand): Promise<void> {
	await visit(page, `/interactions/${stand.interactionId}`, 'Все стадии процесса');
	// Упоминание уже прочитано в открытой карточке — в колокольчике оно
	// остаётся в списке с переходом к взаимодействию.
	await pointAt(page, page.getByRole('button', { name: /^Уведомления/u }).first());
	await openInbox(page);
	await beat(page, 1.2);
	await page.keyboard.press('Escape');
	await beat(page, 0.4);
	await draftMention(page, DEMO_LEAD_NAME, CHAT_REPLY);
	await beat(page, 0.8);
	await sendComment(page, CHAT_REPLY);
	await pointAt(page, page.locator('[data-slot="event-feed"]').getByText(CHAT_REPLY).first());
	await beat(page, 1.4);
}

/** Те же взаимодействия доской по стадиям и таблицей: вид переключается адресом, как ссылкой из меню вида. */
async function boardAndTable(page: Page): Promise<void> {
	await visit(page, '/interactions?view=board', 'Взаимодействия');
	await beat(page, 1.4);
	await visit(page, '/interactions?view=table', 'Взаимодействия');
	await beat(page, 1.4);
}

/** Встроенная справка: разделы обеих ролей и статья со снимками экрана. */
async function helpCenter(page: Page): Promise<void> {
	await visit(page, '/help', 'Справка');
	await beat(page, 1.2);
	await visit(page, '/help/user/interaction', 'Карточка взаимодействия');
	await beat(page, 2.2);
}

/** Данные об обучении: дашборд с происхождением чисел и рейтинг по фактам системы. */
async function learningData(page: Page): Promise<void> {
	await visit(page, '/data/dashboard', 'Данные');
	await beat(page, 1);
	await scroll(page, 480);
	await beat(page, 0.8);

	await visit(page, '/data/ranking', 'Рейтинг программ и направлений');
	await beat(page, 1);
	await scroll(page, 480);
	await beat(page, 1.2);
}

/** Строка имитатора сайта в блоке «Демо: отказ и восстановление обмена». */
function cmsSwitch(page: Page) {
	return page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'Демо: отказ и восстановление обмена' }) })
		.locator('li')
		.filter({ hasText: 'Имитатор CMS' });
}

/**
 * Сбой и восстановление обмена: имитатор сайта недоступен, снимок статуса по
 * новой заявке встаёт в очередь повторов; имитатор вернули — повтор доставляет
 * то же сообщение той же строкой. Затем — «Статус системы».
 */
async function exchangeOutage(page: Page, stand: OverviewStand): Promise<void> {
	await visit(page, '/exchange', 'Внешние системы');

	const cms = cmsSwitch(page);

	await press(page, cms.getByRole('button', { name: 'Сделать недоступным' }));
	stand.cmsDown = true;
	await cms.getByText(/^недоступен/u).waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, cms.getByText(/^недоступен/u));
	await beat(page, 0.8);

	// Заявка сбоя — своя: общий `stand` описывает заявку начала прохода, и её
	// ключи нужны возврату стенда и `timecodes.json`.
	const outage = freshStand();

	await submitApplication(page, outage);
	await visit(page, `/exchange?q=${outage.externalId}`, 'Внешние системы');

	// Снимок статуса уходит фоновым проходом очереди: журнал перечитывается,
	// пока строка не встанет в повтор.
	// Фоновый проход мог ещё не дойти до строки — тогда она «Ждёт отправки»:
	// это та же очередь, и показывать можно её, а не ждать повтора до конца.
	// Плашка состояния, а не текст ячейки: рядом с ней в той же ячейке —
	// причина отказа, и поиск по тексту ячейки её не находил.
	const badge = page.locator('table [data-slot="status-badge"]');
	const retrying = badge.filter({ hasText: 'Повтор назначен' });
	const queued = badge.filter({ hasText: /Повтор назначен|Ждёт отправки/u });

	for (let attempt = 0; attempt < 20 && (await retrying.count()) === 0; attempt += 1) {
		await beat(page, 1);
		await page.reload({ waitUntil: 'load' });
		await hydrated(page);

		if (attempt >= 6 && (await queued.count()) > 0) {
			break;
		}
	}

	if ((await queued.count()) === 0) {
		const table = await page.locator('table').first().innerText();

		throw new Error(`Строка обмена не встала в очередь: ${table.replace(/\s+/gu, ' ')}`);
	}

	await pointAt(page, queued.first());
	await beat(page, 1.4);

	await press(page, cmsSwitch(page).getByRole('button', { name: 'Вернуть сейчас' }));
	await cmsSwitch(page)
		.getByText('доступен', { exact: true })
		.waitFor({ state: 'visible', timeout: WAIT });
	stand.cmsDown = false;
	await beat(page, 0.6);

	// Фоновый повтор мог успеть раньше нажатия — тогда строка уже доставлена,
	// и нажимать нечего: итог тот же, попыток у строки больше одной.
	const retry = page.locator('table').getByRole('button', { name: 'Повторить' });

	if ((await retry.count()) > 0) {
		await press(page, retry.first());
	}

	const delivered = page.locator('table').getByText('Отправлено').first();

	// Строка «Ждёт отправки» уходит фоновым проходом, а не кнопкой: ждать его
	// дольше обычного ожидания экрана.
	for (let attempt = 0; attempt < 30 && (await delivered.count()) === 0; attempt += 1) {
		await beat(page, 1);
		await page.reload({ waitUntil: 'load' });
		await hydrated(page);
	}

	await delivered.waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, delivered);
	await beat(page, 1.4);

	await visit(page, '/settings/health', 'Статус системы');
	await beat(page, 0.6);
	await press(page, page.getByRole('button', { name: 'Проверить заново' }));
	await beat(page, 1);
	await scroll(page, 420);
	await beat(page, 1.2);
}

const SCENES: readonly Scene<OverviewStand>[] = [
	{
		name: 'title',
		role: 'manager',
		caption: 'Титульная карточка',
		narration: [
			'Альма CRM — система, в которой ИТ Школа Ростелекома ведёт работу с вузами.',
			'Около двадцати менеджеров ведут вузы по одному процессу из четырнадцати шагов: от первого контакта через договор и внедрение до обучения и дальнейшего сопровождения.',
			'Альма делает эту работу проще и быстрее: единый стандарт процесса, автоматизация на каждом этапе и отчёты, где каждое число можно проверить.',
			'Решение команды Wine Coding Team.'
		],
		play: async (page) => {
			await showCard(page, TITLE_CARD);
			await beat(page, 3);
		}
	},
	chapter(1, 'Работа менеджера', [
		'Часть первая. Работа менеджера: каждый день по одному стандарту.'
	]),
	{
		name: 'my-day',
		role: 'manager',
		caption: 'Вход одной кнопкой и сводка менеджера «Мой день»',
		signsIn: true,
		narration: [
			'Менеджер входит через единый каталог учётных записей — на демо-стенде одной кнопкой.',
			'День начинается со сводки «Мой день»: просрочки, сроки на сегодня и завтра, помехи и новые заявки.',
			'Каждый раздел ведёт ровно к этим взаимодействиям, а утром та же сводка приходит письмом.'
		],
		play: async (page) => {
			await signIn(page, 'manager', true);
			await myDay(page);
		}
	},
	{
		name: 'create',
		role: 'manager',
		caption: 'Новое взаимодействие вручную',
		narration: [
			'Работу с вузом начинает менеджер: он находит вуз и заводит взаимодействие.',
			'Вуз выбирается из справочника, а если его там нет — находится в ЕГРЮЛ и добавляется одним нажатием, с реквизитами из реестра.',
			'Достаточно названия и учебного заведения — остальное дополняется в карточке по ходу процесса.',
			'Взаимодействие встаёт на первую стадию — поиск контактных лиц.'
		],
		play: createInteraction
	},
	{
		name: 'intake',
		role: 'admin',
		caption: 'Заявка с сайта: триггер имитатора, взаимодействие, статус обратно на сайт',
		narration: [
			'Второй вход — заявка с сайта школы: она становится взаимодействием сама.',
			'Обмен с сайтом и системой обучения показываем на имитаторах по опубликованному контракту Альмы; для систем заказчика понадобится адаптация.',
			'Журнал обмена показывает, что пришло с сайта и какой статус ушёл обратно.',
			'Во взаимодействии уже есть вуз — Политех, контактное лицо и ответственный менеджер.',
			'А заявитель на сайте видит статус без внутренних комментариев сотрудников.'
		],
		play: async (page, stand) => {
			await visit(page, '/exchange', 'Внешние системы');
			await submitApplication(page, stand);
			await showApplicationLog(page, stand);
			await openApplication(page, stand);
			await showSiteSide(page, stand);
		}
	},
	{
		name: 'work',
		role: 'manager',
		caption:
			'Колокольчик нового взаимодействия, карточка: условия перехода, переход с файлом, живой комментарий',
		narration: [
			'Ответственный узнаёт о новом взаимодействии по колокольчику и письму.',
			'Карточка — досье взаимодействия: кто сейчас в работе, ключевые факты, статус на сайте, ниже история, документы и события.',
			'У каждой стадии свой чек-лист, и шаг вперёд закрыт, пока условия не выполнены, — под кнопкой написано, чего не хватает.',
			'Одно условие закрывают данные взаимодействия, другое менеджер отмечает сам.',
			'Переход просит итог стадии: комментарий и файл остаются в истории.',
			'Руководитель в той же карточке — его комментарий с упоминанием менеджера приходит без перезагрузки.'
		],
		play: async (page, stand, crew) => {
			await workTheCard(page, stand, crew, { viaInbox: true });
		}
	},
	{
		name: 'chat',
		role: 'manager',
		caption: 'Чат взаимодействия: упоминание в колокольчике и ответ с упоминанием',
		narration: [
			'Лента карточки — это и чат взаимодействия.',
			'Упоминание приходит в колокольчик, оттуда — прямо к взаимодействию.',
			'Менеджер отвечает и сам упоминает руководителя: позвать можно только тех, кто видит взаимодействие.'
		],
		play: chat
	},
	{
		// Сразу после работы в карточке: после передачи вуза у менеджера этой
		// заявки в области уже нет.
		name: 'stale-edit',
		role: 'manager',
		caption: 'Защита от перетирания: сохранение поверх чужой правки получает отказ',
		narration: [
			'Работать вдвоём безопасно: если коллега сохранил раньше, система называет, кто и когда изменил запись, а введённый текст не пропадает.'
		],
		play: async (page, stand, crew) => {
			const address = `/interactions/${stand.interactionId}`;
			const [lead] = await Promise.all([crew.join('lead', address), openStandCard(page, stand)]);

			await staleEdit(page, stand, lead);
		}
	},
	{
		name: 'board',
		role: 'manager',
		caption: 'Список взаимодействий доской по стадиям и таблицей',
		narration: [
			'Все взаимодействия — привычной доской по стадиям или таблицей, как в других CRM, с фильтрами в одну строку.'
		],
		play: boardAndTable
	},
	slide('design', 'design', 'Слайд: удобство и дизайн-система Ростелекома', [
		'Интерфейс собран на дизайн-системе Ростелекома «Атомаро»: фирменные цвета, шрифт Rostelecom Basis, светлая и тёмная темы с проверкой контраста.',
		'Он работает и на телефоне, и на десктопе.',
		'При первом входе тур показывает каждый экран, подробная справка открывается из любого места, а под запертой кнопкой всегда написано, чего не хватает.',
		'Заказчик назвал главным для интерфейса удобство и гибкость: удобство — здесь, гибкость — в третьей части.'
	]),
	chapter(2, 'Автоматизация на каждом этапе', [
		'Часть вторая. Автоматизация на каждом этапе — вплоть до пунктов чек-листа.'
	]),
	{
		name: 'organization',
		role: 'manager',
		caption: 'Карточка вуза: «Сведения» с сайта, подбор программ, договоры и лицензии, ЕГРЮЛ',
		narration: [
			'На примере другого вуза, СПбПУ, — подготовка к работе.',
			'Карточка читает раздел «Сведения» на сайте вуза с источником и датой и предлагает руководителей подразделений в контакты одним нажатием.',
			'Программы школы подобраны по кодам направлений, у каждой написано, почему она подходит.',
			'Истекающая лицензия видна сразу, продление запускается отсюда.',
			'Реквизиты сверяются с ЕГРЮЛ и попадают в карточку только после подтверждения человеком.',
			'Внешние источники подключаются отдельно и могут быть выключены.'
		],
		play: partnerCard
	},
	slide('import', 'import', 'Слайд: импорт таблиц и справочники', [
		'Начать можно с существующей таблицы: колонки сопоставляются в мастере, строки проверяются до загрузки, повтор не создаёт дублей.'
	]),
	{
		name: 'meeting',
		role: 'manager',
		caption: 'Приглашение на встречу: событие календаря с повесткой',
		narration: [
			'Взаимодействие на стадии встречи с вузом.',
			'Менеджер назначает встречу: контакты вуза и коллеги получают приглашение с повесткой из чек-листа.',
			'Перенос обновляет событие в календаре, отмена — убирает; без почты приглашение можно скачать файлом.'
		],
		play: (page, _stand, crew) => meetingInvite(page, crew)
	},
	{
		name: 'documents',
		role: 'manager',
		caption: 'Пакет документов, скан новой редакцией с отметкой «Утверждён»',
		narration: [
			'Пакет документов собирается по шаблонам из данных взаимодействия, в Word и PDF.',
			'Скан подписанного экземпляра загружается новой редакцией документа, собранного по шаблону, с отметкой «Утверждён» — она выполняет условие перехода на стадии подписания.',
			'Повторная сборка подписанное без явного согласия не трогает.'
		],
		play: (page, _stand, crew) => documents(page, crew)
	},
	{
		name: 'lms',
		role: 'lead',
		caption: 'Система обучения: поток, результат, подтверждение стадии, список слушателей',
		narration: [
			'Ещё одно взаимодействие — на стадии «Ведение занятий».',
			'Поток отправляют в систему обучения кнопкой из карточки.',
			'На стенде систему обучения изображает имитатор: группа в нём уже заведена, и он отправляет итог потока.',
			'В карточке появляются числа — сколько зачислено, завершили и отчислены, — и эта запись подтверждает стадию вместо слов сотрудника.',
			'Список слушателей загружается файлом, проверяется построчно и уходит в систему обучения.',
			'Обучение — один из этапов: дальше процесс ведёт актуализацию материалов, повышение квалификации преподавателей и контроль исполнения.'
		],
		play: async (page, _stand, crew) => {
			const group = await runLearningGroup(page);

			await roster(page, group, crew);
		}
	},
	slide('automation', 'steps', 'Слайд: четырнадцать шагов и автоматизации', [
		'На всех четырнадцати шагах система либо делает работу сама, либо помогает сотруднику, либо контролирует результат: тридцать четыре пункта автоматизации.'
	]),
	chapter(3, 'Универсальный движок', [
		'Часть третья. Универсальный движок: процессы и направления — без программиста.'
	]),
	{
		name: 'process',
		role: 'admin',
		caption: 'Редактор процесса: удаление стадии с переносом, предпросмотр, переименование',
		narration: [
			'Процесс — настройка, а не код.',
			'В черновике администратор удаляет стадию и выбирает, куда перейдут её взаимодействия; предпросмотр заранее называет, сколько взаимодействий переедет.',
			'Этот черновик отменяем и применяем переименование стадии.',
			'Все незавершённые взаимодействия продолжают работу — заявка Политеха уже под новым названием.'
		],
		play: async (page, stand) => {
			await removalPreview(page);
			await renameLiveStage(page, stand);
		}
	},
	{
		name: 'flexibility',
		role: 'admin',
		caption: 'Новое направление без кода: процесс с нуля или копией, модули пространства',
		narration: [
			'Новое направление заводится так же: процесс с нуля или копией действующего, своё пространство с сотрудниками и модулями карточки — договоры, оплата, обучение, встречи.',
			'Модуль, нужный стадиям процесса, выключить нельзя.'
		],
		play: flexibility
	},
	{
		name: 'b2c',
		role: 'admin',
		caption: 'Карточка коммерческого обучения',
		narration: [
			'Так в той же системе живёт коммерческое обучение: свой процесс, стоимость, оплата и слушатели.'
		],
		play: b2cCard
	},
	chapter(4, 'Роли и доступ', ['Часть четвёртая. Роли и доступ.']),
	{
		name: 'handover',
		role: 'lead',
		caption: 'Вход через каталог и передача вуза другому менеджеру',
		signsIn: true,
		narration: [
			'Руководитель входит тем же каталогом учётных записей: роль приходит вместе со входом.',
			'Руководитель передаёт вуз другому менеджеру вместе с незакрытыми взаимодействиями.'
		],
		play: handOver
	},
	{
		name: 'handover-gone',
		role: 'manager',
		caption: 'У прежнего ответственного записей по вузу больше нет',
		narration: [
			'Прежний менеджер больше не видит взаимодействия этого вуза: доступ следует за назначением сразу.'
		],
		play: showHandedOver
	},
	{
		name: 'roles',
		role: 'admin',
		caption: 'Матрица прав',
		narration: [
			'Что может каждая роль, видно в матрице прав, — по тем же правилам сервер проверяет каждый запрос.'
		],
		play: rolesMatrix
	},
	chapter(5, 'Отчёты', ['Часть пятая. Отчёты, где каждое число можно проверить.']),
	{
		// Руководитель, а не менеджер: соглашение МТУСИ, до которого раскрывается
		// число, после передачи вуза в области менеджера больше не лежит, а
		// руководитель видит работу всех своих подчинённых.
		name: 'reports',
		role: 'lead',
		caption:
			'Отчёт: общий реестр, воронки по процессам, от числа к взаимодействию, срез и движение, выгрузки',
		narration: [
			'Отчёт руководителя — реестр всех взаимодействий его области с фильтрами по пространству, вузу, программе, продукту и ответственному.',
			'Воронка своя у каждого процесса.',
			'Клик по столбцу сужает отчёт до взаимодействий стадии, а во взаимодействии видно, чем стадия подтверждена, — здесь утверждённым документом.',
			'Срез показывает, где работа стоит на дату, движение — переходы за период.',
			'Excel и PDF собираются из выборки на экране, и числа совпадают.'
		],
		play: async (page, _stand, crew) => {
			await reportFunnels(page);
			await traceNumber(page);
			await reportAndExport(page, crew, { xlsx: true });
		}
	},
	{
		name: 'data',
		role: 'manager',
		caption: 'Данные об обучении: дашборд и рейтинг программ',
		narration: [
			'Данные об обучении — с происхождением каждого числа, а рейтинг программ считается по фактам самой системы.'
		],
		play: learningData
	},
	chapter(6, 'Надёжность и технологии', ['Часть шестая. Надёжность и технологии.']),
	{
		name: 'exchange',
		role: 'admin',
		caption: 'Сбой и восстановление обмена, статус системы',
		narration: [
			'Сбой обмена показываем вживую: имитатор сайта недоступен, статус по новой заявке встаёт в очередь повтора.',
			'Сайт вернулся — повтор доставляет то же сообщение, без потерь и дублей.',
			'«Статус системы» показывает, что работает прямо сейчас.'
		],
		play: exchangeOutage
	},
	slide('security', 'security', 'Слайд: доступ, безопасность, персональные данные', [
		'Телефон и почта зашифрованы в базе и маскируются по правам; для персональных данных есть основание обработки, срок хранения и обезличивание.',
		'Журнал действий защищён от изменения.',
		'Система рассчитана на закрытый контур: связи только с сайтом и системой обучения, внешние источники отключаемы.'
	]),
	slide('stack', 'stack', 'Слайд: почему SvelteKit', [
		'Интерфейс — на Svelte 5 и SvelteKit вместо React.',
		'Svelte — компилятор: в браузер не едут виртуальный DOM и рантайм библиотеки, поэтому бандл меньше и страница оживает быстрее.',
		'Реактивность обновляет только изменившийся элемент, без перерисовки дерева компонентов, — доска на сотни взаимодействий и живая карточка не тормозят.',
		'Страница приходит с сервера сразу с данными, а кода меньше, чем на React, — поддержка дешевле.'
	]),
	slide('architecture', 'architecture', 'Слайд: архитектура и модули', [
		'Архитектура — модульный монолит: ядро и подключаемые модули пространств, PostgreSQL, Redis, файловое хранилище и Keycloak.',
		'Поставка — Docker Compose, сорок три операции API описаны по OpenAPI.'
	]),
	slide('performance', 'performance', 'Слайд: нагрузка', [
		'Нагрузку проверяли на двух компьютерах и на VPS-стенде.',
		'При пятидесяти одновременных пользователях девяносто пять процентов запросов укладываются в две десятых секунды, и ни один из восьми с половиной тысяч не превысил секунду.',
		'Десять отчётов одновременно: экран — две десятых секунды, Excel — четыре десятых.',
		'Система масштабируется и вертикально, и горизонтально: по расчёту, сотне пользователей хватит сервера на девять ядер и двенадцать гигабайт памяти.'
	]),
	{
		name: 'help',
		role: 'manager',
		caption: 'Встроенная справка: руководства пользователя и администратора',
		narration: [
			'Руководства пользователя и администратора встроены в систему: двадцать четыре статьи, в двадцати — снимки экрана.',
			'Вместе с туром по экранам это позволяет начать работу без отдельного обучения.'
		],
		play: helpCenter
	},
	{
		name: 'final',
		role: 'manager',
		caption: 'Финальная карточка',
		narration: ['Стенд, документация и код — по ссылкам на экране. Спасибо за внимание!'],
		play: async (page) => {
			await showCard(page, FINAL_CARD);
			await beat(page, 3);
		}
	}
];

/**
 * Вернуть стенд: сначала имитатор сайта, если сцена сбоя оборвалась, пока он
 * был недоступен, затем название заявки — его вернуть может руководитель при
 * любом ответственном, — затем общее для проходов (`restorePass`).
 */
async function restore(browser: Browser, stand: OverviewStand, storage: Sessions): Promise<void> {
	if (stand.cmsDown) {
		await withRole(browser, storage, 'admin', async (page) => {
			await page.goto(`${BASE_URL}/exchange`, { waitUntil: 'load' });
			await hydrated(page);
			await cmsSwitch(page).getByRole('button', { name: 'Вернуть сейчас' }).click();
			await cmsSwitch(page)
				.getByText('доступен', { exact: true })
				.waitFor({ state: 'visible', timeout: WAIT });

			console.log('имитатор сайта возвращён');
		});
	}

	const title = stand.retitled;

	if (title !== null) {
		await withRole(browser, storage, 'lead', async (page) => {
			await page.goto(`${BASE_URL}/interactions/${stand.interactionId}`, { waitUntil: 'load' });
			await hydrated(page);

			const current = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();

			if (current !== title) {
				await retitle(page, title, 'Возврат стенда к исходному состоянию после записи обзора.');
			}

			console.log(`название заявки возвращено: ${title}`);
		});
	}

	await restorePass(browser, stand, storage);
}

/** Текст закадра для диктора: реплики по сценам с таймкодами готового ролика. */
function voiceover(marks: readonly Mark<OverviewStand>[], total: number): string {
	const scenes = marks.map((mark) =>
		[
			`### ${timecode(mark.start)}–${timecode(mark.start + mark.seconds)} · ${mark.scene.caption}`,
			'',
			...mark.scene.narration
		].join('\n')
	);

	return [
		'# Текст закадра к полному обзору',
		'',
		`Запись: \`${FILE}\`, **${timecode(total)}**. Таймкоды и реплики — \`timecodes.json\`, субтитры — \`subtitles.srt\`, ключевые кадры — \`frames/\`.`,
		'',
		'Темп — спокойный, около 140 слов в минуту: длина каждой сцены рассчитана по её реплике, и диктор, читающий быстрее, получит паузу в конце сцены.',
		'',
		'## Реплики по сценам',
		'',
		scenes.join('\n\n'),
		''
	].join('\n');
}

const flags = process.argv.slice(2);

if (!flags.includes('--list') && !flags.includes('--narration')) {
	const missing = SLIDE_FILES.filter((file) => !existsSync(path.join(SLIDES, `${file}.png`)));

	if (SLIDES === '' || missing.length > 0) {
		throw new Error(
			`Нет слайдов в OVERVIEW_SLIDES («${SLIDES}»): ${missing.map((file) => `${file}.png`).join(', ')}`
		);
	}
}

const stand: OverviewStand = { ...freshStand(), retitled: null, cmsDown: false };
const marks = await film({
	scenes: SCENES,
	stand,
	output: OUTPUT,
	file: FILE,
	summary: standSummary,
	restore
});

if (marks !== null) {
	const last = marks.at(-1);
	const total = last === undefined ? 0 : last.start + last.seconds;

	await writeFile(path.join(OUTPUT, 'voiceover.md'), voiceover(marks, total), 'utf8');
}
