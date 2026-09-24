/**
 * Полный видеообзор стенда для экспертов: шесть–восемь минут по разделам
 * README подряд — от сводки менеджера до программного интерфейса.
 *
 * Скринкаст показа (`screencast.ts`) рассказывает одну историю за три минуты и
 * поэтому оставляет за кадром половину продукта: карточку вуза с паспортом из
 * официальных источников, пакет документов и отметку подписанного экземпляра,
 * список слушателей потока, удаление стадии с переносом записей, пространства,
 * данные об обучении, карту автоматизации, повтор обмена без дубля и
 * самодиагностику. Обзор идёт тем же проходом и теми же действиями
 * (`acts.ts`), но между ними показывает всё это — тоже вживую и тоже честно:
 * ничего не подделывается, внешние стороны отвечают со своих страниц.
 *
 * Механика — та же (`film.ts`): своя роль и свой контекст на сцену, курсор в
 * кадре, реплика закадра задаёт минимальную длину сцены. Сверх ролика, кадров,
 * `timecodes.json` и `subtitles.srt` обзор пишет `voiceover.md` — текст закадра
 * по сценам с таймкодами, готовый для диктора.
 *
 * Стенд общий. Всё, что обзор меняет обратимо, — стадию и название заявки,
 * ответственного за вуз, название стадии процесса — он возвращает сам, тем же
 * интерфейсом; что остаётся до ночного сброса — `docs/readme-media.md`.
 *
 * ```
 * export MEDIA_BASE_URL=https://crm.volkv.com
 * export SEED_DEMO_PASSWORD=…          # пароль демонстрационных записей каталога
 * export OVERVIEW_DIR=…                # каталог вне репозитория, куда лечь ролику
 * node scripts/readme-media/overview.ts
 * node scripts/readme-media/overview.ts --list
 * ```
 */
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
	drawScan,
	film,
	hydrated,
	pointAt,
	press,
	scroll,
	showCard,
	timecode,
	visit,
	withRole,
	type Crew,
	type Mark,
	type Scene,
	type Sessions
} from './film.ts';

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
 * после записи.
 */
type OverviewStand = Stand & { retitled: string | null };

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
	invitees: ['Кузьмина Наталья', 'Щербак Антон Валентинович'],
	location: 'МТУСИ, Авиамоторная ул., 8а, ауд. 214',
	/** Дата и время встречи — значение поля `datetime-local`. */
	start: '2026-10-06T11:00'
} as const;

/** Подписанный экземпляр, который менеджер загружает в дело. */
const SIGNED_COPY = {
	title: 'Соглашение о сотрудничестве — подписанный экземпляр',
	kind: 'Соглашение',
	note: 'подписано обеими сторонами'
} as const;

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
	<h1>Система контроля взаимодействия с учебными заведениями</h1>
	<p class="lead">Полный обзор стенда: от сводки менеджера до программного интерфейса</p>
	<p class="foot">Wine Coding Team</p>
`;

const FINAL_CARD = `
	<div class="rule"></div>
	<h1>Стенд открыт</h1>
	<ul>
		<li><b class="accent">crm.volkv.com</b> — три роли: менеджер, руководитель, администратор; пароль — на странице входа</li>
		<li><b class="accent">/help</b> — руководства внутри системы, <b class="accent">/api/docs</b> — описание программного интерфейса</li>
		<li><b class="accent">github.com/volkv/lct-2026</b> — исходный код и документация</li>
	</ul>
	<p class="foot">Wine Coding Team</p>
