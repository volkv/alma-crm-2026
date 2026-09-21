/**
 * Что снимает `capture.ts --set=help`: кадры встроенной справки.
 *
 * Статья руководства объясняет экран словами, и до снимка читателю приходится
 * держать этот экран в голове. Поэтому кадры здесь не украшение: они показывают
 * то самое место, о котором идёт речь, — и устаревают так же молча, как кадры
 * README. Список объявлен рядом со списком README и снимается тем же скриптом:
 * пересобрать справку одной командой важнее, чем сэкономить файл.
 *
 * Имя кадра — путь внутри `static/help/`: `user/start-1` даёт
 * `static/help/user/start-1.png`, а статья ссылается на него абсолютным адресом
 * `/help/user/start-1.png`. Абсолютным, потому что тот же текст показывает
 * версия для печати (`/help/print`), лежащая на другом уровне адреса: ссылка
 * относительная развалилась бы ровно там, откуда собирают PDF.
 */
import { seedId } from '../seed/ids.ts';
import type { Frame } from './capture.ts';
import { HOME_INTRO, reachHomeIntro } from './shots.ts';

/** Взаимодействие, на котором показана карточка. Оно же снято для README. */
const DEMO_INTERACTION = seedId('interaction', 'szpu-vo');

/** Взаимодействие с длинной историей: на нём видна лента переходов. */
const DEMO_HISTORY_INTERACTION = seedId('interaction', 'batse-kontrol');

/**
 * Взаимодействие на подписании соглашения с приложенным подписанным экземпляром:
 * его стадия подтверждена не отметкой ответственного, а отметкой по документу.
 */
const DEMO_SIGNED_INTERACTION = seedId('interaction', 'bit-telecom');

/** Вуз, у которого ответственность разделена по направлениям. */
const DEMO_ORGANIZATION = seedId('organization', 'szpu');

/**
 * Окно съёмки: уже, чем у README.
 *
 * Кадр стоит внутри статьи, а колонка статьи не шире 68 знаков, и снимок с
 * окна в 1920 точек читатель видит уменьшенным вдвое — вместе с подписями,
 * ради которых его и показывают. 1280 — та же ширина, на которой проверяются
 * разделы в прогоне.
 */
export const HELP_VIEWPORT = { width: 1280, height: 860 } as const;

/**
 * Прокрутить страницу к блоку, о котором статья говорит.
 *
 * После прокрутки страница отступает назад на высоту верхней панели: она
 * закреплена сверху и иначе закрывает собой ровно тот заголовок, ради которого
 * прокручивали.
 */
function scrollTo(text: string): (page: import('@playwright/test').Page) => Promise<void> {
	const TOP_BAR = 96;

	return async (page) => {
		// Совпадение точное: заголовок блока ищется целиком, а не куском текста.
		// Полоса демонстрационного режима наверху страницы упоминает и договоры, и
		// продукты, и вузы — по куску текста прокрутка нашла бы её и осталась на
		// месте, не сказав ни слова.
		const target = page.getByText(text, { exact: true }).first();

		await target.waitFor({ state: 'visible', timeout: 20_000 });
		await page.mouse.move(HELP_VIEWPORT.width / 2, HELP_VIEWPORT.height / 2);

		// Колесом, а не `scrollIntoView`: прокручивается то же, что прокрутил бы
		// человек, — какой бы слой страницы ни был прокручиваемым. Дважды,
		// потому что карточки догружают содержимое и первая прокрутка уезжает
		// вместе с ним.
		for (const _ of [0, 1]) {
			const box = await target.boundingBox();

			if (box === null) {
				throw new Error(`Блок «${text}» не виден на странице`);
			}

			await page.mouse.wheel(0, box.y - TOP_BAR);
			await page.waitForTimeout(400);
		}
	};
}

