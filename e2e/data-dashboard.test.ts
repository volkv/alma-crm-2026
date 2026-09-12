import { expect, test } from './fixtures';

/**
 * Дашборд портфеля данных глазами менеджера.
 *
 * Проход смотрит на сидированные снимки стенда и потому не называет точных
 * чисел: рядом идут другие проверки, которые заводят свои загрузки. Проверяется
 * то, что от дашборда требуется всегда, — период в адресе, разница между нулём
 * и отсутствием данных, объяснение порядка программ, происхождение чисел и
 * выгрузка тем же периодом.
 */

/** Период стенда, на который дашборд открывается сам: он самый поздний. */
const PERIOD_KEY = '2026-09-01..2027-08-31';

/** Число из ячейки таблицы; `null` — прочерк, то есть данных нет. */
function toNumber(text: string): number | null {
	const digits = text.replace(/[^\d]/g, '');

	return digits === '' ? null : Number(digits);
}

test('раздел «Данные» ведёт на дашборд, и тот открывается на последнем периоде', async ({
	page
}) => {
	await page.goto('/data');
	await page.getByRole('link', { name: 'Дашборд', exact: true }).click();

	await expect(page.getByRole('heading', { name: 'Дашборд данных' })).toBeVisible();
	// Период всегда в адресе: дашборд — это ссылка, а не состояние экрана.
	await expect(page).toHaveURL(new RegExp(`period=${PERIOD_KEY.replace('..', '\\.\\.')}`));

	const tiles = page.locator('[data-slot="dashboard-tiles"] > div');

	await expect(tiles).toHaveCount(6);
	await expect(tiles.first()).toContainText('Программы');
});

test('плитки отличают записанный ноль от отсутствия данных', async ({ page }) => {
	await page.goto(`/data/dashboard?period=${PERIOD_KEY}`);

	const enrolled = page.locator('[data-slot="dashboard-tiles"] > div', {
		hasText: 'Обучающиеся'
	});

	// Учебный год ещё идёт: сколько человек завершит обучение — неизвестно, и
	// это прочерк с подписью, а не ноль.
	await expect(enrolled).toContainText('завершили обучение: — нет данных');
	await expect(enrolled).not.toContainText('завершили обучение: 0');
});

test('дашборд объясняет порядок программ и ведёт в показатели', async ({ page }) => {
	await page.goto(`/data/dashboard?period=${PERIOD_KEY}`);

	const breakdown = page.locator('[data-slot="score-breakdown"]').first();

	await expect(breakdown).toContainText('Заявки');
	await expect(breakdown).toContainText('Параллельные потоки');

	await page.locator('[data-program] a').first().click();

	await expect(page.getByRole('heading', { name: 'Показатели' })).toBeVisible();
	await expect(page).toHaveURL(/programId=/);
});

test('распределение по вузам сортируется, и порядок живёт в адресе', async ({ page }) => {
	await page.goto(`/data/dashboard?period=${PERIOD_KEY}`);

	const rows = page.locator('tr[data-organization]');

	await expect(rows.first()).toBeVisible();
	await page.locator('a[data-sort="applications"]').click();

	await expect(page).toHaveURL(/sort=-applications/);

	const cells = await rows.locator('td:nth-child(3)').allInnerTexts();
	const numbers = cells.map(toNumber).filter((value): value is number => value !== null);

	expect(numbers.length).toBeGreaterThan(1);
	expect([...numbers].sort((left, right) => right - left)).toStrictEqual(numbers);
});

test('происхождение называет снимок, из которого сложились числа', async ({ page }) => {
	await page.goto(`/data/dashboard?period=${PERIOD_KEY}`);

	const origin = page.locator('section', { hasText: 'Происхождение' }).last();

	await expect(origin).toContainText('Файл');
	await expect(origin).toContainText('Полный');

	await origin.locator('tbody a').first().click();

	await expect(page.getByRole('heading', { name: /Снимок данных/ })).toBeVisible();
	await expect(
		page.locator('[data-slot="status-badge"]', { hasText: 'Подтверждён' })
	).toBeVisible();
});

test('отчёт выгружается книгой, названной периодом и днём выгрузки', async ({ page }) => {
	await page.goto(`/data/dashboard?period=${PERIOD_KEY}`);

	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByTestId('export-report').click()
	]);

	const name = download.suggestedFilename();

	expect(name).toContain('2026-09-01');
	expect(name).toContain('2027-08-31');
	expect(name.endsWith('.xlsx')).toBe(true);
});

test('на узком экране плитки становятся в две колонки', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/data/dashboard?period=${PERIOD_KEY}`);

	const tiles = page.locator('[data-slot="dashboard-tiles"] > div');
	const first = await tiles.nth(0).boundingBox();
	const second = await tiles.nth(1).boundingBox();
	const third = await tiles.nth(2).boundingBox();

	expect(first).not.toBeNull();
	expect(second?.x).toBeGreaterThan(first?.x ?? 0);
	// Третья плитка начинает вторую строку: значит, колонок ровно две.
	expect(third?.x).toBe(first?.x);
	expect(third?.y).toBeGreaterThan(first?.y ?? 0);

	// Таблицы на узком экране прокручиваются вбок, а не ломают страницу.
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth <= window.innerWidth
	);

	expect(overflow).toBe(true);
});
