/**
 * Что снимает `capture.ts`: список кадров README.
 *
 * Список вынесен из скрипта, потому что меняется он чаще самого скрипта:
 * появился экран — здесь прибавилась строка, и снимок пересобирается той же
 * командой, а не чьей-то памятью о том, как был сделан предыдущий.
 *
 * Имя кадра — имя файла в `docs/media/`: `reports` даёт `docs/media/reports.png`,
 * и README ссылается ровно на него.
 */
import { seedId } from '../seed/ids.ts';
import type { Page } from '@playwright/test';
import type { Frame } from './capture.ts';

/**
 * Взаимодействие, которое показывают на карточке.
 *
 * Идентификатор берётся у набора данных, а не переписан сюда числом: набор
 * детерминирован, и адрес карточки на любом стенде получается один и тот же —
 * пока эта запись в наборе есть. Пропала — скрипт честно не снимет кадр, а не
 * снимет чужую работу.
 */
const DEMO_INTERACTION = seedId('interaction', 'szpu-vo');

/** Взаимодействие с длинной историей: на нём видно, что лента переходов не пуста. */
const DEMO_HISTORY_INTERACTION = seedId('interaction', 'batse-kontrol');

/**
 * Вуз с настоящим сайтом: у СПбПУ (и ещё у четырёх вузов стенда) домен
 * настоящий, а не вымышленный, поэтому раздел «Сведения с сайта» на нём
 * действительно читается (`scripts/seed/directory.ts`).
 */
const DEMO_ORGANIZATION = seedId('organization', 'szpu');

/** Кем открыт экран. Имя входа демонстрационной записи каталога. */
export type ShotRole = 'manager' | 'lead' | 'admin' | 'anonymous';

export type Shot = {
	/** Имя файла без расширения. */
	name: string;
	/** Адрес внутри стенда. */
	path: string;
	role: ShotRole;
	/** Что на кадре — для `--list` и для проверки, что README не отстал. */
	caption: string;
	/**
	 * Ждать этот текст перед съёмкой.
	 *
	 * Не «подождать секунду»: страница отдаётся с сервера готовой, а живой её
	 * делает браузер, и секунда на занятой машине ничего не гарантирует. Ждать
	 * надо то, ради чего кадр и снимают.
	 */
	waitFor?: string;
	/**
	 * Страница вне оболочки приложения — например, Swagger UI. Признака
	 * «ожила» такая страница не ставит: её собирает чужой скрипт, а не наш
	 * корневой layout.
	 */
	standalone?: boolean;
	/** Снять страницу целиком, а не только видимую часть окна. */
	fullPage?: boolean;
	/**
	 * Снять с подсказками первого входа.
	 *
	 * Остальные кадры их закрывают: браузер съёмки каждый раз чистый, и тур
	 * открылся бы поверх любого экрана. Этому кадру они и нужны — он снимается в
	 * своей сессии, в которой человек только что вошёл впервые.
	 */
	tour?: boolean;
	/**
	 * Тема, выбранная на кадре переключателем в шапке. По умолчанию светлая — та
	 * же, что видит человек, впервые открывший систему.
	 */
	theme?: 'dark';
	/**
	 * Своё окно для кадра. Нужно там, где страница не заполняет экран: вход —
	 * карточка посреди пустоты, и в окне рабочего размера от снимка остаются
	 * поля шире самой карточки.
	 */
	viewport?: { width: number; height: number };
};

/** Окно съёмки: тот же размер, что у снимков, уже лежащих в `docs/media/`. */
export const VIEWPORT = { width: 1920, height: 1200 } as const;

/**
 * Заголовок вступления «Сводки» в подсказках.
 *
 * Кадр тура снимается не на первой карточке: сначала приветствие, потом шаги
 * оболочки, и только за ними идёт первый экран. Скрипт жмёт «Далее», пока не
 * увидит этот заголовок, — считать шаги оболочки числом значило бы чинить кадр
 * каждый раз, когда в шапке что-то прибавится.
 */
/** Заголовок вступления «Сводки» — первого экрана полного тура каждой роли. */
export const HOME_INTRO = 'Сводка: с чего начинают день';

