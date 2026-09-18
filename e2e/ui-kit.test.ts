import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { waitForHydration } from './helpers/hydration';

/**
 * The kit page is where every shared component is on screen at once, so it is
 * also the cheapest place to check that the three mechanisms the whole product
 * leans on still work: a list whose state lives in the URL, a form that reports
 * errors in words, and navigation that survives a phone-sized screen.
 */

const firstRowName = (page: Page) =>
	page.locator('[data-slot="data-table"] tbody tr').first().locator('td').nth(1);

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

test('the kit page is captured for review', async ({ page }) => {
	await page.goto('/ui-kit');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await page.screenshot({ path: 'test-results/ui-kit-desktop.png', fullPage: true });

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/ui-kit');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await page.screenshot({ path: 'test-results/ui-kit-mobile.png', fullPage: true });
});
