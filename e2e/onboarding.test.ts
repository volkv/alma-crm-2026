import { test as base, type ConsoleMessage, type Locator, type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ADMIN_STATE } from './global-setup';
import { waitForHydration } from './helpers/hydration';

/**
 * Подсказки глазами человека, который открыл систему впервые.
 *
 * Проверяется то, ради чего они есть: тур приходит сам и только один раз, ведёт
 * по экранам роли **сам** — открывая их без единого нажатия по меню, — уходит по
 * первой просьбе и возвращается из шапки, из справки и из меню учётной записи.
 * Роль здесь менеджерская, самая массовая на стенде; состав экранов и шагов по
 * ролям и правам закрыт модульными проверками (`tests/unit/onboarding`).
 *
 * Признак «подсказки показаны» живёт в браузере, поэтому «первый вход» здесь —
 * это сессия из общей фикстуры и чистая память браузера: сервер об этом
 * различии ничего не знает, и подделывать сессию незачем.
 */

/** Демонстрационный администратор: до его настроек тур идёт дольше всех. */
const adminTest = base.extend<object>({ storageState: ADMIN_STATE });

/** Экран телефона: карточка подсказки на нём встаёт понизу. */
const NARROW = { width: 390, height: 844 } as const;

/** Приветствие полного тура: с него начинается первый вход. */
const WELCOME = 'LCT CRM: система контроля взаимодействия с вузами';

function tourOf(page: Page): Locator {
	return page.getByTestId('onboarding-tour');
}

/** Первый вход на этом устройстве: сессия есть, памяти браузера нет. */
async function firstVisit(page: Page, address = '/'): Promise<Locator> {
	await page.goto(address);
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await waitForHydration(page);

	const tour = tourOf(page);

	// Тур появляется после того, как страница ожила: до этого признак «показан»
	// ещё не прочитан — он лежит в браузере.
	await expect(tour).toBeVisible({ timeout: 15_000 });

	return tour;
}

/**
 * Довести тур до вступления названного экрана, нажимая только «Далее».
 *
 * Именно так тур и проверяется: сколько шагов лежит между экранами, решает
 * реестр, и число, вписанное в проверку, пришлось бы править на каждый новый
 * шаг. Человек в этом месте делает ровно одно — жмёт «Далее», пока не окажется
 * там, куда его ведут.
 */
async function advanceToScreen(tour: Locator, title: string): Promise<void> {
	const label = `${title} · шаг 1 из`;

	await expect(async () => {
		if (!(await tour.innerText()).includes(label)) {
			await tour.getByRole('button', { name: 'Далее' }).click();

			throw new Error(`Тур ещё не дошёл до экрана «${title}»`);
		}
		// Ровный шаг между нажатиями: полный тур администратора — под сотню
		// остановок с переходами между разделами, и растущие паузы умолчания
		// растянули бы дорогу до «Процесса» дольше любого разумного предела.
	}).toPass({ timeout: 180_000, intervals: [250] });
}

/**
 * Запрос за файлом фирменной гарнитуры, которого нет.
 *
 * Файлов Rostelecom Basis в репозитории нет — лицензии на распространение не
 * было (`src/app.css`, комментарий к `@font-face`): в чистой копии и в CI они
 * отвечают 404, браузер берёт следующее семейство (Inter из сборки), и это
 * задуманное поведение, а не отказ. Проверка консоли здесь — про ошибки нашего
 * кода, поэтому такие строки в неё не попадают. На машине, где `static/fonts/`
 * заполнен, их нет вовсе — оттого прогон и расходился с CI.
 */
function isMissingFont(message: ConsoleMessage): boolean {
	return message.location().url.includes('/fonts/');
}

/** Насколько документ шире экрана. Ноль и меньше — помещается. */
async function documentOverflow(page: Page): Promise<number> {
	return page.evaluate(() => {
		const root = document.documentElement;

		return root.scrollWidth - root.clientWidth;
	});
}

test('первый вход начинается с карты тура и ведёт по экранам сам', async ({ page }) => {
	const errors: string[] = [];

	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error' && !isMissingFont(message)) {
			// Адрес рядом с текстом: «Failed to load resource» без него не говорит,
			// какого именно ресурса не хватило, — разбирать упавший прогон CI
			// пришлось бы по трассе.
			errors.push(`${message.text()} ${message.location().url}`);
		}
	});

	const tour = await firstVisit(page);

	// Приветствие: что это за система, куда поведут и сколько это займёт.
	await expect(tour.getByRole('heading', { level: 2 })).toHaveText(WELCOME);
	await expect(tour).toContainText('Тур пройдёт по экранам вашей роли');
	await expect(tour).toContainText('Взаимодействия');
	await expect(tour).toContainText('примерно');

	await tour.getByRole('button', { name: 'Начать тур' }).click();

	// Сначала оболочка: меню, поиск, значок «?», тема и учётная запись.
	await expect(tour.getByRole('heading', { level: 2 })).toHaveText('Разделы слева');
	await expect(tour).toContainText('Оболочка системы');

	await advanceToScreen(tour, 'Сводка');
	await expect(page).toHaveURL(/\/$/);
	await expect(tour.getByRole('heading', { level: 2 })).toHaveText('Сводка: с чего начинают день');

	// Дальше тур открывает разделы сам: человек жмёт «Далее», а не ищет пункт
	// меню. Адрес меняется без единого нажатия по навигации.
	await advanceToScreen(tour, 'Взаимодействия');
	await expect(page).toHaveURL(/\/interactions$/);

	// И доходит до открытой записи: идентификатор ей дал сервер, в границах
	// области доступа этой сессии.
	await advanceToScreen(tour, 'Карточка взаимодействия');
	await expect(page).toHaveURL(
		/\/interactions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
	);

	await tour.getByRole('button', { name: 'Закрыть подсказки' }).click();
	await expect(tour).toBeHidden();

	// Тот же человек, тот же браузер: полный тур предлагается один раз.
	await page.reload();
	await waitForHydration(page);
	await expect(tour).toBeHidden();

	// Шаги, чей блок на текущем экране не нашёлся, — обычное состояние тура, а
	// не отказ: в консоли после прохода пусто.
	expect(errors).toEqual([]);
});

