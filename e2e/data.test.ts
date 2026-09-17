import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import type { Page } from '@playwright/test';
import { expect, leadTest as test } from './fixtures';
import { waitForHydration } from './helpers/hydration';

/**
 * Раздел «Данные» глазами руководителя: мастер загрузки из трёх шагов,
 * построчная проверка и показатели с рейтингом.
 *
 * Именно руководителя: подтверждённый снимок меняет числа всем сразу и
 * сбрасывает общий кэш дашборда, поэтому право `stats.import` у КАМа отнято
 * (`docs/access-matrix.md`, раздел 3).
 *
 * Проход заводит свой снимок и считает только его: у стенда есть сидированные
 * выгрузки за учебные годы 2025/2026 и 2026/2027, и проверка, которая смотрит
 * на них, говорила бы о том, чем заливали базу, а не о разделе. Поэтому период
 * здесь свой — 2024/2025.
 */

/** Отчётный период прохода: свой, чтобы не пересечься с данными стенда. */
const PERIOD_START = '2024-09-01';
const PERIOD_END = '2025-08-31';
const PERIOD_KEY = `${PERIOD_START}..${PERIOD_END}`;

/**
 * Период прохода по JSON — тоже свой. Снимок за тот же период вытеснил бы
 * снимок соседнего прохода: полная выгрузка замещает прежнюю, и два прохода
 * стали бы зависеть от порядка запуска.
 */
const JSON_PERIOD = { start: '2023-09-01', end: '2024-08-31' } as const;

/** День так, как его пишут в поле даты: `2024-09-01` → `01.09.2024`. */
function ruDay(iso: string): string {
	const [year, month, day] = iso.split('-');

	return `${day}.${month}.${year}`;
}

/** Метка прогона: делает название файла уникальным в общей базе. */
const TAG = crypto.randomUUID().slice(0, 8);

const FIXTURE = new URL('./fixtures/stats-sample.csv', import.meta.url).pathname;
/** Та же выгрузка, но JSON: объект со списком строк по ключу `rows`. */
const JSON_FIXTURE = new URL('./fixtures/stats-sample.json', import.meta.url).pathname;

/**
 * Книга XLSX собирается в памяти прогоном: двоичный файл в репозитории нельзя
 * ни прочитать глазами, ни сравнить в истории, а проверить второй формат
 * импорта нужно.
 */
async function workbookBytes(): Promise<Buffer> {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet('Выгрузка');

	sheet.addRow(['Вуз', 'Код программы', 'Подано заявок', 'Зачислено']);
	sheet.addRow(['СЗПУ', 'VO-BAK-01', 64, 48]);
	sheet.addRow(['ПУПИ', 'VO-MAG-01', 21, 15]);

	return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Шаг 1 мастера: файл, режим и период. */
async function uploadFile(
	page: Page,
	file: { name: string; mimeType: string; buffer: Buffer },
	period: { start: string; end: string } = { start: PERIOD_START, end: PERIOD_END }
): Promise<void> {
	await page.goto('/data');
	await page.getByRole('link', { name: 'Загрузить файл' }).click();
	await expect(page.getByRole('heading', { name: 'Загрузка данных' })).toBeVisible();

	// Значение поля даты держит компонент: до того, как страница ожила, набранное
	// остаётся в разметке, а в скрытое поле формы не попадает — и повторный ввод
	// этого уже не исправит.
	await waitForHydration(page);

	await page.locator('input[name="file"]').setInputFiles(file);
	// Поле даты — своё (`DateField`): человек пишет `01.09.2024`, а форме
	// уходит `2024-09-01` скрытым полем.
	await page.locator('#periodStart').fill(ruDay(period.start));
	await page.locator('#periodEnd').fill(ruDay(period.end));
	await expect(page.locator('input[name="periodStart"]')).toHaveValue(period.start);
	await expect(page.locator('input[name="periodEnd"]')).toHaveValue(period.end);
	await page.getByRole('button', { name: 'Дальше: сопоставление колонок' }).click();

	await expect(page.getByRole('heading', { name: 'Сопоставление колонок' })).toBeVisible();
}

test('раздел «Данные» есть в меню и показывает сидированные снимки', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('link', { name: 'Данные', exact: true }).first().click();

	await expect(page.getByRole('heading', { name: 'Данные об обучении' })).toBeVisible();
	// На стенде уже есть подтверждённые выгрузки: раздел не открывается пустым.
	await expect(page.locator('[data-slot="data-table"] tbody tr[data-row]').first()).toBeVisible();
	await expect(page.getByText('Подтверждён').first()).toBeVisible();
});

