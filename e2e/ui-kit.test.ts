import { expect, test, type Page } from '@playwright/test';

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

test('sorting a column reorders the rows and lands in the address', async ({ page }) => {
	await page.goto('/ui-kit');

	const before = await firstRowName(page).innerText();

	await page
		.locator('thead')
		.getByRole('button', { name: /Название/ })
		.click();

	await expect(page).toHaveURL(/[?&]sort=name(&|$)/);
	await expect(firstRowName(page)).not.toHaveText(before);

	const ascending = await firstRowName(page).innerText();

	await page
		.locator('thead')
		.getByRole('button', { name: /Название/ })
		.click();

	await expect(page).toHaveURL(/[?&]sort=-name(&|$)/);
	await expect(firstRowName(page)).not.toHaveText(ascending);
});

test('paging keeps the rows in the address bar', async ({ page }) => {
	await page.goto('/ui-kit');

	await page.getByRole('button', { name: 'Следующая страница' }).click();

	await expect(page).toHaveURL(/[?&]page=2(&|$)/);
	await expect(page.locator('[data-slot="data-table"] tbody tr')).toHaveCount(15);
});

test('the form explains a wrong e-mail in words', async ({ page }) => {
	await page.goto('/ui-kit');

	await page.getByLabel('E-mail контактного лица').fill('не-почта');
	await page.getByRole('button', { name: 'Сохранить организацию' }).click();

	await expect(page.getByText('Проверьте адрес электронной почты')).toBeVisible();
});

test('navigation moves into a sheet on a phone', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/ui-kit');

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
	await rows.first().focus();
	await page.keyboard.press('j');

	await expect(rows.nth(1)).toBeFocused();

	await rows.nth(1).getByRole('checkbox').click();

	await expect(page.getByText('Выбрано: 1')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Снять с публикации' })).toBeVisible();
});

test('the search palette opens on its shortcut', async ({ page }) => {
	await page.goto('/ui-kit');
	// Give the document focus first, the way a real visitor's click would.
	await page.getByRole('heading', { level: 1 }).click();

	await page.keyboard.press('ControlOrMeta+k');

	const palette = page.getByRole('dialog');
	await expect(palette).toBeVisible();
	await expect(palette.getByText('Поиск заработает вместе с разделами.')).toBeVisible();
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
