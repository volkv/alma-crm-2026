/**
 * Карта автоматизации: что система берёт на себя на каждом из четырнадцати
 * шагов базового процесса работы с вузом.
 *
 * Шаг назван ключом стадии процесса `b2b` (`$lib/server/stages/definitions`),
 * а не своим текстом: название стадии страница берёт из самого процесса, и
 * карта не может разойтись с тем, что человек видит на доске. Экран «где это»
 * назван идентификатором из реестра подсказок (`$lib/onboarding/screens`): оттуда
 * же берутся адрес, право и статья справки, и второго списка экранов в продукте
 * не появляется.
 *
 * Вид пункта отвечает на вопрос «кто делает работу»:
 *
 * - `system` — делает система: результат появляется без ручного ввода;
 * - `assist` — помогает сотруднику: система готовит, решение и ввод за человеком;
 * - `control` — контролирует: система не даёт пройти дальше без доказательства
 *   или сама поднимает тревогу.
 *
 * Пункт со статусом `in_progress` описывает то, что ещё не выпущено: страница
 * показывает его с пометкой «в работе», а не как сделанное.
 *
 * Файл обычный, без импортов сборки: его читают и страница, и модульные
 * проверки.
 */
import { screenById, type TourScreen } from '$lib/onboarding/screens';

export const AUTOMATION_KINDS = ['system', 'assist', 'control'] as const;

export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

export const AUTOMATION_KIND_LABELS: Record<AutomationKind, string> = {
	system: 'Делает система',
	assist: 'Помогает сотруднику',
	control: 'Контролирует'
};

export const AUTOMATION_KIND_DESCRIPTIONS: Record<AutomationKind, string> = {
	system: 'Результат появляется сам, без ручного ввода.',
	assist: 'Система готовит данные, решение и ввод остаются за человеком.',
	control: 'Без доказательства дальше не пройти, или система сама поднимает тревогу.'
};

export type AutomationStatus = 'ready' | 'in_progress';

/**
 * Счётчики из журнала обмена. Других нет намеренно: число на карте обязано
 * читаться из журнала, который уже ведётся, а не из подсчёта, заведённого
 * ради витрины.
 */
export const AUTOMATION_COUNTERS = ['cms_applications', 'lms_requests', 'lms_results'] as const;

export type AutomationCounter = (typeof AUTOMATION_COUNTERS)[number];

export const AUTOMATION_COUNTER_LABELS: Record<AutomationCounter, string> = {
	cms_applications: 'заявок с сайта принято',
	lms_requests: 'заявок на группы отправлено в LMS',
	lms_results: 'результатов групп принято из LMS'
};

export type AutomationAction = {
	kind: AutomationKind;
	/** Что делает система — одной фразой. */
	title: string;
	/** Проверяемый результат: что увидеть на экране, чтобы убедиться. */
	result: string;
	/** Экран из реестра подсказок, на котором это видно. */
	screen: string;
	/** Подпись ссылки «Где это», если название экрана говорит не всё. */
	where?: string;
	/**
	 * Статья справки, если нужна не статья экрана: пункт опирается на
	 * настройку, описанную в другом разделе.
	 */
	help?: NonNullable<TourScreen['help']>;
	status: AutomationStatus;
	counter?: AutomationCounter;
};

export type AutomationStep = {
	/** Ключ стадии базового процесса. */
	stageKey: string;
	actions: readonly AutomationAction[];
};

const CARD = 'Карточка взаимодействия';

