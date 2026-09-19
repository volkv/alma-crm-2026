import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { pointerlessControls } from './helpers/cursor';
import { waitForHydration } from './helpers/hydration';

/**
 * The kit page is where every shared component is on screen at once, so it is
 * also the cheapest place to check that the three mechanisms the whole product
 * leans on still work: a list whose state lives in the URL, a form that reports
 * errors in words, and navigation that survives a phone-sized screen.
 */

const firstRowName = (page: Page) =>
	page.locator('[data-slot="data-table"] tbody tr').first().locator('td').nth(1);

/**
 * Кнопка темы. Переключателей на странице два — в шапке оболочки и на самой
 * витрине, — и это часть проверяемого: выбор один на документ, поэтому нажатие
 * по любому из них обязано отозваться в обоих.
 */
const themeOption = (page: Page, option: 'light' | 'dark' | 'system') =>
	page.locator(`[data-slot="theme-toggle"] [data-theme-option="${option}"]`).first();

/**
 * Выбрать тему и дождаться, пока она встанет.
 *
 * Переключатель — код страницы: нажатие до оживления не доходит ни до кого.
 * Повтор идёт только пока тема не та, которую просили: лишнее нажатие по другой
 * кнопке её бы сменило.
 */
async function chooseTheme(page: Page, option: 'light' | 'dark' | 'system'): Promise<void> {
	await expect(async () => {
		if ((await themeOption(page, option).getAttribute('aria-pressed')) !== 'true') {
			await themeOption(page, option).click({ timeout: 5_000 });
		}

		await expect(themeOption(page, option)).toHaveAttribute('aria-pressed', 'true', {
			timeout: 2000
		});
	}).toPass({ timeout: 20_000 });
}

/** Цвет, которым покрашена страница на самом деле, а не по замыслу темы. */
const pageBackground = (page: Page) =>
	page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/** Сумма каналов `rgb(r, g, b)`: светлее или темнее — без разбора оттенка. */
function brightness(color: string): number {
	const channels = color.match(/\d+(\.\d+)?/g);

	if (channels === null || channels.length < 3) {
		throw new Error(`цвет фона ожидался как rgb(...), получено «${color}»`);
	}

	return channels.slice(0, 3).reduce((sum, value) => sum + Number(value), 0);
}

test('the kit page opens with the table and the form on it', async ({ page }) => {
	await page.goto('/ui-kit');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('UI-кит');
	await expect(page.locator('[data-slot="data-table"] tbody tr')).toHaveCount(25);
	await expect(page.getByRole('button', { name: 'Сохранить организацию' })).toBeVisible();
});

/**
 * Sorting, like paging, is the page's own code (`onclick` → `go`): a press
 * before hydration reaches nobody and is lost for good. Press until the address
 * carries the order asked for, and only while it does not — a press too many
 * would turn the order back.
 */
async function sortByName(page: Page, expected: RegExp): Promise<void> {
	const header = page.locator('thead').getByRole('button', { name: /Название/ });

	await expect(async () => {
		if (!expected.test(page.url())) {
			await header.click({ timeout: 5_000 });
		}

		await expect(page).toHaveURL(expected, { timeout: 2000 });
	}).toPass({ timeout: 20_000 });
}

test('sorting a column reorders the rows and lands in the address', async ({ page }) => {
	await page.goto('/ui-kit');

	const before = await firstRowName(page).innerText();

	await sortByName(page, /[?&]sort=name(&|$)/);
	await expect(firstRowName(page)).not.toHaveText(before);

	const ascending = await firstRowName(page).innerText();

	await sortByName(page, /[?&]sort=-name(&|$)/);
	await expect(firstRowName(page)).not.toHaveText(ascending);
});

