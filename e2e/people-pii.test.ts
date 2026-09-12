import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { STAFF_ADMIN_STATE } from './global-setup';

/**
 * Персональные данные в браузере: согласия, срок хранения, обезличивание.
 *
 * Проход заводит своего человека и над ним же всё и делает. Сидированные люди
 * для этого не годятся: обезличивание необратимо, и первый же прогон унёс бы
 * контакт, на который опираются другие проверки и демонстрация.
 *
 * Учёт согласий и сроков идёт под демонстрационным менеджером — это часть того,
 * что на стенде показывают. Уничтожение данных демонстрации не принадлежит
 * (`people.anonymize` вычитается из демо-сессии), поэтому оно идёт под штатным
 * администратором, а демонстрации остаётся выключенная кнопка с причиной.
 *
 * Порядок значим: карточку заводит первая проверка, уничтожает последняя.
 */
test.describe.configure({ mode: 'serial' });

/** Штатный администратор: обычная учётная запись оператора, не демонстрационная. */
const staff = test.extend<object>({ storageState: STAFF_ADMIN_STATE });

/** Карточка, заведённая под менеджером: её же добивает штатный администратор. */
let retentionCardUrl: string | null = null;

/** Метка прогона: делает фамилию уникальной в общей базе. */
function tag(): string {
	return crypto.randomUUID().slice(0, 8);
}

/** Панель «Персональные данные» на карточке человека. */
function panel(page: Page): Locator {
	return page.locator('section').filter({ hasText: 'Персональные данные' });
}

/**
 * Выбор в раскрывающемся списке: слой открывается только после гидратации
 * страницы, поэтому первый клик может прийтись на ещё неживую разметку.
 */
async function choose(trigger: Locator, option: Locator): Promise<void> {
	await expect(async () => {
		await trigger.click();
		await expect(option).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await option.click();
}

/**
 * Нажатие, открывающее диалог. Страница после обычной отправки формы
 * загружается заново, и первый клик может прийтись на ещё не ожившую разметку:
 * кнопка нажимается, а обработчика на ней пока нет.
 */
async function openDialog(trigger: Locator, dialog: Locator): Promise<void> {
	await expect(async () => {
		await trigger.click();
		await expect(dialog).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
}

/** Заводит человека и возвращает адрес его карточки. */
async function createPerson(page: Page, lastName: string): Promise<string> {
	await page.goto('/people/new');
	await page.getByLabel('Фамилия').fill(lastName);
	// Подпись обязательного поля — «Имя *», поэтому по началу строки, а не целиком.
	await page.getByLabel(/^Имя/).fill('Пётр');
	// Почта латиницей: адрес с кириллицей контракт не примет, и форма не уйдёт.
	await page.getByLabel('Электронная почта').fill('contact@vuz.example');
	await page.getByLabel('Телефон').fill('+7 900 000-00-07');
	await page.getByRole('button', { name: 'Завести человека' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toContainText(lastName);

	return page.url();
}

test('согласие фиксируется и отзывается на карточке человека', async ({ page }) => {
	const lastName = `Согласов${tag()}`;
	await createPerson(page, lastName);

	const card = panel(page);
	await expect(card.getByText('Согласий не зафиксировано:')).toBeVisible();

	await choose(
		card.getByLabel('Основание'),
		page.getByRole('option', { name: 'Требование закона' })
	);
	await card.getByLabel('Версия текста').fill('2026-09-01');
	await card.getByRole('button', { name: 'Зафиксировать согласие' }).click();

	await expect(page.getByText('Согласие зафиксировано')).toBeVisible();
	await expect(card.getByRole('cell', { name: 'Требование закона' })).toBeVisible();
	await expect(card.getByText('Действует')).toBeVisible();

	const withdraw = page.getByRole('alertdialog').filter({ hasText: 'Отозвать согласие?' });
	await openDialog(card.getByRole('button', { name: 'Отозвать' }), withdraw);
	await withdraw.getByRole('button', { name: 'Отозвать согласие' }).click();

	await expect(page.getByText('Согласие отозвано')).toBeVisible();
	// Запись осталась: по ней видно, на чём держалась обработка до отзыва.
	await expect(card.getByRole('cell', { name: 'Требование закона' })).toBeVisible();
	await expect(
		card.getByText(
			'Действующих согласий нет: обработка данных этого человека сейчас ничем не обоснована.'
		)
	).toBeVisible();

	await page.screenshot({ path: 'test-results/people-personal-data.png', fullPage: true });
});

const RETENTION_LAST_NAME = `Хранимов${tag()}`;

test('истёкший срок хранения виден в списке, а уничтожить его из демонстрации нельзя', async ({
	page
}) => {
	retentionCardUrl = await createPerson(page, RETENTION_LAST_NAME);

	const card = panel(page);

	await card.getByLabel('Хранить до').fill('01.01.2020');
	await card.getByRole('button', { name: 'Сохранить срок' }).click();

	await expect(page.getByText('Срок хранения сохранён')).toBeVisible();
	await expect(card.getByText('Срок хранения истёк')).toBeVisible();

	await test.step('фильтр списка отбирает тех, чей срок прошёл', async () => {
		await page.goto('/people');
		await choose(
			page.getByLabel('Срок хранения'),
			page.getByRole('option', { name: 'Срок хранения истёк', exact: true })
		);

		await expect(page).toHaveURL(/retention=expired/);

		await page.getByLabel('Поиск по ФИО и организации').fill(RETENTION_LAST_NAME);

		const rows = page.locator('[data-slot="data-table"] tbody tr[data-row]');
		await expect(rows).toHaveCount(1);
		await expect(rows.first()).toContainText('Срок истёк');
	});

	await test.step('кнопка уничтожения выключена и объясняет, почему', async () => {
		await page.goto(retentionCardUrl ?? '');

		// Недоступную команду не прячем: демонстрация должна видеть, что такое
		// действие в системе есть, и почему его здесь не дают.
		const button = panel(page).getByRole('button', { name: 'Обезличить данные' });
		await expect(button).toBeVisible();
		await expect(button).toBeDisabled();
		await expect(
			panel(page).getByText(/Уничтожение данных на демонстрационном стенде закрыто/)
		).toBeVisible();
	});
});

staff(
	'штатный администратор уничтожает данные: имя и контакты уходят, запись нет',
	async ({ page }) => {
		// Адрес карточки остаётся от проверки выше: без неё уничтожать нечего, и
		// молча пропустить этот проход нельзя — он и есть проверяемое действие.
		expect(retentionCardUrl).not.toBeNull();

		await page.goto(retentionCardUrl!);

		const confirm = page
			.getByRole('alertdialog')
			.filter({ hasText: 'Обезличить данные человека?' });
		await openDialog(panel(page).getByRole('button', { name: 'Обезличить данные' }), confirm);
		await confirm.getByRole('button', { name: 'Обезличить', exact: true }).click();

		await expect(page.getByText('Данные обезличены', { exact: true })).toBeVisible();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Обезличено');
		// Правки у обезличенной записи нет: стёртое не возвращают той же строкой.
		await expect(page.getByRole('link', { name: 'Изменить' })).toHaveCount(0);
		await expect(page.getByText(RETENTION_LAST_NAME)).toHaveCount(0);
	}
);