test('«Позже» на приветствии закрывает подсказки до следующего устройства', async ({ page }) => {
	const tour = await firstVisit(page);

	await tour.getByRole('button', { name: 'Позже' }).click();
	await expect(tour).toBeHidden();

	await page.reload();
	await waitForHydration(page);
	await expect(tour).toBeHidden();

	await page.goto('/interactions');
	await waitForHydration(page);
	await expect(tour).toBeHidden();
});

test('значок «?» открывает подсказки по текущему экрану', async ({ page }) => {
	await page.goto('/reports');
	await waitForHydration(page);

	const tour = tourOf(page);

	// Сессия прогона уже видела приветствие: сам тур не приходит.
	await expect(tour).toBeHidden();

	const trigger = page.getByRole('button', { name: 'Подсказки и справка' });
	const item = page.getByRole('menuitem', { name: 'Подсказки по этому экрану' });

	// Точка-напоминание горит, пока подсказки этого экрана не смотрели.
	await expect(trigger.locator('span')).toBeVisible();

	// Меню открывает код страницы: нажатие до того, как она ожила, теряется
	// совсем (`docs/development.md`, «Всплывающие слои»).
	await expect(async () => {
		await trigger.click();
		await expect(item).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await expect(page.getByRole('menuitem', { name: 'Статья справки: Отчёты' })).toBeVisible();

	await item.click();

	await expect(tour).toBeVisible();
	await expect(tour.getByRole('heading', { level: 2 })).toHaveText('Отчёты: срез и движение');
	await expect(tour).toContainText('Отчёты · шаг 1 из');
	// Вступление обводит заголовок страницы: «речь об этом экране».
	await expect(page.locator('[data-tour="page-header"]')).toBeVisible();

	// Вступление показано — напоминать больше не о чем.
	await expect(trigger.locator('span')).toBeHidden();

	// Фокус переезжает в карточку сам, и Tab из неё не уходит: страница под
	// туром выключена слоем, и нажимать в ней нечего.
	await page.keyboard.press('Tab');
	await page.keyboard.press('Tab');
	await page.keyboard.press('Tab');

	const inside = await page.evaluate(() => {
		const card = document.querySelector('[data-testid="onboarding-tour"]');

		return card !== null && card.contains(document.activeElement);
	});

	expect(inside).toBe(true);

	await page.keyboard.press('Escape');
	await expect(tour).toBeHidden();
});

test('полный тур возвращается из меню учётной записи, оглавление ведёт к экрану', async ({
	page
}) => {
	await page.goto('/');
	await waitForHydration(page);

	const tour = tourOf(page);

	await expect(tour).toBeHidden();

	const restart = page.getByRole('menuitem', { name: 'Полный тур по системе' });

	await expect(async () => {
		await page.getByRole('button', { name: 'Менеджер Демо' }).click();
		await expect(restart).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await restart.click();

	// Тур начинается с приветствия, а не с того экрана, где его позвали.
	await expect(tour).toBeVisible();
	await expect(tour.getByRole('heading', { level: 2 })).toHaveText(WELCOME);

	await tour.getByRole('button', { name: 'Начать тур' }).click();

	// Оглавление — способ не проходить весь тур подряд.
	await tour.getByRole('button', { name: 'Оглавление' }).click();
	await page.getByRole('menuitem', { name: 'Отчёты', exact: true }).click();

	await expect(tour.getByRole('heading', { level: 2 })).toHaveText('Отчёты: срез и движение');
	await expect(page).toHaveURL(/\/reports$/);

	await page.keyboard.press('Escape');
	await expect(tour).toBeHidden();
});

test('подсказка читается на телефоне и не двигает страницу', async ({ page }) => {
	await page.setViewportSize(NARROW);

	const tour = await firstVisit(page);

	await expect(tour.getByRole('heading', { level: 2 })).toHaveText(WELCOME);
	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);

	await tour.getByRole('button', { name: 'Начать тур' }).click();

	// Дальше карточка прижата к низу экрана: рядом с элементом ей не поместиться.
	await expect(tour.getByRole('button', { name: 'Закрыть подсказки' })).toBeVisible();
	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);

	await tour.getByRole('button', { name: 'Далее' }).click();
	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
});

adminTest('полный тур администратора доходит до настроек процесса', async ({ page }) => {
	const tour = await firstVisit(page);

	await tour.getByRole('button', { name: 'Начать тур' }).click();

	await advanceToScreen(tour, 'Сводка');
	await expect(page).toHaveURL(/\/$/);

	await advanceToScreen(tour, 'Отчёты');
	await expect(page).toHaveURL(/\/reports$/);

	await advanceToScreen(tour, 'Организации');
	await expect(page).toHaveURL(/\/organizations$/);

	// Настройки идут последними: сначала работа, потом правила, по которым она
	// идёт. Дорогу туда тур проходит сам.
	await advanceToScreen(tour, 'Процесс');
	await expect(page).toHaveURL(/\/settings\/process$/);
	await expect(tour.getByRole('heading', { level: 2 })).toHaveText('Процесс');

	await tour.getByRole('button', { name: 'Закрыть подсказки' }).click();
	await expect(tour).toBeHidden();
});
