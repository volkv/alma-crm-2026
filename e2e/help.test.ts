import { expect, test } from './fixtures';

/**
 * Встроенная справка глазами вошедшего человека.
 *
 * Проверяется то, ради чего она вообще есть: оглавление открывается, статья
 * разбирается из своего файла (заголовок берётся из шапки статьи, а текст —
 * настоящей разметкой, а не строкой с решётками), соседние статьи связаны, и
 * печатная страница содержит всё сразу — из неё собирается PDF, и потерянная
 * там статья означала бы руководство, у которого на экране и в файле разное
 * содержание.
 *
 * Права у раздела нет: руководство описывает систему целиком, и проход идёт под
 * менеджером — самой ограниченной ролью стенда.
 */

/** Экран телефона и экран ноутбука: оглавление живёт рядом со статьёй. */
const NARROW = { width: 390, height: 844 } as const;
const WIDE = { width: 1280, height: 900 } as const;

/** Первая статья руководства пользователя: с неё начинается чтение. */
const FIRST_ARTICLE = 'Вход и первый экран';
const SECOND_ARTICLE = 'Список и доска взаимодействий';

/** Насколько документ шире экрана. Ноль и меньше — помещается. */
async function documentOverflow(page: import('@playwright/test').Page): Promise<number> {
	return page.evaluate(() => {
		const root = document.documentElement;

		return root.scrollWidth - root.clientWidth;
	});
}

test('оглавление перечисляет оба руководства и ведёт в статью', async ({ page }) => {
	await page.goto('/help');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Справка');
	await expect(page.getByText('Руководство пользователя')).toBeVisible();
	await expect(page.getByText('Руководство администратора')).toBeVisible();

	await page.getByRole('link', { name: FIRST_ARTICLE }).click();

	await expect(page).toHaveURL(/\/help\/user\/start$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(FIRST_ARTICLE);
});

test('статья разбирается из разметки и связана с соседней', async ({ page }) => {
	await page.goto('/help/user/start');

	// Заголовок страницы — из шапки файла, а не из первой строки текста.
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(FIRST_ARTICLE);
	// `## Вход` обязан стать заголовком, а не строкой с решётками.
	await expect(page.getByRole('heading', { level: 2, name: 'Вход' })).toBeVisible();
	await expect(page.getByText('## Вход')).toHaveCount(0);
	// Ссылка на раздел продукта внутри текста — настоящая ссылка.
	await expect(page.getByRole('link', { name: '«Сводка»', exact: false }).first()).toHaveAttribute(
		'href',
		'/'
	);

	// Соседняя статья: у первой есть «следующая» и нет «предыдущей».
	const navigation = page.getByRole('navigation', { name: 'По разделу' });

	await expect(navigation.getByRole('link', { name: SECOND_ARTICLE })).toBeVisible();

	await navigation.getByRole('link', { name: SECOND_ARTICLE }).click();

	await expect(page).toHaveURL(/\/help\/user\/interactions$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(SECOND_ARTICLE);
	// Обратный ход есть у любой статьи, кроме первой.
	await expect(
		page.getByRole('navigation', { name: 'По разделу' }).getByRole('link', { name: FIRST_ARTICLE })
	).toBeVisible();
});

test('таблица статьи остаётся таблицей', async ({ page }) => {
	await page.goto('/help/admin/access');

	const table = page.getByRole('table').first();

	await expect(table).toBeVisible();
	await expect(table.getByRole('cell', { name: 'Администратор', exact: true })).toBeVisible();
});

test('печатная страница содержит все статьи обоих руководств', async ({ page }) => {
	await page.goto('/help');

	// Список заголовков берётся из оглавления, а не переписывается в тест:
	// новая статья обязана попасть в печать сама, без правки проверки.
	const titles = await page
		.getByRole('link')
		.filter({ hasNotText: 'Версия для печати' })
		.evaluateAll((links) =>
			links
				.filter((link) => (link.getAttribute('href') ?? '').startsWith('/help/'))
				.map((link) => link.querySelector('span')?.textContent?.trim() ?? '')
		);

	expect(titles.length).toBeGreaterThanOrEqual(10);

	await page.getByRole('link', { name: 'Версия для печати' }).click();
	await expect(page).toHaveURL(/\/help\/print$/);

	for (const title of titles) {
		await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(1);
	}

	// Заголовки статей опущены на два уровня: над ними стоят заголовок
	// документа и заголовок раздела, и без сдвига оглавление PDF было бы плоским.
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(
		page.getByRole('heading', { level: 2, name: 'Руководство пользователя' })
	).toBeVisible();
	await expect(page.getByRole('heading', { level: 3, name: FIRST_ARTICLE })).toBeVisible();
});

/** Адреса статей из оглавления: реестр статей живёт в сборке, а не в тесте. */
async function articleAddresses(page: import('@playwright/test').Page): Promise<string[]> {
	await page.goto('/help');

	return page
		.getByRole('link')
		.evaluateAll((links) =>
			links
				.map((link) => link.getAttribute('href') ?? '')
				.filter((href) => /^\/help\/(user|admin)\//.test(href))
		);
}

test('у каждой статьи есть снимок экрана, и он отдаётся', async ({ page }) => {
	const addresses = await articleAddresses(page);

	expect(addresses.length).toBeGreaterThanOrEqual(10);

	for (const address of addresses) {
		await page.goto(address);

		// Картинки статьи адресуются от корня: тот же текст показывает страница
		// печати, которая лежит на другом уровне адреса, и относительная ссылка
		// развалилась бы ровно там, откуда собирают PDF.
		const sources = await page
			.locator('img')
			.evaluateAll((images) =>
				images
					.map((image) => image.getAttribute('src') ?? '')
					.filter((src) => src.startsWith('/help/'))
			);

		expect(sources, `статья ${address} без иллюстраций`).not.toHaveLength(0);

		for (const source of new Set(sources)) {
			const response = await page.request.get(source);

			expect(response.status(), `${source} со страницы ${address}`).toBe(200);
		}

		// Снимок без подписи бесполезен тому, кто читает страницу голосом.
		const described = await page
			.locator('img[src^="/help/"]')
			.evaluateAll((images) => images.every((image) => (image.getAttribute('alt') ?? '') !== ''));

		expect(described, `статья ${address}: у снимка нет подписи`).toBe(true);
	}
});

test('печатная версия несёт те же снимки, что и статьи', async ({ page }) => {
	const addresses = await articleAddresses(page);

	await page.goto('/help/print');

	const printed = await page
		.locator('img')
		.evaluateAll((images) =>
			images
				.map((image) => image.getAttribute('src') ?? '')
				.filter((src) => src.startsWith('/help/'))
		);

	// Хотя бы по одному снимку на статью: иначе PDF окажется беднее экрана.
	expect(printed.length).toBeGreaterThanOrEqual(addresses.length);
});

test('справка помещается и на телефон, и на ноутбук', async ({ page }) => {
	for (const size of [NARROW, WIDE]) {
		await page.setViewportSize(size);

		for (const address of ['/help', '/help/user/start', '/help/print']) {
			await page.goto(address);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
		}
	}
});
