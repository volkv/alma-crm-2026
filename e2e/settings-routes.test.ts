import { expect, test as base, type Locator } from '@playwright/test';
import { ADMIN_STATE, STAFF_ADMIN_STATE } from './global-setup';

/**
 * Маршруты стадий глазами администратора.
 *
 * Настройка процесса не переживает демонстрации: `stages.configure` у
 * демо-сессии нет, какой бы ролью в неё ни вошли. Поэтому правит маршрут
 * штатный администратор оператора (`staff`), а демонстрационному (`demo`)
 * раздел закрыт — это и проверяется.
 */
const staff = base.extend<object>({ storageState: STAFF_ADMIN_STATE });
const demo = base.extend<object>({ storageState: ADMIN_STATE });

/** Стадия, которую прогон дописывает в новую версию маршрута. */
const STAGE_KEY = 'branch_pilot';
const STAGE_NAME = 'Пилот в филиале';

/** Стадия демонстрационного маршрута, после которой встаёт новая. */
const LAST_STAGE = 'Контроль исполнения';

/**
 * Открывает всплывающий слой — диалог или список выбора — и дожидается его.
 *
 * Слой открывает код страницы, а не браузер: нажатие до того, как страница
 * ожила, до обработчика не доходит и теряется совсем. Поэтому нажимаем, пока
 * слой не появится, — фиксированная пауза закладывалась бы на скорость машины
 * (см. `docs/development.md`, «Всплывающие слои»).
 */
async function openLayer(trigger: Locator, layer: Locator): Promise<void> {
	await expect(async () => {
		await trigger.click();
		await expect(layer).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
}

staff('новая версия маршрута заводится копией, правится и публикуется', async ({ page }) => {
	await page.goto('/settings/routes');

	// Маршрут по умолчанию в базе ровно один — с него и работают.
	const current = page.getByRole('row').filter({ hasText: 'По умолчанию' }).first();
	await current.getByRole('link').click();

	// Черновик у ключа один: если прошлый прогон оставил свой, кнопка выключена
	// и об этом сказано на карточке — тогда падать надо здесь, а не на клике.
	await expect(page.getByRole('button', { name: 'Новая версия' })).toBeEnabled();
	await page.getByRole('button', { name: 'Новая версия' }).click();

	// Новая версия — копия: те же стадии, но править их уже можно.
	await expect(page.getByText('Черновик').first()).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: 'execution_control' })).toHaveCount(1);

	const dialog = page.getByRole('dialog');

	// Кнопка карточки и кнопка отправки формы названы одинаково — это одно и то
	// же действие; в разметке первой идёт карточка, диалог уносится в конец.
	await openLayer(page.getByRole('button', { name: 'Добавить стадию' }).first(), dialog);

	await dialog.getByLabel('Ключ').fill(STAGE_KEY);
	await dialog.getByLabel('Название').fill(STAGE_NAME);
	await dialog.getByLabel('Чек-лист').fill('* pilot_agreed: Пилот согласован с филиалом');
	await dialog.getByRole('button', { name: 'Добавить стадию' }).click();

	await expect(page.getByText('Стадия добавлена')).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: STAGE_KEY })).toBeVisible();

	// Стадия есть, а дойти до неё неоткуда: публикация отказывает и называет,
	// что именно мешает.
	await page.getByRole('button', { name: 'Опубликовать' }).click();
	await expect(page.getByText(/нет перехода вперёд/).first()).toBeVisible();

	await openLayer(page.getByRole('button', { name: 'Добавить переход' }).first(), dialog);

	const from = page.getByRole('option', { name: new RegExp(LAST_STAGE) });
	await openLayer(dialog.getByRole('button', { name: /^Откуда/ }), from);
	await from.click();

	const to = page.getByRole('option', { name: new RegExp(STAGE_NAME) });
	await openLayer(dialog.getByRole('button', { name: /^Куда/ }), to);
	await to.click();

	await dialog.getByRole('button', { name: 'Добавить переход' }).click();
	await expect(page.getByText('Переход добавлен')).toBeVisible();

	await page.getByRole('button', { name: 'Опубликовать' }).click();

	await expect(page.getByText(/Версия опубликована/)).toBeVisible();
	// Опубликованная версия — свидетельство: править её больше нечем, можно
	// только завести следующую.
	await expect(page.getByRole('button', { name: 'Добавить стадию' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Новая версия' })).toBeVisible();
});

demo('настройка маршрутов демонстрации не принадлежит', async ({ page }) => {
	await page.goto('/settings/profile');

	// Меню настроек собирается из прав: чего нет в нём, того нет и по ссылке.
	await expect(page.getByRole('link', { name: 'Маршруты стадий' })).toHaveCount(0);

	const response = await page.request.get('/settings/routes');
	expect(response.status()).toBe(403);
});
