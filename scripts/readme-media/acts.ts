/**
 * Сюжетные действия проходов по стенду: то, что скринкаст показа
 * (`screencast.ts`) и полный обзор (`overview.ts`) делают одинаково, — от
 * заявки с сайта до выгрузки отчёта.
 *
 * Действие — это то, что происходит в кадре, без закадра: реплику к нему пишет
 * проход, потому что короткий ролик и обзор рассказывают одно и то же разными
 * словами и с разной подробностью. Меняет действие стенд — отмечает это в
 * `Stand`, и `restorePass` возвращает ровно отмеченное.
 */
import path from 'node:path';
import type { Browser, Locator, Page } from '@playwright/test';

import {
	BASE_URL,
	WAIT,
	beat,
	drawScan,
	hydrated,
	pointAt,
	press,
	scroll,
	signIn,
	visit,
	withRole,
	type Crew,
	type Sessions
} from './film.ts';
import { DEMO_MANAGER_NAME, colleagueInCard, draftMention, sendComment } from './shots.ts';

/** Стадия, которую переименовывает администратор, и как она называется в черновике. */
export const RENAMED_STAGE = {
	key: 'communication',
	from: 'Коммуникация и сверка программ',
	to: 'Коммуникация и сверка образовательных программ'
} as const;

/** Первая стадия процесса учебных заведений: на ней стоит заявка с сайта. */
const FIRST_STAGE = 'Поиск контактных лиц';

/**
 * Обязательные пункты первой стадии. Подразделение пункт видит сам — по
 * площадке вида «Подразделение», выбранной у вуза в составе дела; контакт
 * менеджер подтверждает галочкой.
 */
const FIRST_STAGE_DEPARTMENT_ITEM = 'Найдено профильное подразделение';
const FIRST_STAGE_CHECKLIST = ['Подтверждён контакт ответственного лица'] as const;

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
	/** Вуз, которого руководитель передаёт другому менеджеру. */
	institution: { query: 'МТУСИ', name: 'МТУСИ' },
	/**
	 * Профильное подразделение вуза заявки с сайта (заявку подаёт МТУСИ):
	 * площадка вида «Подразделение» в карточке вуза.
	 */
	department: 'Кафедра информационной безопасности'
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