test('руководитель проходит мастер до подтверждения и видит показатели', async ({ page }) => {
	await uploadFile(page, {
		name: `выгрузка-${TAG}.csv`,
		mimeType: 'text/csv',
		buffer: await readFile(FIXTURE)
	});

	// Шаг 2: колонки сопоставлены подсказкой, человеку остаётся согласиться.
	await expect(page.getByText('Предложено').first()).toBeVisible();
	await expect(page.getByText('Подано заявок').first()).toBeVisible();
	await page.getByRole('button', { name: 'Дальше: проверка строк' }).click();

	// Шаг 3: четыре строки файла, одна из них не разобралась.
	await expect(page.getByRole('heading', { name: 'Проверка загрузки' })).toBeVisible();
	await expect(page.locator('tbody tr[data-row-no]')).toHaveCount(4);

	await page.getByRole('link', { name: 'Только с ошибками' }).click();
	await expect(page.locator('tbody tr[data-row-no]')).toHaveCount(1);
	await expect(page.getByText('не найдена в справочнике')).toBeVisible();

	await page.getByRole('button', { name: 'Подтвердить снимок' }).click();

	// Карточка снимка: он подтверждён и учитывается в показателях.
	await expect(page.getByRole('heading', { name: /Снимок данных/ })).toBeVisible();
	await expect(
		page.locator('[data-slot="status-badge"]', { hasText: 'Подтверждён' })
	).toBeVisible();
	await expect(page.locator('[data-slot="status-badge"]', { hasText: 'Текущий' })).toBeVisible();

	// Показатели за тот же период: числа из файла, а не из сидированных выгрузок.
	await page.goto(`/data/indicators?period=${PERIOD_KEY}`);
	await expect(page.getByRole('heading', { name: 'Показатели' })).toBeVisible();

	const applications = page.locator('[data-slot="data-table"] tbody tr[data-row]', {
		hasText: 'VO-BAK-01'
	});

	await expect(applications).toContainText('180');
	// Ноль записан нулём, а не прочерком: строка про СПО в файле нулевая.
	await expect(
		page.locator('[data-slot="data-table"] tbody tr[data-row]', { hasText: 'SPO-01' })
	).toContainText('0');

	// Рейтинг объясняет порядок: у каждой программы разложение по слагаемым.
	await page.goto(`/data/indicators?period=${PERIOD_KEY}&tab=ranking`);
	await expect(page.getByRole('columnheader', { name: 'Почему' })).toBeVisible();

	const breakdown = page.locator('[data-slot="score-breakdown"]').first();

	await expect(breakdown).toContainText('Заявки');
	await expect(breakdown).toContainText('Зачислено');
	await expect(breakdown).toContainText('Параллельные потоки');

	// Слагаемые переносятся внутри своей колонки: таблица рейтинга целиком
	// помещается в отведённую ширину и вбок не уезжает.
	const hidden = await page.evaluate(() => {
		const box = document.querySelector('[data-slot="score-breakdown"]')?.closest('div');

		return box === null || box === undefined ? null : box.scrollWidth - box.clientWidth;
	});

	expect(hidden).toBe(0);
});

test('мастер читает и книгу XLSX', async ({ page }) => {
	await uploadFile(page, {
		name: `выгрузка-${TAG}.xlsx`,
		mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		buffer: await workbookBytes()
	});

	// Разбор книги виден по превью значений рядом с колонкой.
	await expect(page.getByText('Предложено').first()).toBeVisible();
	await expect(page.getByText('СЗПУ · ПУПИ')).toBeVisible();
	await expect(page.getByText('В файле: 2 строки')).toBeVisible();
});

test('мастер читает JSON и доводит его до подтверждения', async ({ page }) => {
	await uploadFile(
		page,
		{
			name: `выгрузка-${TAG}.json`,
			mimeType: 'application/json',
			buffer: await readFile(JSON_FIXTURE)
		},
		JSON_PERIOD
	);

	// Мастер говорит, чем он счёл файл: ключи JSON стали колонками.
	await expect(page.locator('[data-slot="file-summary"]')).toContainText('прочитан как JSON');
	await expect(page.getByText('Предложено').first()).toBeVisible();
	await expect(page.getByText('В файле: 4 строки')).toBeVisible();
	await page.getByRole('button', { name: 'Дальше: проверка строк' }).click();

	// Дальше — тот же путь, что у таблицы: строки, претензия к неизвестному вузу
	// и подтверждение.
	await expect(page.getByRole('heading', { name: 'Проверка загрузки' })).toBeVisible();
	await expect(page.locator('tbody tr[data-row-no]')).toHaveCount(4);
	await expect(page.getByText('не найдена в справочнике')).toBeVisible();

	await page.getByRole('button', { name: 'Подтвердить снимок' }).click();

	await expect(
		page.locator('[data-slot="status-badge"]', { hasText: 'Подтверждён' })
	).toBeVisible();

	await page.goto(`/data/indicators?period=${JSON_PERIOD.start}..${JSON_PERIOD.end}`);
	await expect(
		page.locator('[data-slot="data-table"] tbody tr[data-row]', { hasText: 'VO-BAK-01' })
	).toContainText('180');
});
