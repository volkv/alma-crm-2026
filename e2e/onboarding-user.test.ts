import { Buffer } from 'node:buffer';
import type { Locator, Page } from '@playwright/test';
import { expect, leadTest, test } from './fixtures';
import { waitForHydration } from './helpers/hydration';

/**
 * Обещание самодокументированной системы, проверенное на рабочих экранах.
 *
 * `e2e/onboarding.test.ts` проверяет сами подсказки: приходят один раз, ведут
 * сами, уходят по первой просьбе. Здесь проверяется другое и более скучное:
 * что на каждом экране работы значок «?» открывает тур **по элементам этого
 * экрана** и что каждый его шаг действительно находит блок, о котором
 * рассказывает. Реестр и разметку сверяют модульные проверки
 * (`tests/unit/onboarding`), но они читают файлы, а не страницу: блок, который
 * на живом стенде не отрисовался, для них неотличим от отрисованного.
 *
 * Роль по умолчанию — менеджерская, самая массовая на стенде. Руководитель
 * входит там, где элемент стоит под правом, которого у КАМа нет:
 * переназначение ответственного и импорт каталога.
 */

/**
 * Строка-предупреждение в карточке шага.
 *
 * Найденный элемент карточка показывает рамкой, а ненайденный — одной строкой
 * под текстом шага: «блока сейчас нет» или тем, что сказано в `hint` реестра.
 * Другого признака у неё нет, поэтому проверка читает именно эту строку;
 * отличает её тон предупреждения, который в карточке больше нигде не стоит.
 */
const HINT = 'p.text-warning-soft-foreground';

/** Рамка вокруг элемента: её рисует карточка, когда элемент на экране нашёлся. */
const HIGHLIGHT = 'div.ring-2.ring-primary';

function tourOf(page: Page): Locator {
	return page.getByTestId('onboarding-tour');
}

/**
 * Открыть подсказки по текущему экрану значком «?».
 *
 * Меню открывает код страницы, и нажатие до того, как она ожила, теряется
 * совсем (`docs/development.md`, «Всплывающие слои»), — отсюда повтор.
 */
