import type { Page } from '@playwright/test';
import { expect, leadTest as test, test as managerTest } from './fixtures';
import { waitForHydration } from './helpers/hydration';

/**
 * Импорт каталога глазами руководителя: мастер из трёх шагов, предпросмотр с
 * действием по каждой строке и применение к справочнику.
 *
 * Именно руководителя: одним файлом импорт заводит вузы, продукты и договоры
 * сразу десятками, поэтому право `directory.import` у КАМа отнято
 * (`docs/access-matrix.md`, раздел 3). Проверка этого — отдельным проходом
 * менеджера в конце файла.
 *
 * Проход заводит **свои** записи и считает только их: на стенде есть
 * сидированные вузы, продукты и договоры, и проверка, которая смотрит на них,
 * говорила бы о том, чем заливали базу, а не о разделе, — и ломалась бы на
 * каждой правке набора данных. Отсюда метка прогона в каждом названии.
 */

/** Метка прогона: делает записи файла уникальными в общей базе. */
const TAG = crypto.randomUUID().slice(0, 8);

const HEADERS = [
	'Название ВУЗа',
	'Вендор',
	'ПО',
	'Код ПО',
	'ИТ-направление',
	'Номер договора',
	'Дата договора',
	'Подписание лицензии',
	'Срок действия лицензии (год)',
	'Статус по передаче',
	'ФИО Менеджера',
	'Ответственные от ВУЗа',
	'Комментарий'
];

/** Сотрудник стенда, которому файл отдаёт вузы прогона. */
const MANAGER = 'Вересова Анна Сергеевна';

/**
 * Файл каталога прогона: два вуза, которых на стенде нет, и одна строка с
 * лицензией, истекающей раньше, чем она подписана. Три последние колонки —
 * рабочие: менеджер, контакты вуза и комментарий.
 *
 * Собирается в памяти, а не лежит в репозитории: названия обязаны быть своими у
 * каждого прогона, иначе второй проход увидел бы записи первого и сказал бы
 * «без изменений» там, где проверяется «создать».
 */
function catalogCsv(licenseYear: string): Buffer {
	const rows = [
		[
			`Вуз ${TAG} А`,
			`Вендор ${TAG}`,
			`Платформа ${TAG}`,
			`PRD-${TAG}-1`,
			`Направление ${TAG}`,
			`Д-${TAG}-1`,
			'2026-09-10',
			'2026-09-10',
			licenseYear,
			'transferred',
			MANAGER,
			`Иванова Мария Петровна, +7 (999) 123-45-67, m.ivanova.${TAG}@vuz.ru`,
			'Ждут смету на следующий год'
		],
		[
			`Вуз ${TAG} Б`,
			`Вендор ${TAG}`,
			`Платформа ${TAG}`,
			`PRD-${TAG}-1`,
			`Направление ${TAG}`,
			`Д-${TAG}-2`,
			'2026-09-11',
			'2026-09-11',
			licenseYear,
			'pending',
			MANAGER,
			`Петров Пётр Петрович, p.petrov.${TAG}@vuz.ru`,
			'Просили счёт в сентябре'
		],
		[
			`Вуз ${TAG} В`,
			`Вендор ${TAG}`,
			`Платформа ${TAG}`,
			`PRD-${TAG}-1`,
			`Направление ${TAG}`,
			`Д-${TAG}-3`,
			'2026-09-12',
			'2027-05-01',
			'2026',
			'pending',
			MANAGER,
			'',
			''
		]
	];

	return Buffer.from([HEADERS, ...rows].map((row) => row.join(';')).join('\r\n') + '\r\n', 'utf8');
}

/** Шаги 1 и 2 мастера: файл и согласие с предложенным сопоставлением. */
async function uploadCatalog(page: Page, licenseYear = '2027'): Promise<void> {
	await page.goto('/organizations');
	await page.getByRole('link', { name: 'Импорт каталога' }).click();
	await expect(page.getByRole('heading', { name: 'Импорт каталога', level: 1 })).toBeVisible();

	await waitForHydration(page);

	await page.locator('input[name="file"]').setInputFiles({
		name: `каталог-${TAG}.csv`,
		mimeType: 'text/csv',
		buffer: catalogCsv(licenseYear)
	});
	await page.getByRole('button', { name: 'Дальше: сопоставление колонок' }).click();

	await expect(page.getByRole('heading', { name: 'Сопоставление колонок' })).toBeVisible();
	// Колонки разложены подсказкой, человеку остаётся согласиться.
	await expect(page.getByText('Предложено').first()).toBeVisible();
	await page.getByRole('button', { name: 'Дальше: предпросмотр' }).click();

	await expect(page.getByRole('heading', { name: 'Предпросмотр импорта' })).toBeVisible();
}

