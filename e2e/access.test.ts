import { expect, test as base } from '@playwright/test';
import { seedId } from '../scripts/seed/ids';
import { LEAD_STATE, MANAGER_STATE } from './global-setup';

/**
 * Область доступа глазами двух ролей: менеджер видит свои вузы и не видит
 * чужих, руководитель видит то же плюс работу своих людей и распоряжается
 * назначениями.
 *
 * Проверки идут по данным сида: по ним же живёт стенд. «Чужой вуз» здесь — тот,
 * что ведёт другой менеджер того же руководителя (Вересова), а не выдуманная
 * строка: разграничение, которое не на чем показать, ничего не доказывает.
 */
const managerTest = base.extend<object>({ storageState: MANAGER_STATE });
const leadTest = base.extend<object>({ storageState: LEAD_STATE });

/** Вуз, который ведёт демонстрационный менеджер. */
const OWN_ORGANIZATION = { id: seedId('organization', 'bit'), name: 'МТУСИ' };

/** Вуз Вересовой: тот же руководитель, другой менеджер. */
const OTHER_ORGANIZATION = { id: seedId('organization', 'pupi'), name: 'МФТИ' };

managerTest('менеджер видит свои вузы и не видит чужих', async ({ page }) => {
	// Отбор по названию, а не первая страница списка: база прогона живёт дольше
	// прогона, и искомый вуз на ней уезжает на вторую страницу. Ячейка названия
	// несёт ещё и уровень образования, поэтому ищем строку.
	await page.goto(`/organizations?q=${encodeURIComponent(OWN_ORGANIZATION.name)}`);
	await expect(page.getByRole('row').filter({ hasText: OWN_ORGANIZATION.name })).toHaveCount(1);

	await page.goto(`/organizations?q=${encodeURIComponent(OTHER_ORGANIZATION.name)}`);
	await expect(page.getByRole('row').filter({ hasText: OTHER_ORGANIZATION.name })).toHaveCount(0);
});

managerTest('чужой вуз по прямой ссылке отдаёт 404, а не отказ', async ({ page }) => {
	const response = await page.goto(`/organizations/${OTHER_ORGANIZATION.id}`);

	// Именно 404: отказ выдал бы, что запись существует, — и перебором
	// идентификаторов можно было бы узнать, что лежит за пределами области.
	expect(response?.status()).toBe(404);
});

managerTest('менеджеру нечем назначить ответственного', async ({ page }) => {
	await page.goto(`/organizations/${OWN_ORGANIZATION.id}`);

	await expect(page.getByRole('heading', { level: 1 })).toContainText(OWN_ORGANIZATION.name);
	// Блок «Ответственные» он видит — это часть картины его вуза, — а формы
	// назначения у него нет: распределяет нагрузку руководитель.
	await expect(page.getByText('Ответственные')).toBeVisible();
	await expect(page.getByTestId('assign-responsible')).toHaveCount(0);
});

leadTest('руководитель видит вузы обоих своих менеджеров', async ({ page }) => {
	// Отбор по названию, а не первая страница списка: база прогона живёт дольше
	// прогона, и искомый вуз на ней уезжает на вторую страницу.
	for (const name of [OWN_ORGANIZATION.name, OTHER_ORGANIZATION.name]) {
		await page.goto(`/organizations?q=${encodeURIComponent(name)}`);

		await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(1);
	}
});

/**
 * Переназначение и доступ: снятое назначение закрывает вуз в ту же секунду, а
 * не со следующего входа.
 *
 * Вуз заводится проходом, а не берётся у стенда: проверка меняет
 * ответственного, а стенд общий на весь прогон — испортить чужие данные она не
 * вправе. Заодно это показывает второе правило: **созданный вуз сразу получает
 * назначение на автора**, иначе человек завёл бы карточку и тут же потерял её
 * из виду.
 */
leadTest('назначение и снятие меняют доступ немедленно', async ({ page, browser, baseURL }) => {
	const name = `E2E-ДОСТУП ${Date.now().toString(36)}`;

	await page.goto('/organizations/new');
	await page.getByLabel('Полное наименование').fill(`${name} полное`);
	await page.getByLabel('Краткое наименование').fill(name);
	await page.getByRole('button', { name: 'Создать организацию' }).click();

	await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]{36}/);
	const organizationUrl = new URL(page.url()).pathname;

	/** Открывает карточку вуза сессией менеджера и возвращает код ответа. */
	async function statusForManager(): Promise<number | undefined> {
		const context = await browser.newContext({ baseURL, storageState: MANAGER_STATE });

		try {
			const managerPage = await context.newPage();
			const response = await managerPage.goto(organizationUrl);

			return response?.status();
		} finally {
			await context.close();
		}
	}

	// Автор — ответственный, и больше никто: менеджер вуза не видит.
	await expect(page.getByRole('row').filter({ hasText: 'Руководитель Демо' })).toHaveCount(1);
	await expect.poll(statusForManager, { timeout: 15_000 }).toBe(404);

	// Назначение заменяет прежнее тем же моментом: общее и по направлениям на
	// одном вузе не сосуществуют, поэтому замена, а не вторая строка.
	const form = page.getByTestId('assign-responsible');
	// Список сотрудников — наш контрол (роль `combobox`), и открывает его код
	// страницы: нажатие до гидратации теряется совсем, отсюда повтор, и только
	// пока список закрыт — второе нажатие закрыло бы открытое.
	const managerOption = page.getByRole('option', { name: 'Менеджер Демо' });

	await expect(async () => {
		if (!(await managerOption.isVisible())) {
			await form.getByRole('combobox', { name: 'Сотрудник' }).click({ timeout: 5_000 });
		}

		await expect(managerOption).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await managerOption.click();
	await form.getByRole('button', { name: 'Назначить' }).click();
	// Проверяем доступ, а не тост: тост исчезает сам, и ожидание его видимости
	// проверяло бы скорость машины. `poll` — потому что между нажатием и ответом
	// стоит переход, и первый запрос соседней сессии может уйти раньше него.
	await expect.poll(statusForManager, { timeout: 15_000 }).toBe(200);

	// Прежнее назначение закрыто, а не стёрто: замена ушла в историю вуза.
	await expect(page.getByText(/История назначений \(1\)/)).toBeVisible();

	// И обратно: снятое назначение закрывает вуз в ту же секунду.
	const confirmation = page.getByRole('alertdialog');
	const assigned = page.getByRole('row').filter({ hasText: 'Менеджер Демо' }).first();
	await assigned.getByRole('button', { name: 'Снять' }).click();
	await expect(confirmation).toBeVisible();
	await confirmation.getByRole('button', { name: 'Снять' }).click();
	await expect.poll(statusForManager, { timeout: 15_000 }).toBe(404);

	// И у самого руководителя тоже: действующих назначений у вуза не осталось ни
	// одного, а область — это они и есть. Правило работает в обе стороны и без
	// повторного входа.
	const reopened = await page.goto(organizationUrl);
	expect(reopened?.status()).toBe(404);
});