async function openScreenTour(page: Page): Promise<Locator> {
	await waitForHydration(page);

	const trigger = page.getByRole('button', { name: 'Подсказки и справка' });
	const item = page.getByRole('menuitem', { name: 'Подсказки по этому экрану' });

	await expect(async () => {
		await trigger.click();
		await expect(item).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await item.click();

	const tour = tourOf(page);

	await expect(tour).toBeVisible();

	return tour;
}

/**
 * Пройти тур экрана от вступления до «Готово», нажимая только «Далее», и
 * вернуть шаги, на которых элемента не нашлось, вместе с тем, что карточка о
 * них сказала.
 *
 * Сколько в туре шагов, решает реестр, и число, вписанное в проверку,
 * пришлось бы править на каждый новый шаг. Человек здесь делает ровно одно —
 * жмёт «Далее», пока не дойдёт до конца.
 */
async function walkScreenTour(
	page: Page,
	screenTitle: string
): Promise<{ title: string; hint: string }[]> {
	const tour = await openScreenTour(page);

	// Тур экрана начинается вступлением: «Отчёты · шаг 1 из N».
	await expect(tour).toContainText(`${screenTitle} · шаг 1 из`);

	const heading = tour.getByRole('heading', { level: 2 });
	const hint = tour.locator(HINT);
	const highlight = page.locator(HIGHLIGHT);
	const missed: { title: string; hint: string }[] = [];

	for (let guard = 0; guard < 20; guard += 1) {
		// Рамка ставится покадрово, поэтому состояние шага читается только после
		// того, как карточка договорила: либо рамка встала, либо она объяснила,
		// почему блока на экране нет. Третьего состояния у шага не бывает.
		await expect(highlight.or(hint).first()).toBeVisible({ timeout: 10_000 });

		const title = (await heading.innerText()).trim();

		if ((await hint.count()) > 0) {
			missed.push({ title, hint: (await hint.innerText()).trim() });
		}

		const next = tour.getByRole('button', { name: 'Далее' });

		if ((await next.count()) === 0) {
			// Последняя остановка: кнопка называется «Готово» и закрывает тур.
			await tour.getByRole('button', { name: 'Готово' }).click();
			await expect(tour).toBeHidden();

			return missed;
		}

		await next.click();
		await expect(heading).not.toHaveText(title);
	}

	throw new Error(`Тур экрана «${screenTitle}» не кончился за двадцать шагов`);
}

/** Пройти тур экрана и потребовать, чтобы каждый его шаг нашёл свой блок. */
async function walkAndExpectComplete(page: Page, address: string, screenTitle: string) {
	await page.goto(address);

	const missed = await walkScreenTour(page, screenTitle);

	expect(
		missed,
		`на экране «${screenTitle}» тур не нашёл блоки: ${missed
			.map((step) => `${step.title} — ${step.hint}`)
			.join('; ')}`
	).toEqual([]);
}

/**
 * Открыть первую запись списка: карточку тур показывает на настоящих данных.
 *
 * Нажатие приходится на первую ячейку строки, а не на её середину: в списках
 * есть колонки со ссылками на соседние записи — у документа это ссылка на его
 * взаимодействие, — и клик по центру строки уводил бы совсем не туда.
 */
async function openFirstRow(page: Page, address: string, section: string): Promise<void> {
	await page.goto(address);
	await waitForHydration(page);

	const rows = page.locator('[data-slot="data-table"] tbody tr[data-row]');

	await expect(rows.first()).toBeVisible();
	await rows.first().locator('td').first().click();
	await expect(page).toHaveURL(
		new RegExp(`/${section}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	);
}

test('подсказки сводки и списка взаимодействий проходят по элементам', async ({ page }) => {
	await walkAndExpectComplete(page, '/', 'Сводка');
	await walkAndExpectComplete(page, '/interactions', 'Взаимодействия');
});

test('карточка взаимодействия: лента стадий, четыре вопроса и вкладки', async ({ page }) => {
	await openFirstRow(page, '/interactions', 'interactions');

	const missed = await walkScreenTour(page, 'Карточка взаимодействия');

	expect(missed).toEqual([]);
});

test('справочники объясняют отбор и список', async ({ page }) => {
	await walkAndExpectComplete(page, '/organizations', 'Организации');
	await walkAndExpectComplete(page, '/people', 'Контакты');
	await walkAndExpectComplete(page, '/programs', 'Программы');
	await walkAndExpectComplete(page, '/products', 'Продукты');
	await walkAndExpectComplete(page, '/directions', 'Направления');
});

test('карточки организации и человека: ответственные, договоры, роли', async ({ page }) => {
	await openFirstRow(page, '/organizations', 'organizations');
	expect(await walkScreenTour(page, 'Карточка организации')).toEqual([]);

	await openFirstRow(page, '/people', 'people');
	expect(await walkScreenTour(page, 'Карточка человека')).toEqual([]);
});

test('отчёты объясняют режим, отбор, итоги и выгрузку', async ({ page }) => {
	await walkAndExpectComplete(page, '/reports', 'Отчёты');
});

test('документы: список и карточка с отметками', async ({ page }) => {
	await walkAndExpectComplete(page, '/documents', 'Документы');

	await openFirstRow(page, '/documents', 'documents');
	expect(await walkScreenTour(page, 'Карточка документа')).toEqual([]);
});

test('справка и профиль тоже объясняют себя', async ({ page }) => {
	await walkAndExpectComplete(page, '/help', 'Справка');
	await walkAndExpectComplete(page, '/settings/profile', 'Профиль');
});

leadTest('данные об обучении: снимки, показатели и дашборд', async ({ page }) => {
	// Руководитель, а не КАМ: показатели и дашборд считаются в области доступа, и
	// у руководителя в ней лежат вузы его людей — на стенде это и есть данные.
	await walkAndExpectComplete(page, '/data', 'Данные об обучении');
	await walkAndExpectComplete(page, '/data/indicators', 'Показатели');
	await walkAndExpectComplete(page, '/data/dashboard', 'Дашборд данных');
});

leadTest('шаги под правом показывают то, чего у менеджера нет', async ({ page }) => {
	// Переназначение ответственного (`interactions.reassign`) и импорт каталога
	// (`directory.import`) КАМу закрыты, и шаги про них выпадают из его тура
	// вместе с кнопками. Руководителю они есть — значит, есть и шаги.
	await page.goto('/interactions');

	const interactions = await openScreenTour(page);

	await expect(interactions).toContainText('Взаимодействия · шаг 1 из 4');
	await interactions.getByRole('button', { name: 'Закрыть подсказки' }).click();

	await page.goto('/organizations');

	const organizations = await openScreenTour(page);

	await expect(organizations).toContainText('Организации · шаг 1 из 4');
	await organizations.getByRole('button', { name: 'Закрыть подсказки' }).click();

	// Шаг мастера импорта: сопоставление колонок живёт на адресе разобранного
	// файла, поэтому проход сначала заводит свой — маленький и не применяемый.
	await page.goto('/organizations/import');
	await waitForHydration(page);
	await page.locator('input[name="file"]').setInputFiles({
		name: 'каталог-подсказки.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('Название ВУЗа;ПО\r\nВуз подсказок;Платформа подсказок\r\n', 'utf8')
	});
	await page.getByRole('button', { name: 'Дальше: сопоставление колонок' }).click();
	await expect(page.getByRole('heading', { name: 'Сопоставление колонок' })).toBeVisible();

	expect(await walkScreenTour(page, 'Сопоставление колонок каталога')).toEqual([]);
});

test('полный тур доходит до карточки записи и находит её первый блок', async ({ page }) => {
	await page.goto('/');
	await waitForHydration(page);

	const trigger = page.getByRole('button', { name: 'Подсказки и справка' });
	const full = page.getByRole('menuitem', { name: 'Полный тур по системе' });

	await expect(async () => {
		await trigger.click();
		await expect(full).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await full.click();

	const tour = tourOf(page);

	await expect(tour).toBeVisible();
	await tour.getByRole('button', { name: 'Начать тур' }).click();

	// Оглавление ведёт прямо к карточке: идентификатор записи туру дал сервер,
	// в границах области доступа этой сессии.
	await tour.getByRole('button', { name: 'Оглавление' }).click();
	await page.getByRole('menuitem', { name: 'Карточка взаимодействия' }).click();

	await expect(page).toHaveURL(
		/\/interactions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
	);
	await expect(tour).toContainText('Карточка взаимодействия · шаг 1 из');

	// Первый шаг по элементу — лента стадий: рамка встаёт вокруг неё, и
	// строки «блока сейчас нет» в карточке не появляется.
	await tour.getByRole('button', { name: 'Далее' }).click();
	await expect(tour.getByRole('heading', { level: 2 })).toHaveText('Лента стадий');
	await expect(page.locator(HIGHLIGHT)).toBeVisible();
	await expect(tour.locator(HINT)).toHaveCount(0);

	await page.keyboard.press('Escape');
	await expect(tour).toBeHidden();
});
