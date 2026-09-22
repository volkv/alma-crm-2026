import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { STAFF_ADMIN_STATE } from './global-setup';
import { waitForHydration } from './helpers/hydration';

/**
 * Подсказки по экранам сопровождения: журналы, обмен и настройки.
 *
 * Проверяется обещание самодокументированной системы на той её половине, где
 * человек оказывается реже всего и знает меньше всего: значок «?» открывает
 * рассказ про открытый экран, и каждый шаг этого рассказа показывает пальцем на
 * элемент, который на экране действительно есть. Шаг, чьего блока сейчас нет
 * (журнал без единой доставки), обязан сказать об этом своими словами — это
 * обычное состояние тура, а не отказ.
 *
 * Сессия — штатный администратор стенда, а не демонстрационный: под ним стенд
 * и администрируют. Демонстрационному сейчас отняты только адреса интеграций
 * (`DEMO_DENIED_PERMISSIONS`), и экранов тура это не касается.
 * Состав шагов по ролям и правам закрыт модульными проверками
 * (`tests/unit/onboarding`), здесь проверяется попадание в разметку.
 */
const admin = base.extend<object>({ storageState: STAFF_ADMIN_STATE });

/**
 * Шаг тура глазами прогона: как называется и вокруг чего обязан встать.
 *
 * `hint` заполняется только там, где блока на экране может не быть в самом
 * прогоне: журнал доставок пуст, пока ни одно взаимодействие не простояло
 * дольше порога. Шаг без `hint` обязан найти свой элемент — иначе снятая метка
 * прошла бы незамеченной.
 */
type Step = { title: string; target: string; hint?: string };

/** Что карточка говорит о шаге, которому не оставили собственной подсказки. */
const NO_BLOCK = 'На этом экране блока сейчас нет';

function tourOf(page: Page): Locator {
	return page.getByTestId('onboarding-tour');
}

/** Открыть экран и дождаться, пока он оживёт: до этого меню «?» не отвечает. */
async function openScreen(page: Page, address: string): Promise<void> {
	await page.goto(address);
	await waitForHydration(page);
}

