import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { waitForHydration } from './helpers/hydration';

/**
 * Экран телефона против шапки страницы.
 *
 * Таблица, доска или длинная строка имеют право прокручиваться внутри себя;
 * документ целиком — нет: страница, уехавшая вбок, болтается на телефоне вся,
 * вместе с шапкой и навигацией. Поэтому меряется корень документа, а не
 * отдельный блок, и меряется там, где рядом с заголовком стоят кнопки, бейджи и
 * фильтры: они и есть то, что распирает страницу, когда ей нечем сузиться.
 */

/** Экран телефона; та же ширина, что и в остальных узких проходах. */
const NARROW = { width: 390, height: 844 } as const;

/** Период стенда, за который есть подтверждённые данные. */
const PERIOD_KEY = '2026-09-01..2027-08-31';

/** Период загрузки этого прохода: свой, чтобы не пересечься с данными стенда. */
const UPLOAD_PERIOD = { start: '2023-09-01', end: '2024-08-31' } as const;

const FIXTURE = new URL('./fixtures/stats-sample.csv', import.meta.url).pathname;

/** Метка прогона: делает название файла уникальным в общей базе. */
const TAG = crypto.randomUUID().slice(0, 8);

/** День так, как его пишут в поле даты: `2023-09-01` → `01.09.2023`. */
function ruDay(iso: string): string {
	const [year, month, day] = iso.split('-');

	return `${day}.${month}.${year}`;
}

/** Насколько документ шире экрана. Ноль и меньше — помещается. */
async function documentOverflow(page: Page): Promise<number> {
	return page.evaluate(() => {
		const root = document.documentElement;

		return root.scrollWidth - root.clientWidth;
	});
}

test('карточка загруженного снимка держит ширину телефона', async ({ page }) => {
	await page.setViewportSize(NARROW);

	// Снимок заводится загрузкой, а не берётся у стенда: у сидированных снимков
	// файла нет, а именно файл добавляет в шапку кнопку «Скачать файл» — рядом с
	// бейджем состояния и кнопкой следующего шага. Три элемента в ряд и есть тот
	// набор, который на телефоне не помещается.
	await page.goto('/data/new');
	// Значение поля даты держит компонент: набранное до того, как страница ожила,
	// остаётся в разметке и в скрытое поле формы не попадает.
	await waitForHydration(page);

	await page.locator('input[name="file"]').setInputFiles({
		name: `ширина-${TAG}.csv`,
		mimeType: 'text/csv',
		buffer: await readFile(FIXTURE)
	});
	// Поле даты — своё (`DateField`): человек пишет `01.09.2023`, а форме уходит
	// `2023-09-01` скрытым полем.
	await page.locator('#periodStart').fill(ruDay(UPLOAD_PERIOD.start));
	await page.locator('#periodEnd').fill(ruDay(UPLOAD_PERIOD.end));
	await expect(page.locator('input[name="periodStart"]')).toHaveValue(UPLOAD_PERIOD.start);
	await expect(page.locator('input[name="periodEnd"]')).toHaveValue(UPLOAD_PERIOD.end);
	await page.getByRole('button', { name: 'Дальше: сопоставление колонок' }).click();
	await expect(page.getByRole('heading', { name: 'Сопоставление колонок' })).toBeVisible();

	const [, , id] = new URL(page.url()).pathname.split('/');

	await page.goto(`/data/${id}`);
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Снимок данных');
	await expect(page.getByRole('link', { name: 'Скачать файл' })).toBeVisible();

	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
});

test('показатели с выбранным периодом держат ширину телефона', async ({ page }) => {
	await page.setViewportSize(NARROW);
	await page.goto(`/data/indicators?period=${PERIOD_KEY}`);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Показатели');

	const trigger = page.locator('#filter-period');

	// Метка выбранного периода длиннее экрана: «Учебный год: 01.09.2026 —
	// 31.08.2027» не помещается в 390 точек ни при каком кегле.
	await expect(trigger).toContainText('Учебный год');

	const box = await trigger.boundingBox();

	if (box === null) {
		throw new Error('фильтр периода обязан быть на экране');
	}

	// Отдельно от общей меры: страницу тут распирали двое — фильтр и список
	// вкладок, — и по одному документу не видно, который из них вернулся.
	expect(box.x + box.width).toBeLessThanOrEqual(NARROW.width);
	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
});