/** Что проход завёл на стенде: сцены передают это друг другу. */
export type Stand = {
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

export function freshStand(): Stand {
	return {
		externalId: '',
		interactionId: '',
		title: '',
		moved: false,
		institutionMoved: false,
		renamed: false
	};
}

/** Ключи заведённых проходом записей — в `timecodes.json` рядом со сценами. */
export function standSummary(stand: Stand): Record<string, string> {
	return {
		interactionId: stand.interactionId,
		externalId: stand.externalId,
		interactionTitle: stand.title
	};
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
 * Привести выбор профильного подразделения у вуза в деле к `chosen`.
 *
 * Так же, как менеджер: «Открыть сторону» у пункта чек-листа, «Выбрать
 * площадки» у учебного заведения, отметка площадки в составе дела и
 * сохранение. Пункт закрывается данными, а не галочкой: выбранное
 * подразделение он видит сам. Выбор уже такой — диалог закрывается без сохранения: пустая
 * правка оставила бы в ленте запись ни о чём.
 */
async function setDepartment(
	page: Page,
	chosen: boolean,
	options: { shown?: boolean } = {}
): Promise<void> {
	const click = async (target: Locator) => {
		if (options.shown === true) {
			await press(page, target);
		} else {
			await target.click();
		}
	};

	// Кнопка стоит у пункта, пока он открыт; у закрытого пункта кнопки нет, и
	// сторона открывается сразу в панели.
	const reveal = page
		.locator('[data-slot="card-action"] li')
		.filter({ hasText: FIRST_STAGE_DEPARTMENT_ITEM })
		.getByRole('button', { name: 'Открыть сторону' });

	if ((await reveal.count()) > 0) {
		await click(reveal);
	}

	await click(
		page
			.locator('[data-slot="institution-panel"]')
			.getByRole('button', { name: 'Выбрать площадки' })
	);

	const dialog = page.getByRole('dialog');
	const site = dialog.getByRole('checkbox', { name: STAND.department });

	await site.waitFor({ state: 'visible', timeout: WAIT });

	if ((await site.isChecked()) === chosen) {
		await dialog.getByRole('button', { name: 'Отмена' }).click();
		await dialog.waitFor({ state: 'hidden', timeout: WAIT });
		return;
	}

	await click(site);
	await click(dialog.getByRole('button', { name: 'Сохранить состав' }));
	await dialog.waitFor({ state: 'hidden', timeout: WAIT });
}

/** Ключи учебных групп, названные на карточке: по ним видно, какая заведена сейчас. */
async function groupKeys(page: Page): Promise<Set<string>> {
	const text = await page.locator('main').innerText();

	return new Set([...text.matchAll(/Поток\s+\d+\s+·\s+группа\s+(\S+)/gu)].map((found) => found[1]));
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
export async function openOrganization(page: Page, query: string, expected: string): Promise<void> {
	await visit(page, `/organizations?q=${encodeURIComponent(query)}`, 'Организации');

	await press(page, page.getByRole('row').nth(1));
	await page.waitForURL(/\/organizations\/[0-9a-f-]{36}/u, { timeout: WAIT });
	await hydrated(page);

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
export async function openInteraction(page: Page, query: string, expected: string): Promise<void> {
	await visit(page, `/interactions?view=table&q=${encodeURIComponent(query)}`, 'Взаимодействия');

	const row = page.getByRole('row').nth(1);

	await press(page, row);
	await page.waitForURL(/\/interactions\/[0-9a-f-]{36}/u, { timeout: WAIT });
	await hydrated(page);

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
		await hydrated(page);
		await canvas.scrollIntoViewIfNeeded();
	}

	throw new Error(`Клик по воронке не сузил отчёт до стадии «${stage}»`);
}

/**
 * Переименовать стадию черновика: диалог стадии, поле названия, сохранение.
 *
 * Форму стадии открывает её название в строке таблицы — первая кнопка
 * строки; вторая, значок корзины, удаляет стадию.
 */
async function renameStage(page: Page, key: string, name: string): Promise<void> {
	const row = page.getByRole('row').filter({ hasText: key });

	await press(page, row.getByRole('button').first());

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
	await row.getByRole('button', { name, exact: true }).waitFor({ state: 'visible', timeout: WAIT });
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

/**
 * Открыть отчёт, если проход ещё не на нём.
 *
 * Сцены отчёта идут подряд — общий реестр, клик по столбцу, выгрузка, — и
 * повторное открытие той же страницы выглядело бы в кадре как сбой.
 */
async function openReports(page: Page): Promise<void> {
	if (new URL(page.url()).pathname === '/reports' && page.url().startsWith(BASE_URL)) {
		return;
	}

	await visit(page, '/reports', 'Отчёты по взаимодействиям');
}

/**
 * Отчёт общий: число строк по всем делам, которые видит смотрящий, фильтр
 * пространств и воронка своя у каждого процесса, подписанная его названием.
 *
 * Снимать стоит ролью, которая работает в двух пространствах: у неё воронок
 * две, и видно, что числа стадий разных процессов не складываются.
 */
export async function reportFunnels(page: Page): Promise<void> {
	await openReports(page);
	await pointAt(page, page.getByTestId('report-row-count').first());
	await beat(page, 0.8);
	await pointAt(page, page.getByTestId('report-filter-workspace').first());
	await beat(page, 0.8);

	const funnels = page.getByText(/^Распределение по стадиям на дату среза — /u);

	await pointAt(page, funnels.first());
	await beat(page, 1);

	if ((await funnels.count()) > 1) {
		await pointAt(page, funnels.nth(1));
		await beat(page, 1.2);
	}

	await scroll(page, -2000, 6);
}

/**
 * Число отчёта раскрывается до подтверждения: столбец воронки, строка отчёта,
 * карточка и закрытый пункт чек-листа с отметкой по документу.
 */
export async function traceNumber(page: Page): Promise<void> {
	await openReports(page);
	await scroll(page, 560);
	await narrowByFunnel(page, STAND.signed.stage, STAND.signed.funnelIndex);
	await beat(page, 0.8);

	// Дальше идём строкой самого отчёта, а не ссылкой «открыть в списке»:
	// список стадию отчёта не понимает и показал бы выборку шире той, из
	// которой собрано число (`src/lib/components/reports/query.ts`).
	await press(page, page.getByRole('link', { name: STAND.signed.title }).first());
	await page.waitForURL(/\/interactions\/[0-9a-f-]{36}/u, { timeout: WAIT });
	await hydrated(page);

	// Подтверждение — закрытый пункт чек-листа, отмеченный галочкой. Стадия
	// «Подписание соглашения» требует отметки по документу
	// (`requiresDocumentMark`, не общего `confirmation`), поэтому пункт
	// подписан «Документ с отметкой «Утверждён»»
	// (`src/lib/components/interaction-card/model.ts`), а не «Подтверждено…».
	// Подтверждение подтягивается к середине кадра, а не остаётся у нижней
	// кромки.
	await scroll(page, 240);
	await pointAt(page, page.getByText('Документ с отметкой').first());
	await beat(page, 1.4);
}

/**
 * Кнопка стенда «Демо: заявка с сайта»: имитатор сайта подаёт заявку своим
 * триггером, и его ответ называет ключ заявки. Экран «Внешние системы» уже
 * открыт.
 */
export async function submitApplication(page: Page, stand: Stand): Promise<void> {
	await press(
		page,
		page
			.getByRole('group', { name: 'Демо: заявка с сайта' })
			.getByRole('button', { name: 'Вуз (b2b)' })
	);

	const sent = page.getByText(/Имитатор CMS подал заявку/u).first();

	await sent.waitFor({ state: 'visible', timeout: WAIT });

	const key = /заявку\s+(\S+?):/u.exec(await sent.innerText());

	if (key === null) {
		throw new Error('Имитатор не назвал ключ поданной заявки');
	}

	stand.externalId = key[1];
	await beat(page, 1.2);
}

/**
 * Журнал обмена по ключу заявки: дождаться, что снимок статуса уехал обратно,
 * и показать правые колонки — попытки и ответ получателя.
 */
export async function showApplicationLog(page: Page, stand: Stand): Promise<void> {
	await visit(page, `/exchange?q=${stand.externalId}`, 'Внешние системы');

	// Снимок статуса уходит фоновым проходом очереди, а не в той же
	// транзакции: журнал перечитывается, пока он не уедет.
	for (let attempt = 0; attempt < 10; attempt += 1) {
		if ((await page.locator('table').getByText('Отправлено').count()) > 0) {
			break;
		}

		await beat(page, 1.2);
		await page.reload({ waitUntil: 'load' });
		await hydrated(page);
	}

	await beat(page, 0.6);

	// Над журналом стоят блоки стенда: обе строки обмена — пришедшая заявка и
	// ушедший снимок статуса — видны после прокрутки к таблице.
	await scroll(page, 300);
	await pointAt(page, page.locator('table').getByText('application.submitted').first());
	await beat(page, 0.8);
	await pointAt(page, page.locator('table').getByText('Отправлено').first());
	await beat(page, 1.2);
}

/** Из журнала — в карточку взаимодействия, которое завела заявка. */
export async function openApplication(page: Page, stand: Stand): Promise<void> {
	await press(page, page.getByRole('link', { name: /Заявка с сайта/u }).first());
	await page.waitForURL(/\/interactions\/[0-9a-f-]{36}/u, { timeout: WAIT });
	await hydrated(page);
	await page.getByText('Все стадии процесса').first().waitFor({ state: 'visible', timeout: WAIT });

	stand.interactionId = /\/interactions\/([0-9a-f-]{36})/u.exec(page.url())?.[1] ?? '';
	stand.title = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
	await beat(page, 1.6);
}

/**
 * Вторая сторона обмена: карточка своей заявки на странице имитатора сайта —
 * то, что видит заявитель, — со снимком статуса, который прислала CRM.
 */
export async function showSiteSide(page: Page, stand: Stand): Promise<void> {
	await visit(page, `/mock-cms/?application=${stand.externalId}`, `Заявка ${stand.externalId}`, {
		standalone: true
	});
	await pointAt(page, page.getByText('Статус на сайте', { exact: true }).first());
	await beat(page, 1.2);
}

/**
 * Менеджер узнаёт о новом деле с сайта колокольчиком в шапке и открывает
 * карточку строкой уведомления — тем же нажатием, что и человек.
 *
 * Строка ищется по названию дела: колокольчик может нести и другие
 * непрочитанные — упоминания или прежние заявки.
 */
async function arriveFromInbox(page: Page, stand: Stand): Promise<void> {
	await visit(page, '/', 'Мой день');

	const bell = page.getByRole('button', { name: /^Уведомления: \d/u }).first();

	await press(page, bell);

	const item = page
		.getByRole('link')
		.filter({ hasText: 'Новое дело с сайта' })
		.filter({ hasText: stand.title })
		.first();

	await pointAt(page, item);
	await beat(page, 1.2);
	await press(page, item);
	await page.waitForURL(/\/interactions\/[0-9a-f-]{36}/u, { timeout: WAIT });
	await hydrated(page);
	await page.getByText('Все стадии процесса').first().waitFor({ state: 'visible', timeout: WAIT });
}

/**
 * Работа менеджера в карточке заявки: кто в деле, закрытый шаг с причинами,
 * чек-лист, переход с комментарием и файлом и комментарий руководителя с
 * упоминанием, пришедший без перезагрузки.
 *
 * Возвращает страницу руководителя: он остаётся в той же карточке до конца
 * сцены, и проход может продолжить с ним.
 */
export async function workTheCard(
	page: Page,
	stand: Stand,
	crew: Crew,
	options: { viaInbox?: boolean } = {}
): Promise<Page> {
	const address = `/interactions/${stand.interactionId}`;
	// Руководитель открывает дело вместе с менеджером, а не до сцены: его
	// аватарка появляется в кадре так же, как её увидел бы человек.
	const [lead] = await Promise.all([
		crew.join('lead', address),
		options.viaInbox === true
			? arriveFromInbox(page, stand)
			: visit(page, address, 'Все стадии процесса')
	]);

	await colleagueInCard(page);
	await pointAt(page, page.locator('[data-slot="card-presence"]'));

	if (options.viaInbox === true) {
		// Какой статус видит заявитель на сайте и дошёл ли он: журнал обмена
		// открыт администратору, менеджеру — эта строка в фактах карточки.
		await pointAt(page, page.locator('[data-slot="site-application"]'));
		await beat(page, 1);
	}

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
			await setDepartment(page, true, { shown: true });
			await beat(page, 0.6);

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

	await dialog
		.locator('#card-transition-files')
		.setInputFiles(
			await drawScan(crew.work, 'protokol-vstrechi.png', [
				'Протокол встречи',
				'МТУСИ · подготовка DevOps-инженеров',
				'Демонстрационный файл записи показа'
			])
		);
	await beat(page, 0.6);

	await press(page, dialog.getByRole('button', { name: 'Подтвердить' }));

	// Признак того, что переход состоялся, — чек-лист новой стадии в
	// «Следующем шаге»: её название есть на карточке и до перехода, в цепочке
	// стадий, а пункты — в свёрнутом списке всех стадий.
	await page
		.locator('[data-slot="card-action"]')
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

	return lead;
}

/**
 * Правка живого процесса: черновик, переименование стадии, предпросмотр
 * затронутых, «Применить ко всем» — и карточка заявки под новым названием.
 */
export async function renameLiveStage(page: Page, stand: Stand): Promise<void> {
	await visit(page, '/settings/workflows/b2b', 'Процесс');

	await press(page, page.getByRole('button', { name: 'Черновик изменений' }));
	await page
		.getByText('Стадии и переходы правятся в черновике')
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
	await dialog.getByText('Переедут на другую стадию').waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 1.8);

	await press(page, dialog.getByRole('button', { name: 'Применить ко всем' }));
	await page
		.getByText('Стадии и переходы действующего процесса открыты только на чтение')
		.first()
		.waitFor({ state: 'visible', timeout: WAIT });

	stand.renamed = true;
	await beat(page, 1);

	await visit(page, `/interactions/${stand.interactionId}`, 'Все стадии процесса');
	await pointAt(page, page.getByText(RENAMED_STAGE.to).first());
	await beat(page, 1.4);
}

/**
 * Вход руководителя в кадре и передача вуза другому менеджеру вместе с
 * незакрытыми записями.
 */
export async function handOver(page: Page, stand: Stand): Promise<void> {
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

/** У прежнего ответственного записей по переданному вузу больше нет. */
export async function showHandedOver(page: Page): Promise<void> {
	await visit(page, `/interactions?view=table&q=${STAND.institution.query}`, 'Взаимодействия');
	await page.getByText('Ничего не найдено').first().waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 1.6);
}

/**
 * Поток в систему обучения: «Заявить поток» → «Отправить в LMS», результат со
 * страницы имитатора и закрытый пункт чек-листа на карточке.
 *
 * Возвращает ключ заведённой группы: по нему проход может продолжить работу с
 * этим потоком на той же карточке.
 */
export async function runLearningGroup(page: Page): Promise<string> {
	await openInteraction(page, STAND.classes.query, 'ведение занятий');

	// Адрес карточки запоминается: со страницы имитатора возвращаются сюда,
	// а не «назад» — назад стоит отправленная форма имитатора.
	const card = page.url();

	await page.getByText(STAND.classes.stage).first().waitFor({ state: 'visible', timeout: WAIT });
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
	// План потока ещё впереди, а итог с датой окончания позже дня отправки CRM
	// не принимает: поток завершён досрочно, сегодняшним днём.
	await page.locator('select[name="finish"]').selectOption('завершили сегодня');
	await beat(page, 0.5);
	await press(page, page.getByRole('button', { name: 'Отправить результат в CRM' }));
	await beat(page, 1);

	await page.goto(card, { waitUntil: 'load' });
	await hydrated(page);
	await scroll(page, 1100);
	await page
		.getByText('зачислено', { exact: true })
		.first()
		.waitFor({ state: 'visible', timeout: WAIT });
	await beat(page, 1);

	// Подтверждение стадии — закрытый пункт чек-листа, как и в `traceNumber`.
	await pointAt(page, page.getByText('записью в системе обучения').first());
	await beat(page, 1.4);

	return group;
}

/**
 * Отчёт: движение с правилом подсчёта, меню выгрузки, PDF (и XLSX, если его
 * называет закадр) — и открытый скачанный PDF.
 */
export async function reportAndExport(
	page: Page,
	crew: Crew,
	options: { xlsx: boolean }
): Promise<void> {
	await openReports(page);
	await press(page, page.getByTestId('report-mode-movement'));
	await page.waitForURL(/mode=movement/u, { timeout: WAIT });
	await hydrated(page);
	// Правило подсчёта свёрнуто под «Как считается»: раскрытое, оно словами
	// говорит, чем движение отличается от среза.
	await press(page, page.getByTestId('report-method-toggle'));
	await pointAt(page, page.getByText('Каждая строка — один переход').first());
	await beat(page, 1.2);

	const saved = new Map<string, string>();

	// Форматы — пункты меню одной кнопки «Выгрузить»
	// (`src/lib/components/reports/export-menu.svelte`). PDF бывает сводкой или
	// целиком; «целиком» выключен, когда в выборке больше строк, чем берёт
	// полный PDF, — тогда выгружается сводка. XLSX выгружается, когда о нём
	// говорит закадр: короткому ролику хватает PDF.
	const exports = [
		...(options.xlsx ? [{ key: 'xlsx', item: 'report-export-xlsx', fallback: null }] : []),
		{ key: 'pdf', item: 'report-export-pdf-full', fallback: 'report-export-pdf' }
	] as const;

	for (const [index, format] of exports.entries()) {
		await press(page, page.getByTestId('report-export'));

		const full = page.getByTestId(format.item);

		await full.waitFor({ state: 'visible', timeout: WAIT });

		if (index === 0) {
			// Меню показывается целиком один раз: пять пунктов с подсказками —
			// это и есть ответ на вопрос «в чём можно выгрузить».
			await beat(page, 1.2);
		}

		const disabled = (await full.getAttribute('aria-disabled')) === 'true';
		const target = disabled && format.fallback !== null ? page.getByTestId(format.fallback) : full;
		const download = page.waitForEvent('download', { timeout: WAIT });

		await press(page, target);

		const file = await download;
		// Имя даём своё: у выгрузки его назначает заголовок ответа, и
		// показывать в ролике надо не имя файла, а сам файл.
		const saveTo = path.join(crew.work, `report.${format.key}`);

		await file.saveAs(saveTo);
		saved.set(format.key, saveTo);
		console.log(`выгрузка ${format.key.toUpperCase()}: ${saveTo}`);
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

/**
 * Вернуть то, что изменили общие действия.
 *
 * Стенд общий и его смотрят: стадия заявки, ответственный и название стадии
 * возвращаются тем же путём, которым менялись, — интерфейсом и от имени роли,
 * которой это по силам. Возвращается только то, что этот проход действительно
 * изменил: лишняя публикация процесса оставила бы в журнале запись об
 * изменении, которого не было. Порядок обязателен: пока запись числится за
 * другим менеджером, прежний ответственный её не видит и вернуть стадию не
 * может.
 */
export async function restorePass(
	browser: Browser,
	stand: Stand,
	storage: Sessions
): Promise<void> {
	if (stand.institutionMoved) {
		await withRole(browser, storage, 'lead', async (page) => {
			await assignInstitution(page, RESPONSIBLE.from);

			console.log(`вуз возвращён: ${RESPONSIBLE.from}`);
		});
	}

	if (stand.moved) {
		await withRole(browser, storage, 'manager', async (page) => {
			await page.goto(`${BASE_URL}/interactions/${stand.interactionId}`, { waitUntil: 'load' });
			await hydrated(page);

			await transition(
				page,
				`Вернуть на «${FIRST_STAGE}»`,
				'Возврат стенда к исходному состоянию после записи показа.'
			);

			// Чек-лист возвращается следом: стадия, на которую вернулись, иначе
			// осталась бы закрытой, и следующий проход начался бы не с того, с чего
			// начинается стенд. Подразделение пункт видит по данным дела — его
			// выбор снимается в составе.
			for (const item of FIRST_STAGE_CHECKLIST) {
				await setChecklistItem(page, item, false);
			}

			await setDepartment(page, false);

			console.log(`стадия возвращена: ${FIRST_STAGE}`);
		});
	}

	if (stand.renamed) {
		await withRole(browser, storage, 'admin', async (page) => {
			await page.goto(`${BASE_URL}/settings/workflows/b2b`, { waitUntil: 'load' });
			await hydrated(page);
			await page.getByRole('button', { name: 'Черновик изменений' }).click();
			await page
				.getByText('Стадии и переходы правятся в черновике')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });

			await renameStage(page, RENAMED_STAGE.key, RENAMED_STAGE.from);

			await page.getByRole('button', { name: 'Применить ко всем' }).first().click();

			const dialog = page.getByRole('dialog');

			await dialog.waitFor({ state: 'visible', timeout: WAIT });
			await dialog.getByRole('button', { name: 'Применить ко всем' }).click();
			await page
				.getByText('Стадии и переходы действующего процесса открыты только на чтение')
				.first()
				.waitFor({ state: 'visible', timeout: WAIT });

			console.log(`процесс возвращён: стадия «${RENAMED_STAGE.from}»`);
		});
	}
}
