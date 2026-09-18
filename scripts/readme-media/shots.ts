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
	/**
	 * Вкладка карточки, которую надо открыть перед съёмкой.
	 *
	 * Вкладка — состояние страницы, а не адрес: открыть её ссылкой нельзя, и без
	 * этого шага кадр «История» повторял бы кадр «Стадия».
	 */
	tab?: string;
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

export const SHOTS: readonly Shot[] = [
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
		caption: 'Сводка: что требует внимания сегодня',
		waitFor: 'Требуют действия'
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
		caption: 'Карточка: что происходит, что мешает, кто должен действовать, что могу сейчас',
		waitFor: 'Что мешает'
	},
	{
		name: 'interaction-history',
		path: `/interactions/${DEMO_HISTORY_INTERACTION}`,
		role: 'manager',
		caption: 'История переходов с причинами и вложениями',
		waitFor: 'Что происходит',
		tab: 'История'
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
		caption: 'Отчёты: срез и движение, фильтры, диаграммы, четыре формата выгрузки',
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
		name: 'data-dashboard',
		path: '/data/dashboard',
		role: 'manager',
		caption: 'Дашборд данных об обучении',
		waitFor: 'Данные'
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
		caption: 'Подсказки первого входа: рамка вокруг блока и карточка шага',
		waitFor: 'Сводка: что требует действия',
		tour: true
	}
];