`;

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
 * Сводка «Мой день»: что требует внимания сегодня, по разделам, с подсказкой
 * следующего шага у каждой строки.
 */
async function myDay(page: Page): Promise<void> {
	await visit(page, '/', 'Мой день');
	await pointAt(page, page.getByText('Мой день', { exact: true }).first());
	await beat(page, 0.8);
	await pointAt(page, page.getByText('Просрочены стадии').first());
	await beat(page, 0.6);
	await pointAt(page, page.getByText(/^→ /u).first());
	await beat(page, 1);
	await scroll(page, 420);
	await pointAt(page, page.getByText('Стоят помехи').first());
	await beat(page, 1);
	await scroll(page, 520);
	await beat(page, 1.2);
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
	await pointAt(page, page.getByText(/^Источник: https?:\/\//u).first());
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
	await press(page, page.getByRole('button', { name: 'Найти в ЕГРЮЛ' }));
	await page
		.getByRole('button', { name: /Перенести отмеченное в форму/u })
		.waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, page.getByText('Из источника', { exact: true }).first());
	await beat(page, 0.6);
	await pointAt(page, page.getByText('ЕГРЮЛ (Dadata)').nth(2));
	await beat(page, 1.6);
}

/**
 * Документы дела: пакет по шаблону, подписанный экземпляр с отметкой
 * «Утверждён» и приглашение на встречу файлом календаря.
 */
async function documents(page: Page, crew: Crew): Promise<void> {
	await openInteraction(page, MEETING.query, MEETING.expected);
	await beat(page, 0.8);

	await press(page, page.getByRole('button', { name: 'Собрать пакет документов' }));

	const pack = page.getByRole('dialog');

	await pack.waitFor({ state: 'visible', timeout: WAIT });
	await pack.locator('#card-package-city').fill('Москва');
	await pack.locator('#card-package-operator-signer').fill('директора Орлова К. В.');
	await pack.locator('#card-package-counterparty-signer').fill('ректора Ерохина С. Д.');
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
	await upload.locator('#card-document-title').fill(SIGNED_COPY.title);
	await press(page, upload.locator('#card-document-kind'));
	await press(page, page.getByRole('option', { name: SIGNED_COPY.kind, exact: true }));
	await upload.locator('#card-document-file').setInputFiles(scan);
	await beat(page, 0.6);
	await press(page, upload.getByRole('button', { name: 'Загрузить', exact: true }));
	await upload.waitFor({ state: 'hidden', timeout: WAIT });
	await beat(page, 0.6);

	await press(
		page,
		page.getByRole('button', { name: `Действия с «${SIGNED_COPY.title}»` }).first()
	);
	await press(page, page.getByRole('menuitem', { name: 'Поставить отметку' }));

	const mark = page.getByRole('dialog');

	await mark.waitFor({ state: 'visible', timeout: WAIT });
	await press(page, mark.locator('#card-mark-fact'));
	await press(page, page.getByRole('option', { name: 'Утверждён', exact: true }));
	await mark.locator('#card-mark-note').fill(SIGNED_COPY.note);
	await beat(page, 1.2);
	await press(page, mark.getByRole('button', { name: 'Поставить отметку' }));
	await mark.waitFor({ state: 'hidden', timeout: WAIT });
	await beat(page, 0.8);

	await page.getByRole('button', { name: 'Ещё', exact: true }).click();
	await press(page, page.getByRole('menuitem', { name: 'Пригласить на встречу' }));

	const meeting = page.getByRole('dialog');

	await meeting.waitFor({ state: 'visible', timeout: WAIT });
	await meeting.locator('#card-meeting-start').fill(MEETING.start);
	await meeting.locator('#card-meeting-location').fill(MEETING.location);

	for (const person of MEETING.invitees) {
		await press(page, meeting.getByRole('checkbox', { name: new RegExp(person, 'u') }));
	}

	await beat(page, 0.8);

	const download = page.waitForEvent('download', { timeout: WAIT });

	await press(page, meeting.getByText('Скачать приглашение (.ics)'));

	// Приглашение открывается как текст: браузер показывает календарный файл
	// только скачиванием, а в ролике важно, что внутри — дата, место,
	// участники и повестка.
	const invite = path.join(crew.work, 'invite.txt');

	await (await download).saveAs(invite);
	await page.goto(`file://${invite}`, { waitUntil: 'load' });
	await beat(page, 2);
}

/** Поимённый список к только что заведённому потоку: проверка файла, загрузка, передача. */
async function roster(page: Page, group: string, crew: Crew): Promise<void> {
	const file = path.join(crew.work, 'slushateli.csv');

	await writeFile(file, `${ROSTER}\n`, 'utf8');

	const item = page.locator('li').filter({ hasText: group });

	await press(page, item.getByRole('button', { name: 'Слушатели…' }).first());

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
		.getByText('Черновик изменений — копия действующего процесса.')
		.first()
		.waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 0.6);

	const row = page.getByRole('row').filter({ hasText: REMOVED_STAGE.key });

	await press(page, row.getByRole('button', { name: 'Удалить' }));

	const remove = page.getByRole('dialog');

	await remove.waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, remove.getByText('Сейчас на этой стадии стоит').first());
	await beat(page, 1.2);
	await pointAt(page, remove.getByText('Куда перенести записи').first());
	await beat(page, 0.6);
	await press(page, remove.getByRole('button', { name: 'Удалить стадию' }));
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

