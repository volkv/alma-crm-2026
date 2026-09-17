import { stat } from 'node:fs/promises';
import { expect, test } from './fixtures';
import { waitForHydration } from './helpers/hydration';

/**
 * Раздел отчётов глазами человека: режим, набор колонок, выгрузка и клик по
 * диаграмме.
 *
 * Числа здесь не утверждаются: база прогона общая и залита набором стенда, а
 * эталонные числа проверяет `tests/integration/reports`. Проверяется то, чего
 * не видно ни одному другому тесту, — что экран действительно ссылка: смена
 * режима и набора колонок попадает в адрес, файл скачивается, а клик по
 * столбцу сужает выборку.
 */

const SNAPSHOT_RULE = 'Каждое взаимодействие показано в той стадии';
const MOVEMENT_RULE = 'Каждая строка — один переход';

test('раздел открывается срезом и объясняет правило словами', async ({ page }) => {
	await page.goto('/reports');

	await expect(page.getByRole('heading', { name: 'Отчёты по взаимодействиям' })).toBeVisible();
	await expect(page.getByText(SNAPSHOT_RULE)).toBeVisible();
	await expect(page.getByTestId('report-row-count')).toBeVisible();
});

test('переключение режима меняет адрес и правило на экране', async ({ page }) => {
	await page.goto('/reports');
	await waitForHydration(page);

	await page.getByTestId('report-mode-movement').click();

	await expect(page).toHaveURL(/mode=movement/);
	await expect(page.getByText(MOVEMENT_RULE)).toBeVisible();

	// Колонки движения появляются вместе с режимом: «Вид события» в срезе нет.
	await expect(page.getByRole('columnheader', { name: /Вид события/ })).toBeVisible();

	await page.getByTestId('report-mode-snapshot').click();

	await expect(page).toHaveURL(/mode=snapshot/);
	await expect(page.getByText(SNAPSHOT_RULE)).toBeVisible();
});

test('включённая колонка уезжает в адрес и появляется в таблице', async ({ page }) => {
	await page.goto('/reports');
	await waitForHydration(page);

	await page.getByTestId('report-columns').click();
	await page.getByTestId('report-column-stageEnteredAt').click();

	await expect(page).toHaveURL(/cols=[^&]*stageEnteredAt/);
	await expect(page.getByRole('columnheader', { name: /На стадии с/ })).toBeVisible();
});

test('отчёт выгружается книгой, и файл непустой', async ({ page }) => {
	await page.goto('/reports');

	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByTestId('report-export-xlsx').click()
	]);

	const name = download.suggestedFilename();

	expect(name.startsWith('Отчёт по взаимодействиям')).toBe(true);
	expect(name.endsWith('.xlsx')).toBe(true);

	const path = await download.path();
	const file = await stat(path);

	expect(file.size).toBeGreaterThan(0);
});

test('клик по столбцу воронки добавляет фильтр стадии в адрес', async ({ page }) => {
	await page.goto('/reports');
	await waitForHydration(page);

	const canvas = page.getByTestId('report-chart-canvas');

	await expect(canvas).toBeVisible();

	/**
	 * Координаты самой длинной полосы.
	 *
	 * Диаграмма — растр: ни столбца, ни его границ в разметке нет, поэтому
	 * геометрия берётся у самого экземпляра. Проба по долям ширины холста
	 * промахивалась бы на любой выборке с короткими полосами: длину подписей и
	 * масштаб оси решает Chart.js, а не тест.
	 */
	const readBar = () =>
		canvas.evaluate((element) => {
			type Bar = { x: number; y: number; base: number };
			type Instance = {
				getDatasetMeta: (index: number) => { data: Bar[] };
				data: { datasets: { data: (number | null)[] }[] };
			};

			const chart = (element as HTMLCanvasElement & { chart?: Instance }).chart;

			// Библиотека подключается динамическим импортом, поэтому холст живёт
			// раньше экземпляра: «ещё не собралась» — это не «полос нет».
			if (chart === undefined) {
				return { ready: false, values: [] as number[], target: null };
			}

			const box = element.getBoundingClientRect();
			const values = chart.data.datasets[0].data.map((value) =>
				typeof value === 'number' ? value : 0
			);
			const bars = chart.getDatasetMeta(0).data;
			const candidates: { value: number; bar: Bar }[] = [];

			values.forEach((value, index) => {
				const bar = bars[index];

				// Нулевая полоса длины не имеет: попасть в неё нельзя и незачем.
				if (bar !== undefined && value > 0) {
					candidates.push({ value, bar });
				}
			});

			candidates.sort((left, right) => right.value - left.value);

			const top = candidates[0];

			return {
				ready: true,
				values,
				target:
					top === undefined
						? null
						: {
								x: box.x + (top.bar.x + top.bar.base) / 2,
								y: box.y + top.bar.y,
								value: top.value
							}
			};
		});

	let bar: Awaited<ReturnType<typeof readBar>> = { ready: false, values: [], target: null };

	await expect(async () => {
		bar = await readBar();

		expect(bar, `диаграмма не отдала полосу: ${JSON.stringify(bar)}`).toMatchObject({
			ready: true,
			target: { value: expect.any(Number) }
		});
	}).toPass({ timeout: 15_000 });

	await page.mouse.click(bar.target!.x, bar.target!.y);

	await expect(page).toHaveURL(/stage=[a-z_]+/);
});
