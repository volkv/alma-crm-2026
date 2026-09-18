import type { ConsoleMessage, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { waitForHydration } from './helpers/hydration';

/**
 * Подсказки первого входа глазами человека, который открыл систему впервые.
 *
 * Проверяется то, ради чего они есть: тур приходит сам и только один раз, ведёт
 * по экранам роли, уходит по первой просьбе и возвращается из справки. Роль
 * здесь менеджерская — самая массовая на стенде; выбор шагов по роли и по
 * текущему экрану закрыт модульными проверками (`tests/unit/onboarding`).
 *
 * Признак «подсказки показаны» живёт в браузере, поэтому «первый вход» здесь —
 * это сессия из общей фикстуры и чистая память браузера: сервер об этом
 * различии ничего не знает, и подделывать сессию незачем.
 */

/** Экран телефона: карточка подсказки на нём встаёт понизу. */
const NARROW = { width: 390, height: 844 } as const;

const TOUR_STEPS = [
	'Сводка: что требует действия',
	'Карточка отвечает на четыре вопроса',
	'Переход стадии',
	'Справка и поиск'
] as const;

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

test('первый вход начинается с подсказок и ведёт по шагам роли', async ({ page }) => {
	const tour = await firstVisit(page);

	await expect(tour).toContainText(`Шаг 1 из ${TOUR_STEPS.length}`);
	await expect(tour.getByRole('heading', { level: 2 })).toHaveText(TOUR_STEPS[0]);
	// Первый шаг говорит о блоке, который на этом экране есть: рамка ему и нужна.
	await expect(page.locator('[data-tour="home-needs-action"]')).toBeVisible();

	await tour.getByRole('button', { name: 'Далее' }).click();

	await expect(tour).toContainText(`Шаг 2 из ${TOUR_STEPS.length}`);
	await expect(tour.getByRole('heading', { level: 2 })).toHaveText(TOUR_STEPS[1]);

	// Блок второго шага живёт в другом разделе, и шаг ведёт туда ссылкой, а не
	// оставляет человека перед рассказом о том, чего на экране нет.
	await tour.getByRole('link', { name: 'Открыть «Взаимодействия»' }).click();

	await expect(page).toHaveURL(/\/interactions$/);
	// Переход между экранами тур переживает: шаг остался тот же.
	await expect(tour).toContainText(`Шаг 2 из ${TOUR_STEPS.length}`);
	await expect(tour.getByRole('link', { name: 'Открыть «Взаимодействия»' })).toBeHidden();

	await tour.getByRole('button', { name: 'Назад' }).click();
	await expect(tour).toContainText(`Шаг 1 из ${TOUR_STEPS.length}`);
});

test('пропуск закрывает подсказки, и следующий вход обходится без них', async ({ page }) => {
	const tour = await firstVisit(page);

	await tour.getByRole('button', { name: 'Пропустить' }).click();
	await expect(tour).toBeHidden();

	// Тот же человек, тот же браузер: подсказки показываются один раз.
	await page.reload();
	await waitForHydration(page);
	await expect(tour).toBeHidden();

	await page.goto('/interactions');
	await waitForHydration(page);
	await expect(tour).toBeHidden();
});

test('последний шаг закрывает подсказки так же, как пропуск', async ({ page }) => {
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

	for (let step = 1; step < TOUR_STEPS.length; step += 1) {
		await tour.getByRole('button', { name: 'Далее' }).click();
		await expect(tour).toContainText(`Шаг ${step + 1} из ${TOUR_STEPS.length}`);
	}

	await tour.getByRole('button', { name: 'Готово' }).click();
	await expect(tour).toBeHidden();

	await page.reload();
	await waitForHydration(page);
	await expect(tour).toBeHidden();

	// Шаги, чей блок на текущем экране не нашёлся, — обычное состояние тура, а
	// не отказ: в консоли после полного прохода пусто.
	expect(errors).toEqual([]);
});

test('подсказки возвращаются из справки и закрываются с клавиатуры', async ({ page }) => {
	const tour = tourOf(page);

	await page.goto('/help');
	await waitForHydration(page);

	// Сессия прогона уже видела подсказки: сами они не приходят.
	await expect(tour).toBeHidden();

	await expect(async () => {
		await page.getByRole('button', { name: 'Показать подсказки' }).click();
		await expect(tour).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await expect(tour).toContainText(`Шаг 1 из ${TOUR_STEPS.length}`);

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

test('подсказки возвращаются из меню учётной записи', async ({ page }) => {
	const tour = tourOf(page);

	await page.goto('/interactions');
	await waitForHydration(page);
	await expect(tour).toBeHidden();

	// Меню открывает код страницы: нажатие до того, как она ожила, теряется
	// совсем (`docs/development.md`, «Всплывающие слои»).
	const item = page.getByRole('menuitem', { name: 'Показать подсказки снова' });

	await expect(async () => {
		await page.getByRole('button', { name: 'Менеджер Демо' }).click();
		await expect(item).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await item.click();

	await expect(tour).toBeVisible();
	await expect(tour).toContainText(`Шаг 1 из ${TOUR_STEPS.length}`);
	// Тур начинается сначала, а не с того экрана, где его позвали: первый шаг
	// живёт на «Сводке» и ведёт туда ссылкой.
	await expect(tour.getByRole('link', { name: 'Открыть «Сводка»' })).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(tour).toBeHidden();
});

test('подсказка читается на телефоне и не двигает страницу', async ({ page }) => {
	await page.setViewportSize(NARROW);

	const tour = await firstVisit(page);

	await expect(tour.getByRole('heading', { level: 2 })).toHaveText(TOUR_STEPS[0]);
	await expect(tour.getByRole('button', { name: 'Пропустить' })).toBeVisible();
	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);

	await tour.getByRole('button', { name: 'Далее' }).click();
	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
});