export const HELP_SHOTS: readonly Frame[] = [
	{
		name: 'user/start-1',
		path: '/',
		role: 'manager',
		caption: 'Сводка: шесть чисел, портфель по группам стадий и списки дел',
		waitFor: 'Требуют действия'
	},
	{
		name: 'user/start-2',
		path: '/',
		role: 'manager',
		caption: 'Быстрый поиск: разделы и найденные записи по группам',
		waitFor: 'Организации',
		prepare: async (page) => {
			await page.keyboard.press('Control+k');
			await page.getByPlaceholder('Что ищем?').fill('поли');
		}
	},
	{
		name: 'user/start-3',
		path: '/',
		role: 'manager',
		caption: 'Полный тур: карточка вступления «Сводки» с полосой прогресса и оглавлением',
		waitFor: HOME_INTRO,
		tour: true,
		prepare: reachHomeIntro
	},
	{
		name: 'user/interactions-1',
		path: '/interactions',
		role: 'manager',
		caption: 'Список взаимодействий: фильтры, колонки, сроки',
		waitFor: 'Взаимодействия'
	},
	{
		name: 'user/interactions-2',
		path: '/interactions?view=board',
		role: 'manager',
		caption: 'Доска: те же записи колонками по стадиям',
		waitFor: 'Взаимодействия'
	},
	{
		name: 'user/interaction-1',
		path: `/interactions/${DEMO_INTERACTION}`,
		role: 'manager',
		caption: 'Карточка: что происходит, что мешает, кто должен, что могу сейчас',
		waitFor: 'Что мешает'
	},
	{
		name: 'user/interaction-2',
		path: `/interactions/${DEMO_HISTORY_INTERACTION}`,
		role: 'manager',
		caption: 'История переходов: исход, длительность, причины и вложения',
		waitFor: 'Что происходит',
		tab: 'История'
	},
	{
		name: 'user/interaction-3',
		path: `/interactions/${DEMO_SIGNED_INTERACTION}`,
		role: 'manager',
		caption: 'Стадия подписания, подтверждённая отметкой по документу дела',
		waitFor: 'Подтверждено отметкой документа',
		prepare: scrollTo('Подтверждено отметкой документа')
	},
	{
		name: 'user/documents-1',
		path: '/documents',
		role: 'manager',
		caption: 'Документы: вид, формат, отметки, редакции',
		waitFor: 'Документы'
	},
	{
		name: 'user/documents-2',
		// Поиском, а не первой строкой списка: сверху лежит самый свежий файл, и
		// после любого показа на стенде им оказывается случайное вложение к
		// переходу. Статья говорит про редакции — нужен документ, у которого их
		// две, а такой в наборе один.
		path: `/documents?q=${encodeURIComponent('Скан подписанного соглашения')}`,
		role: 'manager',
		caption: 'Карточка документа: отметки и список редакций',
		waitFor: 'Редакции',
		prepare: async (page) => {
			// Ссылка на карточку, а не на файл: в строке есть и та и другая, и
			// вторая скачала бы документ вместо того, чтобы его открыть.
			await page.locator('table a[href^="/documents/"]:not([href$="/download"])').first().click();
		}
	},
	{
		name: 'user/directory-1',
		path: '/organizations',
		role: 'manager',
		caption: 'Справочник организаций: вид, уровень образования, площадки',
		waitFor: 'Организации'
	},
	{
		name: 'user/directory-2',
		path: `/organizations/${DEMO_ORGANIZATION}`,
		role: 'manager',
		caption: 'Карточка вуза: кто за него отвечает и по каким направлениям',
		waitFor: 'Ответственные',
		prepare: scrollTo('Ответственные')
	},
	{
		name: 'user/directory-3',
		path: `/organizations/${DEMO_ORGANIZATION}`,
		role: 'manager',
		caption: 'Договоры вуза: номер, сроки, состояние и позиции по продуктам',
		// Ждём подпись блока, а не его заголовок: слово «договоры» есть и в полосе
		// демонстрационного режима, которая стоит на странице всегда.
		waitFor: 'Обязательства с этим контрагентом',
		prepare: scrollTo('Договоры')
	},
	{
		name: 'user/catalog-import-1',
		path: '/organizations/import',
		role: 'lead',
		caption: 'Импорт каталога: файл, примечание и последние загрузки',
		waitFor: 'Импорт каталога'
	},
	{
		name: 'user/programs-1',
		path: '/programs',
		role: 'manager',
		caption: 'Программы: уровень, направление подготовки, версии',
		waitFor: 'Программы'
	},
	{
		name: 'user/programs-2',
		path: '/products',
		role: 'manager',
		caption: 'Продукты: правообладатель и состояние',
		waitFor: 'Продукты'
	},
	{
		name: 'user/programs-3',
		path: '/directions',
		role: 'manager',
		caption: 'Направления: порядок, код, сколько продуктов и программ собрано',
		waitFor: 'ИТ-направления оператора'
	},
	{
		name: 'user/reports-1',
		path: '/reports',
		role: 'manager',
		caption: 'Срез: фильтры, распределение по стадиям и таблица',
		waitFor: 'Отчёты по взаимодействиям'
	},
	{
		name: 'user/reports-2',
		path: '/reports?mode=movement',
		role: 'manager',
		caption: 'Движение: события периода по видам',
		waitFor: 'Каждая строка — один переход'
	},
	{
		name: 'user/data-1',
		path: '/data/new',
		role: 'lead',
		caption: 'Загрузка данных об обучении: файл, источник, режим и период',
		waitFor: 'Загрузка'
	},
	{
		name: 'user/data-2',
		path: '/data/dashboard',
		role: 'manager',
		caption: 'Дашборд данных: картина одного отчётного периода',
		waitFor: 'Данные'
	},
	{
		name: 'user/exchange-1',
		// Запись с заведённым потоком, а не первая попавшаяся: пустая панель
		// показала бы только форму заявки, а статья говорит и про то, что
		// присылает система обучения обратно.
		path: `/interactions/${DEMO_HISTORY_INTERACTION}`,
		role: 'manager',
		caption: 'Панель «Система обучения»: заявка на группу и строка потока с результатом',
		waitFor: 'Система обучения',
		prepare: scrollTo('Система обучения')
	},
	{
		name: 'admin/process-1',
		path: '/settings/process',
		role: 'admin',
		caption: 'Группы процесса: действующая редакция, черновик, число записей',
		waitFor: 'Процесс'
	},
	{
		name: 'admin/process-2',
		path: '/settings/process/b2b',
		role: 'admin',
		caption: 'Стадии действующей редакции и черновик изменений',
		waitFor: 'Черновик изменений'
	},
	{
		/**
		 * Не список учётных записей: на публичном стенде его не снять.
		 * Демонстрационная сессия не получает права «Управление пользователями и
		 * ролями» ни при какой роли, и `/settings/users` отвечает ей отказом —
		 * это та самая граница демонстрации, о которой написано в соседней
		 * статье. Кадр показывает группу «Настройки» в меню — где раздел живёт и
		 * чем он открывается.
		 */
		name: 'admin/users-1',
		path: '/settings/profile',
		role: 'admin',
		caption: 'Меню, группа «Настройки»: каждый пункт за своим правом',
		waitFor: 'Профиль'
	},
	{
		name: 'admin/access-1',
		path: '/login',
		role: 'anonymous',
		caption: 'Вход и карточка демонстрационного стенда с тремя ролями',
		waitFor: 'Войти'
	},
	{
		name: 'admin/integrations-1',
		path: '/settings/integrations',
		role: 'admin',
		caption: 'Интеграции: подписки на события, обмен и система обучения',
		waitFor: 'Интеграции'
	},
	{
		name: 'admin/exchange-1',
		path: '/exchange',
		role: 'admin',
		caption: 'Журнал обмена: обе стороны одним списком, состояния и попытки',
		waitFor: 'Внешние системы'
	},
	{
		name: 'admin/exchange-2',
		path: '/settings/integrations',
		role: 'admin',
		caption: 'Подключения обмена: экземпляры CMS и системы обучения, приём заявок',
		waitFor: 'Обмен с CMS и системой обучения',
		prepare: scrollTo('Обмен с CMS и системой обучения')
	},
	{
		name: 'admin/audit-1',
		path: '/audit',
		role: 'admin',
		caption: 'Журнал действий: событие, результат, кто действовал, над чем',
		waitFor: 'Журнал'
	},
	{
		name: 'admin/settings-1',
		path: '/settings/general',
		role: 'admin',
		caption: 'Общие настройки: страница входа, сроки сессии, демо-данные',
		waitFor: 'Общие'
	},
	{
		name: 'admin/notifications-1',
		path: '/notifications',
		role: 'admin',
		// Прокручивать таблицу вбок больше не нужно: «Попытки» и «Подробности»
		// на ширине съёмки прячутся сами, а остальные семь колонок помещаются
		// целиком — кому ушло, чем и дошло ли, видно без прокрутки.
		caption: 'Журнал уведомлений: взаимодействие, получатель, канал и состояние доставки',
		waitFor: 'Как это работает'
	},
	{
		name: 'admin/errors-1',
		// Несуществующая запись с правильным по форме идентификатором: маршрут
		// такой адрес принимает, а сервис отвечает «не найдено». Это самый
		// дешёвый способ снять настоящую страницу отказа — с кодом обращения,
		// который система выдала на этот самый запрос, а не подставленным в кадр.
		path: '/interactions/00000000-0000-4000-8000-000000000000',
		role: 'manager',
		caption: 'Страница отказа: код ответа, фраза сервера и код обращения',
		waitFor: 'Код обращения'
	}
];
