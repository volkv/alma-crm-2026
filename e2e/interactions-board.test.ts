import { expect, test } from './fixtures';
import { LEAD_STATE } from './global-setup';

/**
 * Доска взаимодействий глазами менеджера: переключение представления, перевод
 * карточки меню и перетаскиванием, отказ словами и раскладка на телефоне.
 *
 * Данные тест готовит себе сам — заводит взаимодействие формой и работает
 * только с ним, — а находит его на доске поиском в адресе: база прогона общая,
 * и в колонке рядом стоят записи стенда и соседних проверок.
 */

/** Пространство учебных заведений: его ключ стоит в адресе доски. */
const WORKSPACE = 'b2b';

/** Вуз из набора стенда: организации заводит сид, а не эта проверка. */
const INSTITUTION = 'СПбПУ';

const FIRST_STAGE = 'Поиск контактных лиц';
const SECOND_STAGE = 'Коммуникация и сверка программ';

type Page = import('@playwright/test').Page;

/** Заводит взаимодействие через форму и возвращает его название. */
async function createInteraction(page: Page): Promise<string> {
	const title = `E2E-ДОСКА ${crypto.randomUUID().slice(0, 8)}`;

	await page.goto(`/w/${WORKSPACE}/interactions/new`);

	// Подсказки организаций появляются только после того, как страница ожила:
	// ввод до гидратации не доходит до компонента, а под нагрузкой прогона это
	// случается. Поэтому ввод повторяется, пока подсказка не покажется.
	const picker = page.getByLabel(/^Учебное заведение/);
	const option = page.getByRole('button', { name: INSTITUTION, exact: true });

	await expect(async () => {
		await picker.fill('');
		await picker.pressSequentially(INSTITUTION, { delay: 20 });
		await expect(option).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 20_000 });

	await option.click();
	await page.getByLabel(/^Название/).fill(title);
	await page.getByRole('button', { name: 'Создать взаимодействие' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

	return title;
}

/** Закрывает обязательные пункты чек-листа первой стадии на карточке. */
async function closeChecklist(page: Page): Promise<void> {
	await page.getByRole('switch', { name: 'Найдено профильное подразделение' }).click();
	await page.getByRole('switch', { name: 'Подтверждён контакт ответственного лица' }).click();
	await expect(page.getByRole('button', { name: `Перейти: ${SECOND_STAGE}` })).toBeEnabled();
}

/** Доска, отобранная до одной записи: в общей базе прогона соседей хватает. */
async function openBoard(page: Page, title: string): Promise<void> {
	await page.goto(`/w/${WORKSPACE}/interactions?view=board&q=${encodeURIComponent(title)}`);
	await expect(page.locator('[data-slot="interactions-board"]')).toBeVisible();
}

function column(page: Page, name: string) {
	return page.getByRole('region', { name: `Стадия: ${name}` });
}

function cardOf(page: Page, stage: string, title: string) {
	return column(page, stage).locator('[data-slot="board-card"]').filter({ hasText: title });
}

/** Меню карточки открывает клиентский код: до гидратации нажатие теряется. */
async function openCardMenu(page: Page, stage: string, title: string): Promise<void> {
	const trigger = cardOf(page, stage, title).getByRole('button', {
		name: 'Перевести на другую стадию'
	});

	await expect(async () => {
		await trigger.click();
		await expect(page.getByRole('menu')).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 20_000 });
}

test('переключатель приводит к доске и сохраняет отбор', async ({ page }) => {
	const title = await createInteraction(page);

	await page.goto(`/w/${WORKSPACE}/interactions?q=${encodeURIComponent(title)}`);
	await page.getByRole('link', { name: 'Доска' }).click();

	await expect(page).toHaveURL(/[?&]view=board/);
	// Отбор переезжает вместе с представлением: доска показывает тот же набор.
	await expect(page.getByText(`Поиск: «${title}»`)).toBeVisible();

	const first = column(page, FIRST_STAGE);

	await expect(first).toBeVisible();
	await expect(column(page, 'Контроль исполнения')).toBeVisible();
	await expect(cardOf(page, FIRST_STAGE, title)).toBeVisible();
	// Колонка считает дела отобранного набора, а не всё, что стоит на стадии.
	// Счётчик стоит в шапке колонки, то есть первым значком в ней.
	await expect(first.locator('[data-slot="status-badge"]').first()).toHaveText('1');
	await expect(column(page, SECOND_STAGE).getByText('Здесь пусто')).toBeVisible();

	// Выбора версии процесса на доске нет: в пространстве действует ровно один
	// процесс, и его номер не участвует ни в одном решении.
	await expect(page.getByRole('button', { name: /^Маршрут/ })).toHaveCount(0);
	await expect(page.getByText(/версия \d/i)).toHaveCount(0);
	await expect(page.getByText(/Процесс пространства «/)).toBeVisible();

	await page.screenshot({ path: 'test-results/interactions-board-desktop.png', fullPage: true });
});

test('меню карточки объясняет отказ и переводит готовую стадию', async ({ page }) => {
	const title = await createInteraction(page);

	await openBoard(page, title);
	await openCardMenu(page, FIRST_STAGE, title);

	// Недоступный переход остаётся в меню с причиной: пункт, который исчез, не
	// объясняет ничего.
	const forward = page.getByRole('menuitem', { name: new RegExp(`^Перейти: ${SECOND_STAGE}`) });

	await expect(forward).toHaveAttribute('aria-disabled', 'true');
	await expect(forward).toContainText('Не закрыт обязательный пункт чек-листа');

	await page.keyboard.press('Escape');

	await cardOf(page, FIRST_STAGE, title).getByRole('link', { name: title }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
	await closeChecklist(page);

	await openBoard(page, title);
	await openCardMenu(page, FIRST_STAGE, title);
	await page.getByRole('menuitem', { name: new RegExp(`^Перейти: ${SECOND_STAGE}`) }).click();

	await expect(cardOf(page, SECOND_STAGE, title)).toBeVisible();
	await expect(cardOf(page, FIRST_STAGE, title)).toHaveCount(0);
});

test('перетаскивание двигает карточку, а возврат спрашивает причину', async ({ page }) => {
	const title = await createInteraction(page);
	await closeChecklist(page);

	await openBoard(page, title);
	await cardOf(page, FIRST_STAGE, title).dragTo(column(page, SECOND_STAGE));

	await expect(cardOf(page, SECOND_STAGE, title)).toBeVisible();

	// Возврат — это отступление от процесса, и он обязан быть объяснён; причину
	// спрашивают до команды, а не показывают отказ после неё.
	await cardOf(page, SECOND_STAGE, title).dragTo(column(page, FIRST_STAGE));

	const dialog = page.getByRole('dialog');

	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('heading')).toHaveText(`Вернуть: ${FIRST_STAGE}`);

	await dialog.getByLabel('Причина').fill('Контакт оказался не тем подразделением');
	await dialog.getByRole('button', { name: 'Подтвердить' }).click();

	await expect(cardOf(page, FIRST_STAGE, title)).toBeVisible();
	await expect(cardOf(page, SECOND_STAGE, title)).toHaveCount(0);
});

test('доска уезжает вбок внутри себя, а не вместе со страницей', async ({ page }) => {
	const title = await createInteraction(page);

	await page.setViewportSize({ width: 390, height: 844 });
	await openBoard(page, title);

	const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);

	expect(overflow).toBeLessThanOrEqual(0);

	// Четырнадцать колонок шире телефона: прокручиваться обязана сама доска.
	const scrollable = await page
		.locator('[data-slot="interactions-board"]')
		.evaluate((element) => element.scrollWidth > element.clientWidth);

	expect(scrollable).toBe(true);

	await page.screenshot({ path: 'test-results/interactions-board-mobile.png', fullPage: true });
});

test('адрес доски открывает одно и то же место, а незнакомый ключ — 404', async ({
	page,
	browser
}) => {
	// Пространство задаёт адрес, а не загруженность смотрящего: ссылка,
	// скопированная из адресной строки, у коллеги открывает ту же доску. Пока
	// доска выбирала место сама, это было неправдой.
	const address = `/w/${WORKSPACE}/interactions?view=board`;
	const caption = /Процесс пространства «Работа с ВУЗ»/;

	await page.goto(address);
	await expect(page.getByText(caption)).toBeVisible();

	const context = await browser.newContext({ storageState: LEAD_STATE });

	try {
		const lead = await context.newPage();

		await lead.goto(address);
		await expect(lead.getByText(caption)).toBeVisible();
	} finally {
		await context.close();
	}

	// Незнакомый ключ — отказ словами, а не молчаливый показ соседнего
	// пространства: человек пришёл по ссылке и обязан узнать, что её адресата нет.
	const missing = await page.goto('/w/no-such-workspace/interactions');

	expect(missing?.status()).toBe(404);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Страница не найдена');
	await expect(page.getByText('Пространство не найдено')).toBeVisible();
});