/** Роли и пространства: матрица прав из базы, состав пространств и карточка B2C. */
async function rolesAndSpaces(page: Page): Promise<void> {
	await visit(page, '/settings/roles', 'Роли и права');
	await beat(page, 0.8);
	await scroll(page, 520);
	await beat(page, 1.2);

	await visit(page, '/settings/workspaces', 'Пространства');
	await pointAt(
		page,
		page.locator('main').getByText('Коммерческое обучение', { exact: true }).first()
	);
	await beat(page, 0.8);
	await scroll(page, 480);
	await beat(page, 1);

	await visit(page, '/w/b2c/interactions', 'Взаимодействия');
	await beat(page, 0.6);
	await press(page, page.getByRole('row').nth(1));
	await page.waitForURL(/\/interactions\/[0-9a-f-]{36}/u, { timeout: WAIT });
	await hydrated(page);
	await page.getByText('Все стадии процесса').first().waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 1);
	await scroll(page, 520);
	await beat(page, 1.4);
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

/**
 * Повторная подача той же заявки: второе событие в журнале, взаимодействие —
 * то же. Затем самодиагностика связей.
 */
async function exchangeTwice(page: Page, stand: Stand): Promise<void> {
	await visit(page, '/exchange', 'Внешние системы');

	const first = stand.externalId;

	await submitApplication(page, stand);

	if (stand.externalId !== first) {
		throw new Error(
			`Повторная подача пришла с другим ключом (${stand.externalId}, а было ${first}): показывать нечего`
		);
	}

	await visit(page, `/exchange?q=${stand.externalId}`, 'Внешние системы');

	const submitted = page.locator('table').getByText('application.submitted');

	await submitted.nth(1).waitFor({ state: 'visible', timeout: WAIT });
	await pointAt(page, submitted.first());
	await beat(page, 0.6);
	await pointAt(page, submitted.nth(1));
	await beat(page, 1);

	await visit(page, '/settings/diagnostics', 'Связи и зависимости');
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
			'Система контроля взаимодействия с учебными заведениями — полный обзор стенда.',
			'Решение команды Wine Coding Team.'
		],
		play: async (page) => {
			await showCard(page, TITLE_CARD);
			await beat(page, 3);
		}
	},
	{
		name: 'my-day',
		role: 'manager',
		caption: 'Сводка менеджера «Мой день»',
		narration: [
			'День менеджера начинается со сводки «Мой день».',
			'В ней только то, что требует внимания сегодня: просроченные стадии, сроки на сегодня и завтра, помехи, ожидание контрагента, новые заявки и лицензии к продлению.',
			'У каждой строки сказано, что сделать дальше.',
			'Тот же список каждое утро приходит сотруднику письмом.'
		],
		play: myDay
	},
	{
		name: 'intake',
		role: 'admin',
		caption: 'Заявка с сайта: триггер имитатора, взаимодействие, статус обратно на сайт',
		narration: [
			'Заявка с сайта приходит по объявленному контракту обмена.',
			'Кнопка стенда жмёт тот же триггер имитатора сайта, что и посетитель, отправивший форму.',
			'Журнал обмена показывает обе стороны: что пришло, что ушло и чем ответил получатель.',
			'Заявка сразу стала взаимодействием — с учебным заведением, контактным лицом и ответственным.',
			'А на сайт вернулся снимок статуса: заявитель видит, что происходит с его обращением.'
		],
		play: async (page, stand) => {
			await visit(page, '/exchange', 'Внешние системы');
			await submitApplication(page, stand);
			await showApplicationLog(page, stand);
			await openApplication(page, stand);
			await showSiteSide(page);
		}
	},
	{
		name: 'work',
		role: 'manager',
		caption: 'Карточка: кто в деле, закрытый шаг с причинами, переход с файлом, живой комментарий',
		narration: [
			'Карточка читается сверху вниз: кто сейчас в деле, факты, полоса из четырнадцати стадий и одно главное действие.',
			'Шаг вперёд закрыт, и под кнопкой сказано почему: не отмечены обязательные пункты стадии.',
			'Менеджер отмечает их прямо здесь — и переход открывается.',
			'Переход просит итог стадии: комментарий и файл остаются в истории, на той стадии, где их приложили.',
			'Руководитель открыл ту же карточку, и его комментарий с упоминанием приходит без перезагрузки.'
		],
		play: async (page, stand, crew) => {
			await workTheCard(page, stand, crew);
		}
	},
	{
		name: 'stale-edit',
		role: 'manager',
		caption: 'Защита от перетирания: сохранение поверх чужой правки получает отказ',
		narration: [
			'Правка поверх чужой не пропадает молча.',
			'Пока менеджер правит план, руководитель успел сохранить своё.',
			'Сохранение отказывает и называет, кто и когда изменил запись, а введённый текст остаётся в форме.'
		],
		play: async (page, stand, crew) => {
			const address = `/interactions/${stand.interactionId}`;
			const [lead] = await Promise.all([crew.join('lead', address), openStandCard(page, stand)]);

			await staleEdit(page, stand, lead);
		}
	},
	{
		name: 'organization',
		role: 'manager',
		caption: 'Карточка вуза: «Сведения» с сайта, подбор программ, договоры и лицензии, ЕГРЮЛ',
		narration: [
			'Карточка вуза собирает всё о партнёре.',
			'Раздел «Сведения» на сайте вуза прочитан с источником и датой, и руководитель подразделения становится контактом одним нажатием.',
			'Программы школы подобраны по кодам направлений ФГОС, и у каждой написано, почему она подходит.',
			'Ниже — договоры и лицензии: истекающая видна сразу, и продление запускается отсюда.',
			'Реквизиты сверяются с ЕГРЮЛ: каждое значение стоит рядом с текущим, с источником и моментом запроса, и ничего не записывается без подтверждения.'
		],
		play: partnerCard
	},
	{
		name: 'documents',
		role: 'manager',
		caption: 'Пакет документов, подписанный экземпляр с отметкой «Утверждён», приглашение .ics',
		narration: [
			'Пакет документов собирается по шаблонам из данных карточек, в DOCX и PDF.',
			'Чего не хватает, система называет у каждого документа: здесь для сублицензии не выбран договор.',
			'Подписанный экземпляр загружается в дело, и отметка «Утверждён» становится фактом — именно ею подтверждается стадия подписания.',
			'Со стадии встречи карточка приглашает контакты вуза файлом календаря, с повесткой по чек-листу стадии.'
		],
		play: (page, _stand, crew) => documents(page, crew)
	},
	{
		name: 'lms',
		role: 'lead',
		caption: 'Система обучения: поток, результат, подтверждение стадии, список слушателей',
		narration: [
			'Стадию «Ведение занятий» подтверждает не сотрудник, а система обучения.',
			'Поток заявляют кнопкой с карточки: группа в чужой системе появляется решением человека, а не побочным эффектом.',
			'Результат присылает сама система обучения — зачислено, завершили, отчислены, — и этой записью стадия подтверждена.',
			'К потоку загружается поимённый список: файл проверяется построчно, люди узнаются по почте, и список уходит в систему обучения отдельной кнопкой.'
		],
		play: async (page, _stand, crew) => {
			const group = await runLearningGroup(page);

			await roster(page, group, crew);
		}
	},
	{
		name: 'process',
		role: 'admin',
		caption: 'Редактор процесса: удаление стадии с переносом, предпросмотр, публикация',
		narration: [
			'Процесс — настройка, а не код.',
			'В черновике администратор удаляет стадию и выбирает, куда переедут записи, которые на ней стоят.',
			'До применения предпросмотр называет числа: сколько записей переедет и на какую стадию.',
			'Стенд общий, поэтому этот черновик отменяем и применяем другое изменение — переименование стадии.',
			'Применили ко всем — и работа продолжается там же, где стояла, уже под новым названием.'
		],
		play: async (page, stand) => {
			await removalPreview(page);
			await renameLiveStage(page, stand);
		}
	},
	{
		name: 'handover',
		role: 'lead',
		caption: 'Вход через каталог и передача вуза другому менеджеру',
		signsIn: true,
		narration: [
			'Вход идёт через общий каталог учётных записей: своих паролей в системе нет, роль приходит вместе со входом.',
			'Руководитель ведёт свою область и видит работу подчинённых.',
			'Он передаёт вуз другому менеджеру — вместе с вузом уходят незакрытые взаимодействия и право их видеть.'
		],
		play: handOver
	},
	{
		name: 'handover-gone',
		role: 'manager',
		caption: 'У прежнего ответственного записей по вузу больше нет',
		narration: [
			'У прежнего ответственного записей по этому вузу больше нет: доступ меняется в ту же секунду и во всех каналах сразу.'
		],
		play: showHandedOver
	},
	{
		name: 'roles',
		role: 'admin',
		caption: 'Матрица прав, пространства и карточка коммерческого обучения',
		narration: [
			'Что может каждая роль, матрица читает прямо из базы — так же, как сервер проверяет каждый запрос.',
			'Работа разделена на пространства: «Работа с ВУЗ» и «Коммерческое обучение», у каждого свой процесс и свой состав сотрудников.',
			'Карточку коммерческого обучения собирает её процесс: пять стадий, оплата, слушатели и документ об обучении.'
		],
		play: rolesAndSpaces
	},
	{
		name: 'reports',
		// Руководитель, а не менеджер: соглашение МТУСИ, до которого раскрывается
		// число, после передачи вуза в области менеджера больше не лежит, а
		// руководитель видит работу всех своих подчинённых.
		role: 'lead',
		caption: 'Отчёт: от числа к делу и подтверждению, срез и движение, выгрузки',
		narration: [
			'Любое число отчёта раскрывается до факта: клик по столбцу воронки сужает тот же отчёт до строк, из которых оно собрано, а строка ведёт в карточку — к подтверждению стадии.',
			'Отчёт отвечает на два вопроса и не смешивает их: срез — где работа стоит на дату, движение — что случилось за период.',
			'Фильтры и колонки живут в адресной строке, и отчёт отправляют ссылкой.',
			'Выгрузка — та же ссылка с другим расширением: XLSX, XLS, PDF и JSON собираются из одного снимка, и числа совпадают с экраном.'
		],
		play: async (page, _stand, crew) => {
			await traceNumber(page);
			await reportAndExport(page, crew);
		}
	},
	{
		name: 'data',
		role: 'manager',
		caption: 'Данные об обучении: дашборд и рейтинг программ',
		narration: [
			'Рядом — данные об обучении: снимки статистики, у каждого числа видно происхождение.',
			'Рейтинг программ и направлений считается по фактам самой системы — заявкам, потокам, обучающимся и завершившим, — с настраиваемыми весами.'
		],
		play: learningData
	},
	{
		name: 'automation',
		role: 'manager',
		caption: 'Карта автоматизации: 14 шагов процесса',
		narration: [
			'Карта автоматизации проходит все четырнадцать шагов процесса: что система делает сама, где помогает сотруднику, а где без доказательства дальше не пройти, — со ссылкой на экран и статью справки.'
		],
		play: async (page) => {
			await visit(page, '/automation', 'Карта автоматизации');
			await beat(page, 1);
			await scroll(page, 600);
			await beat(page, 1);
			await scroll(page, 600);
			await beat(page, 1.2);
		}
	},
	{
		name: 'exchange',
		role: 'admin',
		caption: 'Повторная подача заявки без дубля и самодиагностика связей',
		narration: [
			'Повторная подача той же заявки дубля не создаёт: в журнале два события, а взаимодействие одно.',
			'Исходящие сообщения подписаны, временные отказы повторяются, и повтор тоже не создаёт дубля.',
			'Самодиагностика показывает, с чем система соединяется и отвечает ли это прямо сейчас.'
		],
		play: exchangeTwice
	},
	{
		name: 'api',
		role: 'manager',
		caption: 'Программный интерфейс: Swagger UI по OpenAPI 3.1',
		narration: [
			'Программный интерфейс описан по OpenAPI 3.1: сорок три операции, и у каждой названо требуемое право.',
			'Описание собрано из тех же схем, что проверяют запросы, поэтому разойтись с поведением не может.'
		],
		play: async (page) => {
			await visit(page, '/api/docs', 'LCT CRM API', { standalone: true });
			await beat(page, 1);
			await scroll(page, 700);
			await beat(page, 1);
			await scroll(page, 700);
			await beat(page, 1.2);
		}
	},
	{
		name: 'final',
		role: 'manager',
		caption: 'Финальная карточка',
		narration: [
			'Стенд открыт: три роли, пароль написан на странице входа, руководства — внутри системы.',
			'Код и документация — в репозитории команды.'
		],
		play: async (page) => {
			await showCard(page, FINAL_CARD);
			await beat(page, 3);
		}
	}
];

/**
 * Вернуть стенд: сначала название заявки — его вернуть может руководитель при
 * любом ответственном, — затем общее для проходов (`restorePass`).
 */
async function restore(browser: Browser, stand: OverviewStand, storage: Sessions): Promise<void> {
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

const stand: OverviewStand = { ...freshStand(), retitled: null };
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