test('paging keeps the rows in the address bar', async ({ page }) => {
	await page.goto('/ui-kit');

	// Paging is the page's own code (`onclick` → `go`), so a press before
	// hydration never reaches the component and is lost for good — retry, as with
	// every other control the page owns. A page already on 2 is not pressed
	// again: that would carry it to 3.
	await expect(async () => {
		if (!/[?&]page=2(&|$)/.test(page.url())) {
			await page.getByRole('button', { name: 'Следующая страница' }).click({ timeout: 5_000 });
		}

		await expect(page).toHaveURL(/[?&]page=2(&|$)/, { timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await expect(page.locator('[data-slot="data-table"] tbody tr')).toHaveCount(15);
});

test('the form explains a wrong e-mail in words', async ({ page }) => {
	await page.goto('/ui-kit');

	await page.getByLabel('E-mail контактного лица').fill('не-почта');
	await page.getByRole('button', { name: 'Сохранить организацию' }).click();

	await expect(page.getByText('Проверьте адрес электронной почты')).toBeVisible();
});

test('a date is typed in the Russian order and picked from the same popover layer', async ({
	page
}) => {
	await page.goto('/ui-kit');

	const field = page.getByLabel('Дата', { exact: true });
	await expect(field).toHaveValue('12.09.2026');

	const calendar = page.locator('[data-slot="popover-content"]');
	const grid = calendar.getByRole('grid');

	// Both halves of this need a live page, and for the same reason. Text put
	// into the input before hydration stays in the DOM but never runs the
	// component's `oninput`, so the component keeps the date it was rendered
	// with — and the calendar, which reads that date, would open on September.
	// The trigger is the page's own code too, and it toggles. So: retype and
	// reopen until the calendar agrees with what was typed, pressing only while
	// it is closed.
	await expect(async () => {
		await field.fill('01.03.2027');
		await expect(field).toHaveValue('01.03.2027', { timeout: 2000 });

		if (!(await grid.isVisible())) {
			await page.getByRole('button', { name: 'Открыть календарь' }).first().click({
				timeout: 5_000
			});
		}

		await expect(grid).toBeVisible({ timeout: 2000 });
		// The calendar opens on the month of the value and names it in Russian.
		await expect(calendar).toContainText(/март/i, { timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await grid.getByText('15', { exact: true }).click();

	await expect(field).toHaveValue('15.03.2027');

	await page.getByRole('button', { name: 'Очистить дату' }).first().click();
	await expect(field).toHaveValue('');
});

/**
 * Выбор из закрытого списка — это пара «кнопка и список», и ARIA называет её
 * `combobox`. Роль здесь не украшение: по ней выбор находят и вспомогательные
 * технологии, и проверки, а `aria-controls` у открытого списка говорит, какой
 * именно список открыт этой кнопкой.
 */
test('a select is found by its combobox role and names the list it opens', async ({ page }) => {
	await page.goto('/ui-kit');

	const region = page.getByRole('combobox', { name: 'Регион' });

	await expect(region).toBeVisible();
	await expect(region).toHaveAttribute('aria-expanded', 'false');

	const list = page.getByRole('listbox');

	// The list is opened by the page's own code, and the trigger toggles it: a
	// press before hydration is lost for good, and a press too many closes what
	// the first one opened. Retry, but only while the list is closed.
	await expect(async () => {
		if (!(await list.isVisible())) {
			await region.click({ timeout: 5_000 });
		}

		await expect(list).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await expect(region).toHaveAttribute('aria-expanded', 'true');

	const controls = await region.getAttribute('aria-controls');

	expect(controls).not.toBeNull();
	await expect(list).toHaveAttribute('id', controls ?? '');
});

test('navigation moves into a sheet on a phone', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/ui-kit');
	// The sheet is opened by the page's own code, and the button toggles it, so a
	// press cannot be repeated until it works: a second one would close what the
	// first opened. Wait for the page to come alive instead, then press once.
	await waitForHydration(page);

	// The sidebar is still in the markup at this width, only hidden by CSS.
	await expect(page.getByRole('dialog')).toHaveCount(0);

	await page.getByRole('button', { name: 'Разделы' }).click();

	const sheet = page.getByRole('dialog');
	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole('link', { name: 'Организации' })).toBeVisible();
});

/**
 * Ссылка «к содержимому»: от начала страницы до таблицы иначе больше десяти
 * нажатий Tab через всё меню, и так на каждой странице раздела. Ссылка — первое,
 * до чего доходит Tab, и она видна, как только получает фокус.
 */
test('the first tab stop is the skip link and it moves focus to the page', async ({ page }) => {
	await page.goto('/ui-kit');

	const skip = page.getByRole('link', { name: 'К содержимому' });

	// Tab нажимается по свежей странице, без клика: клик ставит точку отсчёта
	// обхода на то, по чему кликнули, и следующий Tab идёт уже от неё, а не от
	// начала документа. Фокус ведёт браузер, а не код страницы, — ждать
	// гидратации и повторять нажатие незачем.
	await page.keyboard.press('Tab');

	await expect(skip).toBeFocused();
	await expect(skip).toBeVisible();

	await page.keyboard.press('Enter');

	await expect(page.locator('#page-content')).toBeFocused();
});

test('rows answer the keyboard and selection opens the bulk bar', async ({ page }) => {
	await page.goto('/ui-kit');

	const rows = page.locator('[data-slot="data-table"] tbody tr[data-row]');

	// The key is handled by the page's own code: pressed before hydration it
	// reaches nobody. Retry until the focus moves, and press only while it has
	// not — a second `j` would carry the focus one row further.
	await expect(async () => {
		if (!(await rows.nth(1).evaluate((row) => row === document.activeElement))) {
			await rows.first().focus();
			await page.keyboard.press('j');
		}

		await expect(rows.nth(1)).toBeFocused({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await rows.nth(1).getByRole('checkbox').click();

	await expect(page.getByText('Выбрано: 1')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Снять с публикации' })).toBeVisible();
});

test('the search palette opens on its shortcut and offers the sections', async ({ page }) => {
	await page.goto('/ui-kit');
	// Give the document focus first, the way a real visitor's click would.
	await page.getByRole('heading', { level: 1 }).click();

	const palette = page.getByRole('dialog');

	// The shortcut is the page's own handler, and a key pressed before hydration
	// is lost. Retry, but only while the palette is closed: the same shortcut
	// closes it again.
	await expect(async () => {
		if (!(await palette.isVisible())) {
			await page.keyboard.press('ControlOrMeta+k');
		}

		await expect(palette).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	// An empty query is the table of contents: the palette offers the sections
	// this account may open — the same list the sidebar shows — so the shortcut
	// leads somewhere before a single letter is typed.
	await expect(palette.getByPlaceholder('Что ищем?')).toBeVisible();
	await expect(palette.getByRole('option', { name: 'Взаимодействия' })).toBeVisible();
});

test('collapsing the navigation outlives a reload', async ({ page }) => {
	await page.goto('/ui-kit');

	await page.getByRole('button', { name: 'Свернуть навигацию' }).click();
	await page.reload();

	await expect(page.getByRole('button', { name: 'Развернуть навигацию' })).toBeVisible();
});

/**
 * Пары «текст на фоне», которые тема обязана держать читаемыми. Слева токен
 * текста, справа — токен того, на чём этот текст лежит; порог AA для текста
 * 14px, которым набран весь продукт, — 4.5:1.
 *
 * Пары взяты не наугад: это ровно то, из чего собраны экраны, — текст трёх
 * степеней громкости на трёх поверхностях, подпись на акцентной заливке, ссылка,
 * бейдж каждого статуса и подпись на сплошном узле маршрута.
 */
const CONTRAST_PAIRS = [
	['--color-foreground', '--color-surface'],
	['--color-foreground', '--color-canvas'],
	['--color-foreground', '--color-surface-muted'],
	['--color-foreground', '--color-popover'],
	['--color-muted-foreground', '--color-surface'],
	['--color-muted-foreground', '--color-surface-muted'],
	['--color-faint', '--color-surface'],
	['--color-faint', '--color-canvas'],
	['--color-primary-foreground', '--color-primary'],
	['--color-primary-foreground', '--color-primary-hover'],
	['--color-primary', '--color-surface'],
	['--color-primary', '--color-primary-soft'],
	['--color-success-soft-foreground', '--color-success-soft'],
	['--color-background', '--color-success'],
	['--color-warning-soft-foreground', '--color-warning-soft'],
	['--color-warning-soft-foreground', '--color-surface'],
	['--color-danger-soft-foreground', '--color-danger-soft'],
	['--color-background', '--color-danger'],
	['--color-info-soft-foreground', '--color-info-soft']
] as const;

/**
 * Контраст пар по WCAG 2.1, посчитанный по значениям токенов так, как их видит
 * браузер: `getComputedStyle` возвращает custom property уже с подставленными
 * `var(...)`, то есть итоговый цвет темы, а не ссылку на ссылку.
 */
async function contrastRatios(page: Page): Promise<{ pair: string; ratio: number }[]> {
	return page.evaluate(
		(pairs) => {
			const styles = getComputedStyle(document.documentElement);

			const luminance = (token: string): number => {
				const value = styles.getPropertyValue(token).trim();
				const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);

				if (hex === null) {
					throw new Error(`токен ${token} ожидался цветом в hex, получено «${value}»`);
				}

				const digits =
					hex[1].length === 3
						? [...hex[1]].map((digit) => digit + digit)
						: [hex[1].slice(0, 2), hex[1].slice(2, 4), hex[1].slice(4, 6)];
				const [red, green, blue] = digits.map((pair) => {
					const channel = Number.parseInt(pair, 16) / 255;

					return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
				});

				return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
			};

			return pairs.map(([text, background]) => {
				const [lighter, darker] = [luminance(text), luminance(background)].sort((a, b) => b - a);

				return { pair: `${text} на ${background}`, ratio: (lighter + 0.05) / (darker + 0.05) };
			});
		},
		CONTRAST_PAIRS as unknown as [string, string][]
	);
}

test('тема по умолчанию светлая, а выбранная тёмная переживает перезагрузку', async ({ page }) => {
	await page.goto('/ui-kit');

	const root = page.locator('html');

	// Умолчание — светлая, и это решение, а не случайность: показ продукта идёт
	// на светлом, а тёмную человек выбирает себе сам.
	await expect(root).toHaveAttribute('data-theme', 'light');
	await expect(themeOption(page, 'light')).toHaveAttribute('aria-pressed', 'true');

	const light = await pageBackground(page);

	await chooseTheme(page, 'dark');

	await expect(root).toHaveAttribute('data-theme', 'dark');

	const dark = await pageBackground(page);

	expect(dark).not.toBe(light);
	expect(brightness(dark)).toBeLessThan(brightness(light));

	// Выбор один на документ: нажали в шапке — отозвалось и на витрине.
	await expect(page.locator('[data-theme-option="dark"][aria-pressed="true"]')).toHaveCount(2);

	await page.reload();

	// Тема стоит уже в первом кадре: её ставит скрипт в <head>, а не оживший
	// компонент, — иначе каждая загрузка начиналась бы вспышкой белого.
	await expect(root).toHaveAttribute('data-theme', 'dark');
	expect(await pageBackground(page)).toBe(dark);
	await expect(themeOption(page, 'dark')).toHaveAttribute('aria-pressed', 'true');
});

test('тёмная тема встаёт до того, как страница оживёт', async ({ page }) => {
	await page.goto('/ui-kit');
	await chooseTheme(page, 'dark');

	// Код приложения на следующей загрузке не приедет вовсе: остаются только
	// разметка с сервера и скрипт темы в <head>. Если атрибут после этого на
	// месте, значит тему ставит он, а не ожившие компоненты, — то есть первый
	// кадр уже тёмный и вспышки белого не будет. Заодно это проверка того, что
	// скрипт проходит CSP: заблокированный браузером, он не поставил бы ничего.
	await page.route('**/_app/immutable/**', (route) => route.abort());
	await page.goto('/ui-kit');

	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	// Компоненты и правда не ожили: кнопка темы осталась там, где её отрисовал
	// сервер, — с умолчанием, а не с выбором.
	await expect(themeOption(page, 'light')).toHaveAttribute('aria-pressed', 'true');
});

test('«как в системе» идёт за настройкой браузера', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.goto('/ui-kit');

	const root = page.locator('html');

	// Пока выбрана светлая, тёмная система ничего не решает: выбор человека
	// главнее настройки машины.
	await expect(root).toHaveAttribute('data-theme', 'light');

	await chooseTheme(page, 'system');
	await expect(root).toHaveAttribute('data-theme', 'dark');

	// Систему переключают при открытой вкладке — по расписанию дня, например.
	await page.emulateMedia({ colorScheme: 'light' });
	await expect(root).toHaveAttribute('data-theme', 'light');

	// И то же самое на следующей загрузке: выбор «как в системе» тоже запомнен.
	await page.reload();
	await expect(root).toHaveAttribute('data-theme', 'light');
	await expect(themeOption(page, 'system')).toHaveAttribute('aria-pressed', 'true');

	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(root).toHaveAttribute('data-theme', 'dark');
});

test('текст читается в обеих темах: контраст не ниже AA', async ({ page }) => {
	await page.goto('/ui-kit');

	for (const option of ['light', 'dark'] as const) {
		await chooseTheme(page, option);

		const measured = await contrastRatios(page);

		expect(measured).toHaveLength(CONTRAST_PAIRS.length);

		for (const { pair, ratio } of measured) {
			expect.soft(ratio, `${option}: ${pair} — ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
		}
	}
});

test('над нажимаемым курсор — «палец»: витрина целиком', async ({ page }) => {
	await page.goto('/ui-kit');

	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

	// Витрина держит на одном экране всё, из чего собраны остальные: кнопки всех
	// видов и размеров, поля, переключатели, вкладки, таблицу с сортировкой и
	// страницами, оболочку с меню разделов. Одна проверка здесь стоит обхода
	// десятка экранов.
	expect(await pointerlessControls(page)).toEqual([]);
});

test('«палец» доходит и до слоёв поверх страницы: меню, список выбора, палитра', async ({
	page
}) => {
	await page.goto('/ui-kit');

	// Слои рисуются в конце документа, отдельно от страницы, и наследовать её
	// правила не могут — каждый проверяется открытым.
	const menu = page.locator('[data-slot="dropdown-menu-content"]');

	// Открывает слой код страницы, и кнопка его переключает: нажатие до оживления
	// пропадает, лишнее — закрывает открытое. Отсюда повтор только пока закрыто.
	await expect(async () => {
		if (!(await menu.isVisible())) {
			await page.locator('[data-tour="user-menu"]').click({ timeout: 5_000 });
		}

		await expect(menu).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	expect(await pointerlessControls(page, '[data-slot="dropdown-menu-content"]')).toEqual([]);

	await page.keyboard.press('Escape');

	const list = page.locator('[data-slot="select-content"]');

	await expect(async () => {
		if (!(await list.isVisible())) {
			await page.getByRole('combobox', { name: 'Регион' }).click({ timeout: 5_000 });
		}

		await expect(list).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	expect(await pointerlessControls(page, '[data-slot="select-content"]')).toEqual([]);

	await page.keyboard.press('Escape');

	const palette = page.getByRole('dialog');

	await expect(async () => {
		if (!(await palette.isVisible())) {
			await page.keyboard.press('ControlOrMeta+k');
		}

		await expect(palette.getByRole('option', { name: 'Взаимодействия' })).toBeVisible({
			timeout: 2000
		});
	}).toPass({ timeout: 20_000 });

	expect(await pointerlessControls(page, '[data-slot="dialog-content"]')).toEqual([]);
});

test('the kit page is captured for review', async ({ page }) => {
	await page.goto('/ui-kit');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await page.screenshot({ path: 'test-results/ui-kit-desktop.png', fullPage: true });

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/ui-kit');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await page.screenshot({ path: 'test-results/ui-kit-mobile.png', fullPage: true });

	// Тёмная тема — это те же экраны другими значениями токенов, и смотреть на
	// них надо так же глазами, а не только мерить контраст числом.
	await page.setViewportSize({ width: 1280, height: 800 });
	await chooseTheme(page, 'dark');
	await page.screenshot({ path: 'test-results/ui-kit-dark.png', fullPage: true });
});