/** Четырнадцать шагов в порядке процесса. */
export const AUTOMATION_STEPS: readonly AutomationStep[] = [
	{
		stageKey: 'contact_search',
		actions: [
			{
				kind: 'system',
				title: 'Паспорт организации: реквизиты из ЕГРЮЛ по ИНН или названию (Dadata)',
				result:
					'Дифф «сейчас в карточке → из ЕГРЮЛ» в форме организации; сотрудник отмечает, что принять',
				screen: 'organizations',
				where: 'Организации → «Добавить организацию» → паспорт',
				// Ключ, адрес сервиса и коробочная версия для закрытого контура
				// описаны в статье об интеграциях.
				help: { section: 'admin', page: 'integrations', title: 'Интеграции' },
				status: 'ready'
			},
			{
				kind: 'assist',
				title: 'Руководители подразделений с сайта вуза (/sveden) — в контакты одним щелчком',
				result:
					'На карточке вуза кандидаты с должностью и подразделением; «Добавить в контакты» заводит человека и роль, источник и дата — в примечании',
				screen: 'organizations',
				where: 'Карточка организации → «Сведения с сайта»',
				status: 'ready'
			},
			{
				kind: 'control',
				title: 'Без подтверждённого контакта ответственного стадия не закрывается',
				result: 'Обязательные пункты чек-листа держат переход, срок стадии виден на карточке',
				screen: 'interactions',
				where: CARD,
				status: 'ready'
			}
		]
	},
	{
		stageKey: 'communication',
		actions: [
			{
				kind: 'assist',
				title: 'Подбор программ школы под программы вуза по кодам ФГОС',
				result:
					'На карточке вуза подходящие программы школы с объяснением: группа 09.00.00, сколько программ у вуза, точное совпадение кода, приоритет',
				screen: 'organizations',
				where: 'Карточка организации → «Сведения с сайта»',
				status: 'ready'
			},
			{
				kind: 'assist',
				title: 'Рейтинг программ и направлений по фактам системы — подсказка, что предлагать',
				result: 'Места за учебный год с разложением формулы по слагаемым',
				screen: 'data-ranking',
				status: 'ready'
			},
			{
				kind: 'assist',
				title: 'Описание программ вузу в один клик: письмо с материалами программ контактным лицам',
				result:
					'Пункт «Отправлено описание программ» закрывается сам, в ленте дела — запись об отправке, в журнале — кому и что ушло',
				screen: 'interactions',
				where: CARD,
				status: 'ready'
			}
		]
	},
	{
		stageKey: 'meeting',
		actions: [
			{
				kind: 'assist',
				title:
					'Приглашение на встречу письмом из карточки: контактам вуза и коллегам, с повесткой из чек-листа стадии',
				result:
					'Письмо с событием календаря распознают Gmail, Outlook, Apple и Яндекс; перенос обновляет то же событие, отмена его убирает, встреча — в ленте дела, итог — результатом стадии',
				screen: 'interactions',
				where: CARD,
				status: 'ready'
			},
			{
				kind: 'control',
				title: 'Встреча назначена и договорённости зафиксированы — иначе дальше не пройти',
				result: 'Обязательные пункты чек-листа «Встреча с представителями» держат переход',
				screen: 'interactions',
				where: CARD,
				status: 'ready'
			}
		]
	},
	{
		stageKey: 'document_exchange',
		actions: [
			{
				kind: 'system',
				title: 'Пакет документов одной кнопкой из шаблонов процесса',
				result:
					'Договор и акты собраны в DOCX и PDF с реквизитами из карточек; отказ называет недостающее поле',
				screen: 'interactions',
				where: `${CARD} → документы`,
				status: 'ready'
			}
		]
	},
	{
		stageKey: 'document_revision',
		actions: [
			{
				kind: 'assist',
				title: 'Редакции документа: новая версия поверх старой, история сохранена',
				result: 'На странице документа видны все редакции с автором и датой',
				screen: 'documents',
				status: 'ready'
			}
		]
	},
	{
		stageKey: 'signing',
		actions: [
			{
				kind: 'control',
				title: 'Стадию подписания подтверждает только документ с отметкой «Утверждён»',
				result: 'Без утверждённого документа переход отказывает и называет причину',
				screen: 'documents',
				status: 'ready'
			},
			{
				kind: 'system',
				title: 'Дело вошло на подписание — письмо руководителю ответственного',
				result:
					'Строка «Дело вошло на стадию» в журнале уведомлений; кого уведомлять при входе, задаёт у стадии редактор процесса',
				screen: 'notifications',
				status: 'ready'
			}
		]
	},
	{
		stageKey: 'materials_handover',
		actions: [
			{
				kind: 'system',
				title: 'Подписанный акт передачи переводит позиции договора в «передан»',
				result: 'Позиции, названные в акте, получают статус «передан» вместе с отметкой акта',
				screen: 'documents',
				status: 'ready'
			},
			{
				kind: 'control',
				title: 'Стадию подтверждает только акт передачи с отметкой «Утверждён»',
				result:
					'Отметка на акте из пакета документов подтверждает стадию; утверждённое на подписании соглашение её не закрывает',
				screen: 'documents',
				status: 'ready'
			},
			{
				kind: 'control',
				title: 'Контроль сроков лицензий и кнопка «Запустить продление»',
				result:
					'Письмо ответственному за вуз в окне продления, эскалация руководителю после истечения; кнопка на позиции договора',
				screen: 'organizations',
				where: 'Карточка организации → договоры',
				status: 'ready'
			}
		]
	},
	{
		stageKey: 'implementation_support',
		actions: [
			{
				kind: 'system',
				title: 'Заявка на учебную группу уходит в LMS из карточки',
				result: 'Строка исходящего сообщения в журнале обмена, статус группы на карточке',
				screen: 'interactions',
				where: `${CARD} → учебные группы`,
				status: 'ready',
				counter: 'lms_requests'
			},
			{
				kind: 'control',
				title: 'Результат и подтверждение стадии обязательны',
				result: 'Без результата и подтверждения переход отказывает',
				screen: 'interactions',
				where: CARD,
				status: 'ready'
			}
		]
	},
	{
		stageKey: 'teacher_training',
		actions: [
			{
				kind: 'assist',
				title: 'Группа с целью «Обучение преподавателей» заказывается в LMS',
				result: 'Результаты группы приходят историей и видны на карточке',
				screen: 'interactions',
				where: `${CARD} → учебные группы`,
				status: 'ready'
			},
			{
				kind: 'control',
				title: 'Результат и подтверждение стадии обязательны',
				result: 'Без результата и подтверждения переход отказывает',
				screen: 'interactions',
				where: CARD,
				status: 'ready'
			}
		]
	},
	{
		stageKey: 'program_update',
		actions: [
			{
				kind: 'assist',
				title: 'Новая версия программы заводится редакцией, прежние сохраняются',
				result: 'В карточке программы видна история версий',
				screen: 'programs',
				status: 'ready'
			},
			{
				kind: 'control',
				title: 'Расхождения выявлены и согласованы — иначе дальше не пройти',
				result: 'Обязательные пункты чек-листа держат переход',
				screen: 'interactions',
				where: CARD,
				status: 'ready'
			}
		]
	},
	{
		stageKey: 'classes',
		actions: [
			{
				kind: 'system',
				title: 'Итог учебной группы из LMS подтверждает «Ведение занятий»',
				result:
					'Подтверждение видом «запись в LMS»; засчитывается только итог группы студентов по программе взаимодействия',
				screen: 'interactions',
				where: CARD,
				status: 'ready',
				counter: 'lms_results'
			},
			{
				kind: 'system',
				title: 'Снимок статистики собирается из результатов групп',
				result: 'Предпросмотр за период и снимок на проверке, без ручной таблицы',
				screen: 'data-collect',
				status: 'ready'
			}
		]
	},
	{
		stageKey: 'documentation_update',
		actions: [
			{
				kind: 'assist',
				title: 'Обновлённые материалы ложатся новой редакцией документа',
				result: 'Редакции с автором и датой на странице документа',
				screen: 'documents',
				status: 'ready'
			},
			{
				kind: 'control',
				title: 'Результат стадии обязателен',
				result: 'Без результата переход отказывает',
				screen: 'interactions',
				where: CARD,
				status: 'ready'
			}
		]
	},
	{
		stageKey: 'qualification_upgrade',
		actions: [
			{
				kind: 'assist',
				title: 'Группа с целью «Повышение квалификации» заказывается в LMS',
				result: 'Результаты группы приходят историей и видны на карточке',
				screen: 'interactions',
				where: `${CARD} → учебные группы`,
				status: 'ready'
			},
			{
				kind: 'control',
				title: 'Результат и подтверждение стадии обязательны',
				result: 'Без результата и подтверждения переход отказывает',
				screen: 'interactions',
				where: CARD,
				status: 'ready'
			}
		]
	},
	{
		stageKey: 'execution_control',
		actions: [
			{
				kind: 'control',
				title: 'Наблюдатель зависших стадий: эскалация руководителю ответственного',
				result: 'Письмо руководителю и строка журнала доставок; пауза часы останавливает',
				screen: 'notifications',
				status: 'ready'
			},
			{
				kind: 'system',
				title: 'Отчёт на дату: срез и движение, от числа к подтверждению',
				result: 'Число отчёта открывает список, список — карточку, карточка — документ',
				screen: 'reports',
				status: 'ready'
			},
			{
				kind: 'system',
				title:
					'Утренняя сводка «Мой день» письмом: просрочки, сроки на сегодня и завтра, помехи, заявки и лицензии',
				result: 'Письмо сотруднику раз в сутки в его области доступа; доставка видна в журнале',
				screen: 'home',
				where: 'Главная; доставка — «Уведомления»',
				status: 'ready'
			}
		]
	}
];