test('руководитель проходит мастер импорта каталога до применения', async ({ page }) => {
	await uploadCatalog(page);

	// Шаг 3: три строки файла, две заводят записи, одна отказывает.
	await expect(page.locator('[data-slot="count-rows"]')).toHaveText('3');
	await expect(page.locator('[data-slot="count-create"]')).toHaveText('2');
	await expect(page.locator('[data-slot="count-error"]')).toHaveText('1');
	await expect(page.locator('tbody tr[data-row-no]')).toHaveCount(3);

	// Предпросмотр называет и то, что строка делает вокруг справочника: кому
	// достанется вуз, кто станет его контактом и что допишется в примечание.
	const first = page.locator('tbody tr[data-row-no="1"]');

	await expect(first).toContainText(`Ответственный за вуз: ${MANAGER}`);
	await expect(first).toContainText(`Контакт вуза: Иванова Мария Петровна · Вуз ${TAG} А`);
	await expect(first).toContainText('Примечание: — → Ждут смету на следующий год');

	// Строка с ошибкой объясняет себя словами, а не кодом.
	await page.getByRole('link', { name: 'Ошибка', exact: true }).click();
	await expect(page.locator('tbody tr[data-row-no]')).toHaveCount(1);
	await expect(page.getByText('Лицензия действует до')).toBeVisible();

	await page.getByRole('link', { name: 'Все строки', exact: true }).click();
	await page.getByRole('button', { name: 'Применить импорт' }).click();

	// Карточка загрузки: применено, и числа те же, что были на предпросмотре.
	await expect(page.getByRole('heading', { name: 'Загрузка каталога' })).toBeVisible();
	await expect(page.locator('[data-slot="status-badge"]', { hasText: 'Применён' })).toBeVisible();
	await expect(page.locator('[data-slot="count-create"]')).toHaveText('2');
	await expect(page.locator('[data-slot="count-error"]')).toHaveText('1');

	// Вуз, которого не было, теперь в справочнике — и ведёт его тот, кого назвал
	// файл, а не тот, кто нажал кнопку.
	await page.goto(`/organizations?q=${encodeURIComponent(`Вуз ${TAG} А`)}`);

	const found = page.locator('[data-slot="data-table"] tbody tr[data-row]');

	await expect(found).toHaveCount(1);

	// Строку списка открывает клиентский обработчик: до гидратации нажатие
	// теряется совсем, а повторять переход по записи нечем.
	await waitForHydration(page);
	await found.first().click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Вуз ${TAG} А`);
	await expect(page.getByText(MANAGER).first()).toBeVisible();
	await expect(page.getByText('Иванова Мария Петровна').first()).toBeVisible();
});

test('повтор того же файла ничего не меняет, а продлённая лицензия — обновляет', async ({
	page
}) => {
	await uploadCatalog(page);
	await page.getByRole('button', { name: 'Применить импорт' }).click();
	await expect(page.locator('[data-slot="status-badge"]', { hasText: 'Применён' })).toBeVisible();

	await uploadCatalog(page);

	// Ни одной новой записи и ни одного изменения: справочник уже описан файлом.
	await expect(page.locator('[data-slot="count-create"]')).toHaveText('0');
	await expect(page.locator('[data-slot="count-update"]')).toHaveText('0');
	await expect(page.locator('[data-slot="count-unchanged"]')).toHaveText('2');
	await expect(page.locator('[data-slot="count-error"]')).toHaveText('1');

	// Тот же файл с продлённой лицензией: предпросмотр называет, что поменяется.
	await uploadCatalog(page, '2029');

	await expect(page.locator('[data-slot="count-update"]')).toHaveText('2');
	await expect(page.locator('tbody tr[data-action="update"]').first()).toContainText(
		'Срок действия лицензии: 2027-12-31 → 2029-12-31'
	);
});

managerTest('менеджеру импорт каталога не предлагают и не открывают', async ({ page }) => {
	await page.goto('/organizations');
	await expect(page.getByRole('heading', { name: 'Организации', level: 1 })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Импорт каталога' })).toHaveCount(0);

	// Спрятанная кнопка — не защита: адрес, набранный руками, отвечает отказом.
	const response = await page.goto('/organizations/import');

	expect(response?.status()).toBe(403);
});