/**
 * Довести полный тур до вступления «Сводки»: приветствие → «Начать тур» →
 * шаги оболочки. Кадр тура снимают и README, и справка — один и тот же путь.
 */
export async function reachHomeIntro(page: Page): Promise<void> {
	const tour = page.getByTestId('onboarding-tour');

	await tour.waitFor({ state: 'visible', timeout: 20_000 });
	await tour.getByRole('button', { name: 'Начать тур' }).click();

	const intro = tour.getByRole('heading', { name: HOME_INTRO });

	// Предел на случай, если тур до «Сводки» почему-то не доходит: молчаливый
	// бесконечный цикл в скрипте съёмки хуже честно не снятого кадра.
	for (let step = 0; step < 12 && (await intro.count()) === 0; step += 1) {
		await tour.getByRole('button', { name: 'Далее' }).click();
	}
}

export const SHOTS: readonly Frame[] = [
	{
		name: 'login',
		path: '/login',
		role: 'anonymous',
		caption: 'Страница входа: кнопка в каталог учётных записей и карточка демонстрации',
		waitFor: 'Войти',
		viewport: { width: 1100, height: 760 }
	},
	{
		name: 'home',
		path: '/',
		role: 'manager',
		caption: 'Сводка: «Мой день» по разделам, шесть чисел портфеля и полоса по группам стадий',
		waitFor: 'Мой день'
	},
	{
		name: 'interactions-board',
		path: '/interactions?view=board',
		role: 'manager',
		caption: 'Доска взаимодействий по стадиям',
		waitFor: 'Взаимодействия'
	},
	{
		name: 'interactions-overdue',
		path: '/interactions?overdue=true',
		role: 'manager',
		caption: 'Список с фильтром просроченных',
		waitFor: 'Взаимодействия'
	},
	{
		name: 'interaction-card',
		path: `/interactions/${DEMO_INTERACTION}`,
		role: 'manager',
		caption: 'Карточка: факты и полоса стадий сверху, главное действие с условиями, контекст сбоку',
		waitFor: 'Все стадии процесса'
	},
	{
		name: 'interaction-history',
		path: `/interactions/${DEMO_HISTORY_INTERACTION}`,
		role: 'manager',
		caption: 'Единая лента событий вместо вкладок: переходы, комментарии, документы и обмен подряд',
		waitFor: 'Все стадии процесса',
		fullPage: true
	},
	{
		name: 'automation',
		path: '/automation',
		role: 'manager',
		caption:
			'Карта автоматизации: 14 шагов процесса, что делает система на каждом и где это увидеть',
		waitFor: 'Карта автоматизации'
	},
	{
		name: 'documents',
		path: '/documents',
		role: 'manager',
		caption: 'Документы взаимодействий: редакции, отметки, скачивание',
		waitFor: 'Документы'
	},
	{
		name: 'data-indicators',
		path: '/data/indicators',
		role: 'manager',
		caption: 'Показатели по программам и организациям с происхождением чисел',
		waitFor: 'Показатели'
	},
	{
		name: 'integrations',
		path: '/settings/integrations',
		role: 'admin',
		caption: 'Интеграции: подписки на события и подключения обмена',
		waitFor: 'Интеграции',
		fullPage: true
	},
	{
		name: 'reports',
		path: '/reports',
		role: 'manager',
		caption:
			'Отчёты: срез и движение, фильтры, диаграммы, четыре формата выгрузки, PDF — сводкой или целиком',
		waitFor: 'Отчёты по взаимодействиям'
	},
	{
		name: 'reports-movement',
		path: '/reports?mode=movement',
		role: 'manager',
		caption: 'Отчёт в режиме движения: события периода по видам',
		waitFor: 'Каждая строка — один переход'
	},
	{
		name: 'settings-process',
		path: '/settings/process',
		role: 'admin',
		caption: 'Процесс: группы контрагентов и действующие редакции',
		waitFor: 'Процесс'
	},
	{
		name: 'settings-process-stages',
		path: '/settings/process/b2b',
		role: 'admin',
		caption: 'Стадии действующего процесса и черновик изменений',
		waitFor: 'Черновик изменений',
		fullPage: true
	},
	{
		name: 'exchange',
		path: '/exchange',
		role: 'admin',
		caption: 'Внешние системы: журнал обмена в обе стороны',
		waitFor: 'Внешние системы'
	},
	{
		name: 'roles',
		path: '/settings/roles',
		role: 'admin',
		caption: 'Роли и права: матрица «право × роль», прочитанная прямо из базы',
		waitFor: 'Роли и права'
	},
	{
		name: 'diagnostics',
		path: '/settings/diagnostics',
		role: 'admin',
		caption: 'Самодиагностика: с чем система соединяется и отвечает ли это сейчас',
		waitFor: 'Связи и зависимости'
	},
	{
		name: 'help',
		path: '/help',
		role: 'manager',
		caption: 'Встроенная справка: два руководства и версия для печати',
		waitFor: 'Руководство пользователя'
	},
	{
		name: 'organizations',
		path: '/organizations',
		role: 'manager',
		caption: 'Справочник организаций',
		waitFor: 'Организации'
	},
	{
		name: 'organization-card',
		path: `/organizations/${DEMO_ORGANIZATION}`,
		role: 'manager',
		caption:
			'Карточка вуза: факты и главное действие сверху, «Сведения с сайта» — кандидаты в контакты и подбор программ',
		waitFor: 'Сведения с сайта вуза',
		prepare: async (page) => {
			await page.getByRole('button', { name: /Прочитать «Сведения» на сайте|Перечитать/ }).click();
			await page
				.getByText('Кандидаты в контакты')
				.first()
				.waitFor({ state: 'visible', timeout: 20_000 });
		}
	},
	{
		name: 'data-dashboard',
		path: '/data/dashboard',
		role: 'manager',
		caption: 'Дашборд данных об обучении',
		waitFor: 'Данные'
	},
	{
		name: 'ranking',
		path: '/data/ranking',
		role: 'manager',
		caption: 'Рейтинг программ и направлений по фактам самой системы за период',
		waitFor: 'Рейтинг программ и направлений'
	},
	{
		name: 'audit',
		path: '/audit',
		role: 'admin',
		caption: 'Журнал действий',
		waitFor: 'Журнал'
	},
	{
		name: 'api-docs',
		path: '/api/docs',
		role: 'manager',
		caption: 'Swagger UI по OpenAPI 3.1, собранному из тех же схем',
		waitFor: 'LCT CRM API',
		standalone: true
	},
	{
		name: 'data-import',
		path: '/data/new',
		role: 'admin',
		caption: 'Мастер загрузки статистики: файл, период, режим',
		waitFor: 'Загрузка'
	},
	{
		name: 'ui-kit',
		path: '/ui-kit',
		role: 'manager',
		caption: 'Витрина компонентов и токенов темы',
		waitFor: 'UI-кит'
	},
	{
		name: 'theme-dark',
		path: '/reports',
		role: 'manager',
		caption: 'Тёмная тема: те же токены, диаграммы берут цвета оттуда же',
		// Отчёты, а не сводка: тема меняет не только фон, но и цвета диаграмм, а
		// проверить это можно только там, где диаграммы есть.
		waitFor: 'Отчёты по взаимодействиям',
		theme: 'dark'
	},
	{
		name: 'onboarding',
		path: '/',
		role: 'manager',
		caption: 'Полный тур: карточка шага с полосой прогресса и оглавлением',
		waitFor: HOME_INTRO,
		tour: true,
		prepare: reachHomeIntro
	},
	{
		name: 'help-menu',
		path: '/interactions',
		role: 'manager',
		caption: 'Значок «?» в шапке: подсказки по экрану, полный тур и статья справки',
		waitFor: 'Этот экран: Взаимодействия',
		prepare: async (page) => {
			await page.getByRole('button', { name: 'Подсказки и справка' }).click();
			await page
				.getByRole('menuitem', { name: 'Подсказки по этому экрану' })
				.waitFor({ state: 'visible', timeout: 20_000 });
		}
	}
];
