import type { Page } from '@playwright/test';
import { expect, leadTest as test } from './fixtures';
import { waitForHydration } from './helpers/hydration';

/**
 * Дата, набранная до того, как страница ожила.
 *
 * Разметку страница получает с сервера готовой, а обработчики к ней развешивает
 * браузер: форма на экране уже есть и текст принимает, но `oninput` поля даты до
 * компонента ещё не доходит. Значение формы несёт скрытое поле, и написанное в
 * это окно попадало бы только в разметку — форма ушла бы с тем, что подставил
 * сервер. На «Загрузке данных» это начало текущего учебного года: снимок лёг бы
 * не в тот период, и человек увидел бы это только в карточке.
 *
 * Окно узкое, но оно есть на каждой загрузке и на занятой машине растягивается с
 * десятков миллисекунд до секунд. Поэтому здесь оно держится нарочно: файлы
 * приложения не отдаются, пока проверка не наберёт дату.
 */

/** Дата, которую пишет проверка: заведомо не та, что предлагает страница. */
const TYPED_RU = '17.03.2024';
const TYPED_ISO = '2024-03-17';

/** Видимое поле: в нём человек пишет `17.03.2024`. */
function visibleField(page: Page) {
	return page.locator('#periodStart');
}

/** Скрытое поле: с ним форма уходит на сервер, и дата в нём как `2024-03-17`. */
function submittedField(page: Page) {
	return page.locator('input[type="hidden"][name="periodStart"]');
}

/**
 * Открывает форму, придержав файлы приложения. Возвращает отпускающую их
 * функцию: до её вызова страница — это разметка без единого обработчика.
 */
async function openBeforeHydration(page: Page): Promise<() => void> {
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let heldRequests = 0;

	await page.route('**/_app/immutable/**/*.js', async (route) => {
		heldRequests += 1;
		await gate;
		await route.continue();
	});

	// `commit`, а не загрузка целиком: файлы приложения задержаны нарочно, и
	// ждать их — значит ждать собственного сигнала.
	await page.goto('/data/new', { waitUntil: 'commit' });

	await expect(visibleField(page)).toBeVisible();
	// Страница ещё не ожила: обработчиков у поля нет, отметки на `<body>` тоже.
	await expect(page.locator('body[data-hydrated]')).toHaveCount(0);
	// И это заслуга проверки, а не случайно медленного браузера: файлы приложения
	// действительно задержаны. Без этой строки перестань правило совпадать с
	// именами файлов сборки — и проверка молча стала бы проверять пустоту.
	expect(heldRequests).toBeGreaterThan(0);

	return release;
}

test('дата, набранная до гидратации, доходит до формы', async ({ page }) => {
	const release = await openBeforeHydration(page);

	// Сервер предложил начало учебного года — значит, набранное ещё не в форме.
	await expect(submittedField(page)).not.toHaveValue(TYPED_ISO);

	await visibleField(page).fill(TYPED_RU);

	release();
	await waitForHydration(page);

	// Гидратация не стирает набранное и доводит его до значения формы.
	await expect(visibleField(page)).toHaveValue(TYPED_RU);
	await expect(submittedField(page)).toHaveValue(TYPED_ISO);
});

test('недописанная до гидратации дата не становится значением', async ({ page }) => {
	const release = await openBeforeHydration(page);

	await visibleField(page).fill('17.03');

	release();
	await waitForHydration(page);

	// Половина даты — не дата, и подставленный сервером день её не заменяет:
	// иначе форма ушла бы с датой, которой на экране никто не видел.
	await expect(visibleField(page)).toHaveValue('17.03');
	await expect(submittedField(page)).toHaveValue('');
});