/** Сквозное: работает на всём процессе, а не на одном шаге. */
export const AUTOMATION_CROSS_CUTTING: readonly AutomationAction[] = [
	{
		kind: 'system',
		title: 'Заявка с сайта создаёт или обновляет взаимодействие и возвращает статус в CMS',
		result: 'Строка входящего сообщения в журнале обмена и взаимодействие со ссылкой на заявку',
		screen: 'exchange',
		status: 'ready',
		counter: 'cms_applications'
	},
	{
		kind: 'assist',
		title: 'Единая лента событий по взаимодействиям вашей области',
		result: 'На «Сводке» — кто, что и когда сделал; в карточке — история с комментариями',
		screen: 'home',
		status: 'ready'
	},
	{
		kind: 'control',
		title: 'Чек-лист и срок у каждой стадии',
		result: 'Отметка срока на карточке и на доске; обязательные пункты держат переход',
		screen: 'interactions',
		where: CARD,
		status: 'ready'
	}
];

/** Экран «где это» в том виде, в каком его показывает страница. */
export type AutomationScreen = {
	title: string;
	href: string;
	/** Право экрана; без права ссылка не показывается — она ответила бы 403. */
	permission: NonNullable<TourScreen['permission']> | null;
	/** Статья справки об экране. */
	help: NonNullable<TourScreen['help']> | null;
};

/**
 * Адрес экрана для ссылки «Где это». Годится только экран раздела: пространство
 * в пути подставляется ключом, а экран записи (`[id=uuid]`) адреса без
 * конкретной записи не имеет, и для карты он — ошибка реестра, а не пустая
 * ссылка.
 */
export function automationScreen(screenId: string, workspaceKey: string): AutomationScreen {
	const screen = screenById(screenId);

	if (screen === null) {
		throw new Error(`Экран «${screenId}» карты автоматизации не заведён в реестре подсказок`);
	}

	const href = screen.route.replaceAll('[workspace]', workspaceKey);

	if (href.includes('[')) {
		throw new Error(`Экран «${screenId}» — экран записи: у ссылки карты нет адреса записи`);
	}

	return {
		title: screen.title,
		href,
		permission: screen.permission ?? null,
		help: screen.help ?? null
	};
}