/** Подсказки по текущему экрану — тем же путём, каким их открывает человек. */
async function startScreenTour(page: Page, intro: string): Promise<Locator> {
	const tour = tourOf(page);
	const trigger = page.getByRole('button', { name: 'Подсказки и справка' });
	const item = page.getByRole('menuitem', { name: 'Подсказки по этому экрану' });

	// Меню открывает код страницы: нажатие до того, как она ожила, теряется
	// совсем (`docs/development.md`, «Всплывающие слои»).
	await expect(async () => {
		await trigger.click();
		await expect(item).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await item.click();

	await expect(tour).toBeVisible();
	// Тур экрана начинается со вступления, а не с приветствия системы.
	await expect(tour.getByRole('heading', { level: 2 })).toHaveText(intro);

	return tour;
}

/** Один шаг: рамка встала вокруг элемента — или карточка объяснила, почему нет. */
async function expectStep(page: Page, tour: Locator, step: Step): Promise<void> {
	await expect(tour.getByRole('heading', { level: 2 })).toHaveText(step.title);

	const element = page.locator(`[data-tour="${step.target}"]`).first();

	if (step.hint !== undefined && !(await element.isVisible())) {
		// Данных под шаг сейчас нет. Карточка обязана сказать об этом словами
		// самого шага, а не общей отговоркой «блока нет».
		await expect(tour).toContainText(step.hint);
		await expect(tour).not.toContainText(NO_BLOCK);

		return;
	}

	await expect(element).toBeVisible();
	// Элемент найден — строки о пропущенном шаге в карточке нет.
	await expect(tour).not.toContainText(NO_BLOCK);

	if (step.hint !== undefined) {
		await expect(tour).not.toContainText(step.hint);
	}
}

/** Пройти тур экрана «Далее» до «Готово», проверяя каждый шаг. */
async function walkScreenTour(page: Page, tour: Locator, steps: readonly Step[]): Promise<void> {
	for (const step of steps) {
		await tour.getByRole('button', { name: 'Далее' }).click();
		await expectStep(page, tour, step);
	}

	// Последний шаг тура экрана предлагает статью справки и кончается «Готово».
	await tour.getByRole('button', { name: 'Готово' }).click();
	await expect(tour).toBeHidden();
}

admin('подсказки журнала действий показывают отбор, ленту и выгрузку', async ({ page }) => {
	await openScreen(page, '/audit');

	const tour = await startScreenTour(page, 'Журнал действий');

	await walkScreenTour(page, tour, [
		{ title: 'Отбор: период, событие, результат', target: 'audit-filters' },
		{ title: 'Лента событий', target: 'audit-events' },
		{ title: 'Выгрузка', target: 'audit-export' }
	]);
});

admin('подсказки уведомлений объясняют правило, отбор и повтор', async ({ page }) => {
	await openScreen(page, '/notifications');

	const tour = await startScreenTour(page, 'Уведомления');

	await walkScreenTour(page, tour, [
		{ title: 'Когда уходит напоминание', target: 'notifications-log' },
		{ title: 'Отбор по состоянию и каналу', target: 'notifications-filters' },
		{
			title: 'Кому ушло и дошло ли',
			target: 'notifications-deliveries',
			// Доставки появляются, только когда сработала эскалация: в сиде их нет.
			hint: 'Доставок пока нет'
		},
		{
			title: 'Повтор неудавшейся отправки',
			target: 'notifications-retry',
			hint: 'Повтор стоит в строке доставки, которую есть смысл повторить'
		}
	]);
});

admin('подсказки внешних систем ведут от кнопки показа к журналу обмена', async ({ page }) => {
	await openScreen(page, '/exchange');

	const tour = await startScreenTour(page, 'Внешние системы');

	await walkScreenTour(page, tour, [
		{ title: 'Показ: заявка с сайта', target: 'exchange-demo' },
		{ title: 'Отбор: направление, система, состояние', target: 'exchange-filters' },
		{ title: 'Журнал обмена', target: 'exchange-journal' }
	]);
});

admin('подсказки пользователей показывают список, подчинение и выключение', async ({ page }) => {
	await openScreen(page, '/settings/users');

	// Сессия штатная, а не демонстрационная: экран открылся, а не ответил 403.
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Пользователи');

	const tour = await startScreenTour(page, 'Пользователи');

	await walkScreenTour(page, tour, [
		{ title: 'Кто работает в системе', target: 'users-list' },
		{ title: 'Кому сотрудник подчиняется', target: 'users-manager' },
		{ title: 'Выключение и отвязка', target: 'users-actions' }
	]);
});

admin('подсказки ключей доступа показывают выпуск, список и отзыв', async ({ page }) => {
	await openScreen(page, '/settings/api-keys');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ключи доступа');

	const tour = await startScreenTour(page, 'Ключи доступа');

	await walkScreenTour(page, tour, [
		{ title: 'Выпуск ключа', target: 'api-keys-issue' },
		{ title: 'Выпущенные ключи', target: 'api-keys-list' },
		{
			title: 'Отзыв',
			target: 'api-keys-revoke',
			hint: 'Кнопка отзыва стоит в строке действующего ключа'
		}
	]);
});

admin('подсказки общих настроек обходят все четыре карточки', async ({ page }) => {
	await openScreen(page, '/settings/general');

	const tour = await startScreenTour(page, 'Общие');

	await walkScreenTour(page, tour, [
		{ title: 'Страница входа', target: 'general-banner' },
		{ title: 'Сроки жизни сессии', target: 'general-sessions' },
		{ title: 'Порог зависания и каналы', target: 'general-stuck' },
		{ title: 'Сброс демонстрационных данных', target: 'general-demo' }
	]);
});

admin('подсказки процесса доводят от списка групп до входа в редактор', async ({ page }) => {
	await openScreen(page, '/settings/workflows');

	const tour = await startScreenTour(page, 'Процесс');

	await walkScreenTour(page, tour, [
		{ title: 'Процесс описан данными', target: 'workspaces' },
		{ title: 'Вход в редактор процесса', target: 'process-open' }
	]);
});

admin('подсказки редактора процесса открываются на группе из списка', async ({ page }) => {
	await openScreen(page, '/settings/workflows');

	// Адрес редактора несёт ключ группы, и придумать его тур не может: сюда
	// приходят строкой списка — так же, как пришёл бы человек.
	await page.getByRole('link', { name: 'Открыть процесс: Учебные заведения' }).click();
	await page.waitForURL('**/settings/workflows/b2b');
	await waitForHydration(page);

	const tour = await startScreenTour(page, 'Редактор процесса группы');

	await walkScreenTour(page, tour, [
		{ title: 'Черновик и применение', target: 'process-group-draft' },
		{ title: 'Стадии и нормативы', target: 'process-group-stages' },
		{ title: 'Переходы между стадиями', target: 'process-group-transitions' }
	]);
});

admin('подсказки интеграций обходят подписки, систему обучения и обмен', async ({ page }) => {
	await openScreen(page, '/settings/integrations');

	const tour = await startScreenTour(page, 'Интеграции');

	await walkScreenTour(page, tour, [
		{ title: 'Подписки на события', target: 'integrations-webhooks' },
		{ title: 'Система обучения', target: 'integrations-lms' },
		{ title: 'Обмен с CMS и системой обучения', target: 'integrations-exchange' }
	]);
});
