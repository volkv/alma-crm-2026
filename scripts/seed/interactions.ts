/**
 * Взаимодействия демонстрационного стенда: больше сотни записей на разных
 * стадиях маршрута обоих пространств, с историей за последний год, паузами,
 * помехами, комментариями и документами — воронка, а не десяток витринных
 * карточек.
 *
 * Историю пишет сам движок стадий: набор зовёт те же команды, что и карточка
 * (`advanceStage`, `confirmStage`, `pauseStage`, …). Разложить записи стадий
 * прямо в таблицу было бы вдвое короче и вдвое хуже: слепки стадий, отметки
 * чек-листа, закрытие пауз и записи журнала — это правила движка, и вторая их
 * реализация в сиде однажды разойдётся с первой. Поэтому набор не пишет в
 * `stage_entries` ничего, кроме времени: движок ставит `now()`, а
 * демонстрации нужна запись, которая идёт третий месяц.
 *
 * Два слоя данных. `INTERACTIONS` и `B2C_INTERACTIONS` — сюжетные записи
 * демонстрационного сценария (тур, скринкаст, `e2e/scenario.test.ts` и
 * соседние проходы находят их по ключу и по названию): их состав и ключи
 * трогать нельзя, новые записи встают рядом. `FUNNEL_INTERACTIONS`,
 * `B2B_EXTRA` и `B2C_EXTRA` — объём для воронки и отчётов: записи той же
 * формы, но их девяносто с лишним, и разница между соседними в основном в
 * подставленных вузе, программе и сроке. Строки просчитаны вне рантайма
 * скриптом, который перебирает вуз, контакт, программу и срок по порядковому
 * номеру записи без `Math.random`, и вставлены как обычные литералы — в самом
 * наборе кода для их генерации нет, чтобы это оставалось обычным, читаемым
 * списком данных, а не программой, которую нужно выполнить, чтобы увидеть,
 * что заливается.
 *
 * Названия вузов и продуктов публичные, всё остальное вымышлено — см.
 * `directory.ts`: организации, люди, программы и продукты берутся оттуда по тем
 * же ключам, а заголовки, сроки, комментарии и итоги набор придумывает сам.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
	createInteractionSchema,
	type BlockerReason,
	type CreateInteractionInput,
	type StageView
} from '$lib/contracts/interactions';
import type { DocumentStatusFact } from '$lib/contracts/documents';
import { externalSourceOf, type LearningPurpose, type LmsEvidence } from '$lib/contracts/exchange';
import { formatDate } from '$lib/format';
import type { ActorContext } from '$lib/server/actor';
import { recordAuditEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db';
import {
	blockers,
	comments,
	interactionChanges,
	interactionParties,
	interactionPartySites,
	interactionProducts,
	interactionPrograms,
	interactions,
	learningGroupProducts,
	learningGroupResults,
	learningGroups,
	programVersions,
	stageEntries,
	stagePauses,
	users
} from '$lib/server/db/schema';
import { withTransaction, type Tx } from '$lib/server/db/transaction';
import { DocumentConversionError } from '$lib/server/documents/errors';
import { readDocumentMark } from '$lib/server/documents/evidence';
import { generateDocument } from '$lib/server/documents/generate';
import { markDocument } from '$lib/server/documents/status';
import { uploadDocument, uploadDocumentRevision } from '$lib/server/documents/upload';
import { getExchangeSettings } from '$lib/server/integrations/settings';
import { getInteraction } from '$lib/server/interactions/read';
import { defaultRolePermissions } from '$lib/server/rbac/seed';
import {
	addComment,
	advanceStage,
	applyLmsEvidence,
	cancelInteraction,
	completeInteraction,
	confirmStage,
	pauseStage,
	raiseBlocker,
	returnStage,
	setChecklistItem,
	setResponsible,
	setStageResult,
	startInteractionIn
} from '$lib/server/stages/commands';
import type { ProcessDefinitionInput, ProcessRevisionView } from '$lib/contracts/interactions';
import {
	B2B_WORKSPACE_KEY,
	B2B_PROCESS,
	B2C_WORKSPACE_KEY,
	B2C_PROCESS
} from '$lib/server/stages/definitions';
import { readWorkspaceByKey, requireActiveRevisionForWorkspace } from '$lib/server/stages/process';
import { seedId } from './ids';
import { SERVICE_USER_EMAIL } from './users';

/** Ключи учётных записей, на которых ведутся демонстрационные взаимодействия. */
const OWNER_KEYS = ['demo-manager', 'veresova', 'zotov'] as const;

type OwnerKey = (typeof OWNER_KEYS)[number];

type PauseSeed = { note: string; nextAction: string };

/** Причина берётся из справочника: в наборе не должно быть кода, которого нет в системе. */
type BlockerSeed = { reasonCode: BlockerReason; description: string; blocksTransition: boolean };

/**
 * Поток обучения и то, чем он кончился. Нужен каждой записи, дошедшей до
 * стадии «Ведение занятий»: без факта из системы обучения стадия не
 * подтверждается и вперёд не отпускает.
 *
 * `completed: 0` — это идущее обучение, а не ноль выпускников: у такого потока
 * нет и даты окончания. Такой результат — «данные получены»: стадию он не
 * подтверждает, и запись остаётся на ней, пока не придёт итог.
 */
type LearningSeed = {
	/** Имя группы на стороне системы обучения: его выдаёт она, а не CRM. */
	groupExternalId: string;
	/**
	 * Для кого поток. Программу группа закрепляет единственную программу записи,
	 * продукты — все продукты записи: так заявку заполнил бы сотрудник, у
	 * которого выбора нет.
	 */
	purpose: LearningPurpose;
	plannedSeats: number;
	enrolled: number;
	completed: number;
	expelled: number;
};

/**
 * Стороны взаимодействия. Их состав и есть разница между пространствами: у
 * работы с вузом сторон три (вуз, компания-заказчик, оператор), у обучения лица
 * — две (сам контрагент и оператор), и пространство система выводит из вида
 * основной стороны, а не из поля набора.
 */
type CounterpartySeed =
	| {
			/** Ключи из `directory.ts`: учебное заведение, его контакт и площадки. */
			institution: string;
			contact: string;
			sites?: readonly string[];
			/** Компания-заказчик подготовки. */
			customer: string;
	  }
	| {
			/**
			 * Физическое или юридическое лицо: учится само и само платит, поэтому
			 * в ролях сторон это заказчик — то же правило, по которому раскладывает
			 * стороны приём заявки с сайта.
			 */
			counterparty: string;
			contact: string;
	  };

type InteractionSeed = CounterpartySeed & {
	key: string;
	title: string;
	programs: readonly string[];
	products?: readonly string[];
	owner: OwnerKey;
	/** Стадия, на которой взаимодействие стоит сейчас. */
	stage: string;
	/** Сколько дней назад взаимодействие завели. */
	startedDaysAgo: number;
	/** Сколько дней назад вошли в текущую стадию (у завершённых — когда закрыли). */
	sinceDaysAgo: number;
	/** Сколько дней назад по нему что-то происходило. */
	lastActivityDaysAgo: number;
	/**
	 * Срок действия соглашения. Есть у каждой записи набора: соглашение по
	 * шаблону собирается из него, и запись без срока — тупик на демонстрации.
	 */
	agreement: readonly [string, string];
	academic?: readonly [string, string];
	/** Поток в системе обучения: обязателен у всех, кто дошёл до занятий. */
	learning?: LearningSeed;
	/** Закрыть обязательные пункты чек-листа текущей стадии. */
	closeChecklist?: boolean;
	pause?: PauseSeed;
	blocker?: BlockerSeed;
	comments?: readonly string[];
	/** Собрать соглашение по шаблону — нужен доступный Gotenberg. */
	document?: boolean;
	/**
	 * Приложить скан и его вторую редакцию. Внешняя служба для этого не нужна:
	 * файл собирается здесь же, а показать цепочку редакций на стенде нужно.
	 */
	scanWithRevision?: boolean;
	/**
	 * Приложить подписанный экземпляр соглашения с отметкой «Утверждён».
	 *
	 * Нужен только тем, кто **остановился** на стадии подписания: у прошедших её
	 * такой документ появляется сам — без отметки стадия не отпускает вперёд.
	 * Стенду нужны оба состояния: дело с приложенным экземпляром (стадия
	 * подтверждена) и дело, которое его ещё ждёт.
	 */
	signedDocument?: boolean;
	/** Стадия, на которую сходили и вернулись назад: след в истории. */
	returnedFrom?: string;
	/** Кому передали взаимодействие: смена ответственного попадает в историю плана. */
	handedTo?: OwnerKey;
	/** Итог: заполнен у завершённых, маршрут при этом пройден целиком. */
	completedWith?: string;
	/**
	 * Причина отмены: заполнена у отменённых. В отличие от завершения, отмена не
	 * требует финальной стадии — дело останавливают там, где до него дошли.
	 */
	cancelledWith?: string;
	/**
	 * Дело пришло заявкой с сайта, а не заведено сотрудником: `externalSource` и
	 * `externalId` ставятся в том же виде, что и настоящий приём заявки
	 * (`externalSourceOf('cms', …)`, `integrations/exchange/intake.ts`). Без
	 * этого поля у демонстрационных данных слагаемое «заявки с сайта» рейтинга
	 * программ (`stats/facts.ts`, `readApplicationFacts`) остаётся пустым.
	 * `revision` по умолчанию — `1`: заявка обработана с первого сообщения,
	 * повторов не было.
	 */
	externalApplication?: { id: string; revision?: number };
};

/**
 * Тридцать сюжетных взаимодействий демонстрационного сценария: их ключи и
 * состав использует тур, скринкаст и `e2e/scenario.test.ts` — не трогать, не
 * перемешивать. Основной объём воронки — в `FUNNEL_INTERACTIONS` и
 * `B2B_EXTRA` ниже.
 */
const INTERACTIONS: readonly InteractionSeed[] = [
	{
		key: 'szpu-vo',
		title: 'СПбПУ: подготовка DevOps-инженеров, 2026/2027',
		institution: 'szpu',
		contact: 'drozdova',
		sites: ['szpu-dept-is'],
		customer: 'digital',
		programs: ['vo-bak-01'],
		products: ['lms'],
		owner: 'demo-manager',
		stage: 'contact_search',
		startedDaysAgo: 62,
		sinceDaysAgo: 62,
		lastActivityDaysAgo: 21,
		agreement: ['2026-09-01', '2027-08-31'],
		academic: ['2026-09-01', '2027-06-30']
	},
	{
		key: 'lyceum306-school',
		title: 'Лицей № 306 «Гравитон»: промпт-инжиниринг для старших классов',
		institution: 'lyceum306',
		contact: 'morozov',
		customer: 'polarcode',
		programs: ['school-01'],
		owner: 'veresova',
		stage: 'contact_search',
		startedDaysAgo: 6,
		sinceDaysAgo: 6,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-06-30']
	},
	{
		key: 'vts-spo',
		title: 'ВТС: аналитика на Python для отделения связи',
		institution: 'vts',
		contact: 'karpov',
		customer: 'technosphere',
		programs: ['spo-02'],
		owner: 'zotov',
		stage: 'contact_search',
		startedDaysAgo: 4,
		sinceDaysAgo: 4,
		lastActivityDaysAgo: 1,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'paid-praktiki',
		title: 'НИУ «МЭИ»: практики и стажировки на программах бакалавриата',
		institution: 'paid',
		contact: 'gorbunova',
		sites: ['paid-main'],
		customer: 'irbis',
		programs: ['vo-bak-03'],
		owner: 'demo-manager',
		stage: 'contact_search',
		startedDaysAgo: 5,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 3,
		agreement: ['2026-09-01', '2027-08-31'],
		closeChecklist: true
	},
	{
		key: 'pupi-ai',
		title: 'МФТИ: магистратура по low-code аналитике данных',
		institution: 'pupi',
		contact: 'ignatyeva',
		sites: ['pupi-dept-ai'],
		customer: 'digital',
		programs: ['vo-mag-01', 'vo-bak-01'],
		products: ['analytics'],
		owner: 'veresova',
		stage: 'communication',
		startedDaysAgo: 20,
		sinceDaysAgo: 12,
		lastActivityDaysAgo: 8,
		agreement: ['2026-09-01', '2027-08-31'],
		pause: {
			note: 'Ждём от вуза перечень дисциплин, которые готовы отдать под программу',
			nextAction: 'Созвон с координатором после учёного совета'
		}
	},
	{
		key: 'nkis-set',
		title: 'НКИС: аналитика на Python, набор 2026',
		institution: 'nkis',
		contact: 'zueva',
		sites: ['nkis-main'],
		customer: 'ladoga',
		programs: ['spo-02'],
		owner: 'zotov',
		stage: 'communication',
		startedDaysAgo: 15,
		sinceDaysAgo: 9,
		lastActivityDaysAgo: 4,
		agreement: ['2026-09-01', '2027-08-31'],
		comments: [
			'Колледж просит начать с одной группы и расширяться со второго семестра.',
			'Отправили описание программ и требования к учебной среде.'
		]
	},
	{
		key: 'school47-start',
		title: 'Школа № 47 «Вектор»: кружок промпт-инжиниринга',
		institution: 'school47',
		contact: 'novikova',
		customer: 'polarcode',
		programs: ['school-01'],
		owner: 'demo-manager',
		stage: 'communication',
		startedDaysAgo: 11,
		sinceDaysAgo: 6,
		lastActivityDaysAgo: 5,
		agreement: ['2026-09-01', '2027-05-31'],
		closeChecklist: true
	},
	{
		key: 'uguis-avtomat',
		title: 'ТПУ: web-разработка на «Аколе», совместная лаборатория',
		institution: 'uguis',
		contact: 'mukhin',
		sites: ['uguis-dept-auto'],
		customer: 'meridian',
		programs: ['vo-bak-02'],
		products: ['lab'],
		owner: 'veresova',
		stage: 'meeting',
		startedDaysAgo: 30,
		sinceDaysAgo: 9,
		lastActivityDaysAgo: 6,
		agreement: ['2026-10-01', '2027-09-30'],
		blocker: {
			reasonCode: 'no-room',
			description: 'Под лабораторию не выделено помещение: вопрос завис у проректора по АХЧ',
			blocksTransition: true
		},
		comments: ['Встречу перенесли на неделю: ждём решения по помещению.'],
		handedTo: 'zotov'
	},
	{
		key: 'skpa-tech',
		title: 'СКПА: подготовка SQL-разработчиков',
		institution: 'skpa',
		contact: 'lebedeva',
		customer: 'technosphere',
		programs: ['spo-01'],
		owner: 'zotov',
		stage: 'meeting',
		startedDaysAgo: 25,
		sinceDaysAgo: 10,
		lastActivityDaysAgo: 9,
		agreement: ['2026-09-01', '2027-08-31'],
		returnedFrom: 'document_exchange'
	},
	{
		key: 'sruit-dpo',
		title: 'Московский Политех: повышение квалификации преподавателей',
		institution: 'sruit',
		contact: 'shilov',
		customer: 'digital',
		programs: ['dpo-01'],
		owner: 'demo-manager',
		stage: 'meeting',
		startedDaysAgo: 22,
		sinceDaysAgo: 7,
		lastActivityDaysAgo: 2,
		agreement: ['2026-11-01', '2027-10-31'],
		closeChecklist: true
	},
	{
		key: 'vkgtu-svyaz',
		title: 'ЧГУ им. И. Н. Ульянова: пакет документов на 2026/2027',
		institution: 'vkgtu',
		contact: 'khabibullina',
		sites: ['vkgtu-dept-comm'],
		customer: 'meridian',
		programs: ['vo-bak-02', 'vo-mag-02'],
		products: ['lab', 'security'],
		owner: 'veresova',
		stage: 'document_exchange',
		startedDaysAgo: 70,
		sinceDaysAgo: 28,
		lastActivityDaysAgo: 26,
		agreement: ['2026-09-01', '2027-08-31'],
		comments: ['Вуз третью неделю сверяет реквизиты: написали повторно на имя проректора.']
	},
	{
		key: 'ukct-koll',
		title: 'УКЦТ: SQL-разработчик для колледжа, договор на год',
		institution: 'ukct',
		contact: 'dementyev',
		sites: ['ukct-main'],
		customer: 'ladoga',
		programs: ['spo-01'],
		owner: 'zotov',
		stage: 'document_exchange',
		startedDaysAgo: 34,
		sinceDaysAgo: 6,
		lastActivityDaysAgo: 3,
		agreement: ['2026-09-01', '2027-06-30']
	},
	{
		key: 'yutus-svyaz',
		title: 'ВолгГТУ: web-разработка на «Аколе»',
		institution: 'yutus',
		contact: 'savelyev',
		customer: 'technosphere',
		programs: ['vo-bak-02'],
		owner: 'demo-manager',
		stage: 'document_revision',
		startedDaysAgo: 45,
		sinceDaysAgo: 4,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31'],
		blocker: {
			reasonCode: 'waiting-legal',
			description: 'Юристы вуза просят изменить раздел об интеллектуальной собственности',
			blocksTransition: false
		},
		comments: ['Замечание по разделу 7 согласовали устно, ждём правку от вуза.']
	},
	{
		key: 'batse-econom',
		title: 'Университет Иннополис: корректировка пакета документов',
		institution: 'batse',
		contact: 'ulyanova',
		customer: 'irbis',
		programs: ['dpo-01'],
		owner: 'veresova',
		stage: 'document_revision',
		startedDaysAgo: 40,
		sinceDaysAgo: 3,
		lastActivityDaysAgo: 1,
		agreement: ['2026-10-01', '2027-09-30'],
		closeChecklist: true
	},
	{
		key: 'sivt-mag',
		title: 'НГУЭУ: магистратура по аналитике данных, подписание',
		institution: 'sivt',
		contact: 'orekhova',
		sites: ['sivt-main'],
		customer: 'digital',
		programs: ['vo-mag-01'],
		products: ['analytics'],
		owner: 'zotov',
		stage: 'signing',
		startedDaysAgo: 55,
		sinceDaysAgo: 11,
		lastActivityDaysAgo: 10,
		agreement: ['2026-09-01', '2027-08-31'],
		academic: ['2026-09-01', '2027-06-30'],
		document: true,
		pause: {
			note: 'Ждём подпись ректора: вернётся из командировки в конце недели',
			nextAction: 'Забрать подписанный экземпляр и передать в архив'
		}
	},
	{
		key: 'bit-telecom',
		title: 'МТУСИ: соглашение о сотрудничестве',
		institution: 'bit',
		contact: 'eldarova',
		customer: 'polarcode',
		programs: ['vo-bak-02'],
		owner: 'demo-manager',
		stage: 'signing',
		startedDaysAgo: 50,
		sinceDaysAgo: 8,
		lastActivityDaysAgo: 6,
		agreement: ['2026-09-01', '2027-08-31'],
		document: true,
		scanWithRevision: true,
		signedDocument: true,
		comments: ['Подписанты подтверждены с обеих сторон, подписанный экземпляр приложен.']
	},
	{
		key: 'puts-telecom',
		title: 'СГТУ им. Гагарина Ю. А.: передача материалов и лицензий на учебный год',
		institution: 'puts',
		contact: 'yakovleva',
		customer: 'ladoga',
		programs: ['vo-bak-02'],
		products: ['lms', 'lab'],
		owner: 'veresova',
		stage: 'materials_handover',
		startedDaysAgo: 80,
		sinceDaysAgo: 25,
		lastActivityDaysAgo: 23,
		agreement: ['2026-09-01', '2027-08-31'],
		academic: ['2026-09-01', '2027-06-30'],
		comments: ['Лицензии выпущены, акт передачи у вуза на подписи вторую неделю.'],
		handedTo: 'demo-manager'
	},
	{
		key: 'pupi-bak',
		title: 'МФТИ: подготовка DevOps-инженеров, комплект материалов',
		institution: 'pupi',
		contact: 'zharova',
		sites: ['pupi-main'],
		customer: 'technosphere',
		programs: ['vo-bak-01'],
		products: ['lms'],
		owner: 'zotov',
		stage: 'materials_handover',
		startedDaysAgo: 60,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 4,
		agreement: ['2026-09-01', '2027-08-31'],
		closeChecklist: true
	},
	{
		key: 'szpu-vnedrenie',
		title: 'СПбПУ: сопровождение внедрения «Базиса»',
		institution: 'szpu',
		contact: 'belskaya',
		sites: ['szpu-main'],
		customer: 'digital',
		programs: ['vo-bak-01', 'vo-bak-03'],
		products: ['lms', 'cloud'],
		owner: 'demo-manager',
		stage: 'implementation_support',
		startedDaysAgo: 95,
		sinceDaysAgo: 16,
		lastActivityDaysAgo: 12,
		agreement: ['2026-02-01', '2027-01-31'],
		pause: {
			note: 'Ждём от вуза доступ к учебной сети для развёртывания среды',
			nextAction: 'Согласовать окно работ с ИТ-службой вуза'
		},
		comments: ['Развернули тестовый контур, продуктивный ждёт доступов.']
	},
	{
		key: 'uguis-vnedr',
		title: 'ТПУ: внедрение «Аколы» в учебный процесс',
		institution: 'uguis',
		contact: 'lapina',
		customer: 'meridian',
		programs: ['vo-bak-02'],
		products: ['lab'],
		owner: 'veresova',
		stage: 'implementation_support',
		startedDaysAgo: 100,
		sinceDaysAgo: 12,
		lastActivityDaysAgo: 9,
		agreement: ['2026-02-01', '2027-01-31'],
		document: true
	},
	{
		key: 'vkgtu-prepod',
		title: 'ЧГУ им. И. Н. Ульянова: обучение преподавателей управлению проектами',
		institution: 'vkgtu',
		contact: 'tsvetkov',
		customer: 'ladoga',
		programs: ['dpo-01'],
		products: ['docs'],
		owner: 'zotov',
		stage: 'teacher_training',
		startedDaysAgo: 140,
		sinceDaysAgo: 44,
		lastActivityDaysAgo: 30,
		agreement: ['2025-09-01', '2026-08-31'],
		comments: ['Группа собрана наполовину: часть преподавателей ушла в отпуск.'],
		handedTo: 'demo-manager'
	},
	{
		key: 'sivt-prepod',
		title: 'НГУЭУ: повышение квалификации преподавательского состава',
		institution: 'sivt',
		contact: 'nesterov',
		customer: 'digital',
		programs: ['dpo-01'],
		owner: 'demo-manager',
		stage: 'teacher_training',
		startedDaysAgo: 120,
		sinceDaysAgo: 20,
		lastActivityDaysAgo: 15,
		agreement: ['2025-09-01', '2026-08-31'],
		closeChecklist: true
	},
	{
		key: 'yutus-aktual',
		title: 'ВолгГТУ: актуализация программы под требования заказчика',
		institution: 'yutus',
		contact: 'rodionova',
		customer: 'technosphere',
		programs: ['vo-bak-02'],
		owner: 'veresova',
		stage: 'program_update',
		startedDaysAgo: 150,
		sinceDaysAgo: 14,
		lastActivityDaysAgo: 11,
		agreement: ['2025-09-01', '2026-08-31'],
		academic: ['2025-09-01', '2026-06-30']
	},
	{
		key: 'ukct-zanyatiya',
		title: 'УКЦТ: ведение занятий в весеннем семестре',
		institution: 'ukct',
		contact: 'ershova',
		customer: 'ladoga',
		programs: ['spo-01'],
		products: ['lms'],
		owner: 'zotov',
		stage: 'classes',
		startedDaysAgo: 160,
		sinceDaysAgo: 25,
		lastActivityDaysAgo: 6,
		agreement: ['2025-09-01', '2026-08-31'],
		academic: ['2026-02-01', '2026-06-30'],
		// Занятия идут: система обучения прислала промежуточный результат, и
		// выпускников у потока ещё нет.
		learning: {
			groupExternalId: '70411',
			purpose: 'students',
			plannedSeats: 30,
			enrolled: 28,
			completed: 0,
			expelled: 1
		}
	},
	{
		key: 'batse-kontrol',
		title: 'Университет Иннополис: контроль исполнения обязательств за учебный год',
		institution: 'batse',
		contact: 'tarasyuk',
		customer: 'irbis',
		programs: ['dpo-01'],
		owner: 'demo-manager',
		stage: 'execution_control',
		startedDaysAgo: 200,
		sinceDaysAgo: 12,
		lastActivityDaysAgo: 7,
		agreement: ['2025-09-01', '2026-08-31'],
		learning: {
			groupExternalId: '70412',
			purpose: 'teachers',
			plannedSeats: 25,
			enrolled: 24,
			completed: 22,
			expelled: 1
		}
	},
	{
		key: 'szpu-2025',
		title: 'СПбПУ: DevOps-инженеры, 2025/2026',
		institution: 'szpu',
		contact: 'astakhov',
		sites: ['szpu-main'],
		customer: 'digital',
		programs: ['vo-bak-01'],
		products: ['lms', 'analytics'],
		owner: 'veresova',
		stage: 'execution_control',
		startedDaysAgo: 330,
		sinceDaysAgo: 20,
		lastActivityDaysAgo: 20,
		agreement: ['2025-09-01', '2026-08-31'],
		academic: ['2025-09-01', '2026-06-30'],
		// Числа потока сходятся с итогом: документы получили сорок восемь.
		learning: {
			groupExternalId: '70413',
			purpose: 'students',
			plannedSeats: 50,
			enrolled: 50,
			completed: 48,
			expelled: 2
		},
		completedWith:
			'Программа прочитана полностью, 48 студентов получили документы об обучении, отчёт принят заказчиком.'
	},
	{
		key: 'pupi-2025',
		title: 'МФТИ: low-code аналитика данных, 2025/2026',
		institution: 'pupi',
		contact: 'zharova',
		customer: 'irbis',
		programs: ['vo-mag-01'],
		owner: 'zotov',
		stage: 'execution_control',
		startedDaysAgo: 300,
		sinceDaysAgo: 15,
		lastActivityDaysAgo: 15,
		agreement: ['2025-09-01', '2026-08-31'],
		learning: {
			groupExternalId: '70414',
			purpose: 'students',
			plannedSeats: 12,
			enrolled: 10,
			completed: 7,
			expelled: 2
		},
		completedWith:
			'Магистерская программа закрыта, семь выпускников вышли на стажировку к заказчику.'
	},
	{
		key: 'nkis-2025',
		title: 'НКИС: аналитика на Python, 2025/2026',
		institution: 'nkis',
		contact: 'ilyin',
		sites: ['nkis-lab'],
		customer: 'ladoga',
		programs: ['spo-02'],
		products: ['analytics'],
		owner: 'demo-manager',
		stage: 'execution_control',
		startedDaysAgo: 280,
		sinceDaysAgo: 28,
		lastActivityDaysAgo: 28,
		agreement: ['2025-09-01', '2026-06-30'],
		learning: {
			groupExternalId: '70415',
			purpose: 'students',
			plannedSeats: 40,
			enrolled: 38,
			completed: 35,
			expelled: 2
		},
		completedWith: 'Две группы завершили обучение, лицензии продлены на следующий год.'
	},
	{
		key: 'puts-2025',
		title: 'СГТУ им. Гагарина Ю. А.: web-разработка, 2025/2026',
		institution: 'puts',
		contact: 'yurchenko',
		customer: 'technosphere',
		programs: ['vo-bak-02'],
		owner: 'veresova',
		stage: 'execution_control',
		startedDaysAgo: 260,
		sinceDaysAgo: 9,
		lastActivityDaysAgo: 9,
		agreement: ['2025-09-01', '2026-08-31'],
		// Набор перевыполнен: сорок мест в потоке, зачислено сорок пять.
		learning: {
			groupExternalId: '70416',
			purpose: 'students',
			plannedSeats: 40,
			enrolled: 45,
			completed: 41,
			expelled: 3
		},
		completedWith: 'Занятия проведены, плановые показатели по набору выполнены на 112 %.'
	},
	{
		key: 'sruit-2025',
		title: 'Московский Политех: переподготовка преподавателей, 2025/2026',
		institution: 'sruit',
		contact: 'chernysheva',
		customer: 'polarcode',
		programs: ['dpo-01'],
		products: ['docs'],
		owner: 'zotov',
		stage: 'execution_control',
		startedDaysAgo: 250,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 5,
		agreement: ['2025-09-01', '2026-08-31'],
		learning: {
			groupExternalId: '70417',
			purpose: 'teachers',
			plannedSeats: 25,
			enrolled: 26,
			completed: 24,
			expelled: 1
		},
		completedWith: 'Повышение квалификации прошли 24 преподавателя, документы выданы.'
	}
];

/**
 * Основной объём воронки: семьдесят восемь записей на всех четырнадцати
 * стадиях процесса «Работа с ВУЗ» — больше на ранних и меньше на поздних,
 * как и выглядит живая воронка. Институт, контакт, программа, продукт,
 * ответственный и срок подставлены по порядковому номеру записи; часть
 * стоит на стадии дольше норматива — это и даёт просрочки в отчёте.
 */
const FUNNEL_INTERACTIONS: readonly InteractionSeed[] = [
	{
		key: 'szpu-contact_search-0',
		title: 'СПбПУ: DevOps-инженеров, первый контакт',
		institution: 'szpu',
		contact: 'guryev',
		sites: ['szpu-dept-is'],
		customer: 'digital',
		programs: ['vo-bak-01'],
		products: ['lms'],
		owner: 'demo-manager',
		stage: 'contact_search',
		startedDaysAgo: 12,
		sinceDaysAgo: 12,
		lastActivityDaysAgo: 5,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'pupi-contact_search-1',
		externalApplication: { id: 'site-2026-000204' },
		title: 'МФТИ: аналитику данных (low-code), первый контакт',
		institution: 'pupi',
		contact: 'ignatyeva',
		sites: ['pupi-dept-ai'],
		customer: 'technosphere',
		programs: ['vo-mag-01'],
		owner: 'veresova',
		stage: 'contact_search',
		startedDaysAgo: 2,
		sinceDaysAgo: 2,
		lastActivityDaysAgo: 1,
		agreement: ['2026-09-01', '2027-08-31'],
		closeChecklist: true
	},
	{
		key: 'uguis-contact_search-2',
		externalApplication: { id: 'site-2026-000202' },
		title: 'ТПУ: web-разработку на «Аколе», первый контакт',
		institution: 'uguis',
		contact: 'koltsov',
		customer: 'irbis',
		programs: ['vo-bak-02'],
		products: ['lab'],
		owner: 'zotov',
		stage: 'contact_search',
		startedDaysAgo: 4,
		sinceDaysAgo: 4,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31'],
		comments: ['Ищем профильное подразделение, контакт пока не подтверждён.']
	},
	{
		key: 'sivt-contact_search-3',
		title: 'НГУЭУ: аналитику данных (low-code), первый контакт',
		institution: 'sivt',
		contact: 'pankratov',
		customer: 'meridian',
		programs: ['vo-mag-01'],
		owner: 'demo-manager',
		stage: 'contact_search',
		startedDaysAgo: 5,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'yutus-contact_search-4',
		title: 'ВолгГТУ: web-разработку на «Аколе», первый контакт',
		institution: 'yutus',
		contact: 'rodionova',
		customer: 'ladoga',
		programs: ['vo-bak-02'],
		products: ['lab'],
		owner: 'veresova',
		stage: 'contact_search',
		startedDaysAgo: 24,
		sinceDaysAgo: 24,
		lastActivityDaysAgo: 10,
		agreement: ['2026-09-01', '2027-08-31'],
		closeChecklist: true
	},
	{
		key: 'batse-contact_search-5',
		title: 'Университет Иннополис: управление проектами, первый контакт',
		institution: 'batse',
		contact: 'tarasyuk',
		customer: 'polarcode',
		programs: ['dpo-01'],
		owner: 'zotov',
		stage: 'contact_search',
		startedDaysAgo: 2,
		sinceDaysAgo: 2,
		lastActivityDaysAgo: 1,
		agreement: ['2026-10-01', '2027-09-30']
	},
	{
		key: 'vkgtu-contact_search-6',
		title: 'ЧГУ им. И. Н. Ульянова: web-разработку на «Аколе», первый контакт',
		institution: 'vkgtu',
		contact: 'fedotov',
		sites: ['vkgtu-main'],
		customer: 'digital',
		programs: ['vo-bak-02'],
		products: ['lab'],
		owner: 'demo-manager',
		stage: 'contact_search',
		startedDaysAgo: 4,
		sinceDaysAgo: 4,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'sruit-contact_search-7',
		title: 'Московский Политех: управление проектами, первый контакт',
		institution: 'sruit',
		contact: 'chernysheva',
		customer: 'technosphere',
		programs: ['dpo-01'],
		owner: 'veresova',
		stage: 'contact_search',
		startedDaysAgo: 5,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2026-10-01', '2027-09-30'],
		closeChecklist: true,
		comments: ['Ищем профильное подразделение, контакт пока не подтверждён.']
	},
	{
		key: 'bit-contact_search-8',
		title: 'МТУСИ: web-разработку на «Аколе», первый контакт',
		institution: 'bit',
		contact: 'shcherbak',
		customer: 'irbis',
		programs: ['vo-bak-02'],
		products: ['lab'],
		owner: 'zotov',
		stage: 'contact_search',
		startedDaysAgo: 21,
		sinceDaysAgo: 21,
		lastActivityDaysAgo: 8,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'puts-contact_search-9',
		title: 'СГТУ им. Гагарина Ю. А.: web-разработку на «Аколе», первый контакт',
		institution: 'puts',
		contact: 'yurchenko',
		customer: 'meridian',
		programs: ['vo-bak-02'],
		owner: 'demo-manager',
		stage: 'contact_search',
		startedDaysAgo: 2,
		sinceDaysAgo: 2,
		lastActivityDaysAgo: 1,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'paid-contact_search-10',
		title: 'НИУ «МЭИ»: мобильную разработку на «Авроре», первый контакт',
		institution: 'paid',
		contact: 'vikhrova',
		sites: ['paid-main'],
		customer: 'ladoga',
		programs: ['vo-bak-03'],
		products: ['cloud'],
		owner: 'veresova',
		stage: 'contact_search',
		startedDaysAgo: 4,
		sinceDaysAgo: 4,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31'],
		closeChecklist: true
	},
	{
		key: 'ukct-communication-11',
		title: 'УКЦТ: SQL-разработчиков, сверка программы',
		institution: 'ukct',
		contact: 'dementyev',
		sites: ['ukct-main'],
		customer: 'polarcode',
		programs: ['spo-01'],
		owner: 'zotov',
		stage: 'communication',
		startedDaysAgo: 53,
		sinceDaysAgo: 15,
		lastActivityDaysAgo: 6,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'nkis-communication-12',
		title: 'НКИС: аналитику на Python, сверка программы',
		institution: 'nkis',
		contact: 'zueva',
		sites: ['nkis-main'],
		customer: 'digital',
		programs: ['spo-02'],
		products: ['analytics'],
		owner: 'demo-manager',
		stage: 'communication',
		startedDaysAgo: 47,
		sinceDaysAgo: 4,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31'],
		comments: ['Программу и условия отправили, ждём вопросы от вуза.']
	},
	{
		key: 'vts-communication-13',
		title: 'ВТС: аналитику на Python, сверка программы',
		institution: 'vts',
		contact: 'karpov',
		customer: 'technosphere',
		programs: ['spo-02'],
		owner: 'veresova',
		stage: 'communication',
		startedDaysAgo: 53,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31'],
		closeChecklist: true
	},
	{
		key: 'skpa-communication-14',
		title: 'СКПА: SQL-разработчиков, сверка программы',
		institution: 'skpa',
		contact: 'lebedeva',
		customer: 'irbis',
		programs: ['spo-01'],
		owner: 'zotov',
		stage: 'communication',
		startedDaysAgo: 59,
		sinceDaysAgo: 6,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'lyceum306-communication-15',
		title: 'Лицей № 306 «Гравитон»: промпт-инжиниринг, сверка программы',
		institution: 'lyceum306',
		contact: 'morozov',
		customer: 'meridian',
		programs: ['school-01'],
		owner: 'demo-manager',
		stage: 'communication',
		startedDaysAgo: 85,
		sinceDaysAgo: 27,
		lastActivityDaysAgo: 11,
		agreement: ['2026-09-01', '2027-05-31']
	},
	{
		key: 'school47-communication-16',
		title: 'Школа № 47 «Вектор»: промпт-инжиниринг, сверка программы',
		institution: 'school47',
		contact: 'novikova',
		customer: 'ladoga',
		programs: ['school-01'],
		owner: 'veresova',
		stage: 'communication',
		startedDaysAgo: 42,
		sinceDaysAgo: 4,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-05-31'],
		closeChecklist: true
	},
	{
		key: 'szpu-communication-17',
		title: 'СПбПУ: мобильную разработку на «Авроре», сверка программы',
		institution: 'szpu',
		contact: 'efimov',
		sites: ['szpu-dept-is'],
		customer: 'polarcode',
		programs: ['vo-bak-03'],
		owner: 'zotov',
		stage: 'communication',
		startedDaysAgo: 48,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31'],
		comments: ['Программу и условия отправили, ждём вопросы от вуза.']
	},
	{
		key: 'pupi-communication-18',
		title: 'МФТИ: DevOps-инженеров, сверка программы',
		institution: 'pupi',
		contact: 'zharova',
		sites: ['pupi-main'],
		customer: 'digital',
		programs: ['vo-bak-01'],
		products: ['analytics'],
		owner: 'demo-manager',
		stage: 'communication',
		startedDaysAgo: 54,
		sinceDaysAgo: 6,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'uguis-communication-19',
		title: 'ТПУ: управление проектами, сверка программы',
		institution: 'uguis',
		contact: 'lapina',
		customer: 'technosphere',
		programs: ['dpo-01'],
		owner: 'veresova',
		stage: 'communication',
		startedDaysAgo: 77,
		sinceDaysAgo: 24,
		lastActivityDaysAgo: 10,
		agreement: ['2026-10-01', '2027-09-30'],
		closeChecklist: true
	},
	{
		key: 'sivt-communication-20',
		title: 'НГУЭУ: управление проектами, сверка программы',
		institution: 'sivt',
		contact: 'nesterov',
		sites: ['sivt-main'],
		customer: 'irbis',
		programs: ['dpo-01'],
		products: ['lms'],
		owner: 'zotov',
		stage: 'communication',
		startedDaysAgo: 62,
		sinceDaysAgo: 4,
		lastActivityDaysAgo: 2,
		agreement: ['2026-10-01', '2027-09-30']
	},
	{
		key: 'yutus-meeting-21',
		title: 'ВолгГТУ: управление проектами, встреча с подразделением',
		institution: 'yutus',
		contact: 'savelyev',
		customer: 'meridian',
		programs: ['dpo-01'],
		owner: 'demo-manager',
		stage: 'meeting',
		startedDaysAgo: 81,
		sinceDaysAgo: 19,
		lastActivityDaysAgo: 8,
		agreement: ['2026-10-01', '2027-09-30']
	},
	{
		key: 'batse-meeting-22',
		title: 'Университет Иннополис: управление проектами, встреча с подразделением',
		institution: 'batse',
		contact: 'ulyanova',
		customer: 'ladoga',
		programs: ['dpo-01'],
		products: ['docs'],
		owner: 'veresova',
		stage: 'meeting',
		startedDaysAgo: 72,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2026-10-01', '2027-09-30'],
		closeChecklist: true,
		comments: ['Встречу согласовали, уточняем состав участников.']
	},
	{
		key: 'vkgtu-meeting-23',
		externalApplication: { id: 'site-2026-000205' },
		title: 'ЧГУ им. И. Н. Ульянова: распределённые реестры, встреча с подразделением',
		institution: 'vkgtu',
		contact: 'khabibullina',
		sites: ['vkgtu-main'],
		customer: 'polarcode',
		programs: ['vo-mag-02'],
		owner: 'zotov',
		stage: 'meeting',
		startedDaysAgo: 79,
		sinceDaysAgo: 7,
		lastActivityDaysAgo: 3,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'sruit-meeting-24',
		title: 'Московский Политех: управление проектами, встреча с подразделением',
		institution: 'sruit',
		contact: 'shilov',
		customer: 'digital',
		programs: ['dpo-01'],
		products: ['docs'],
		owner: 'demo-manager',
		stage: 'meeting',
		startedDaysAgo: 86,
		sinceDaysAgo: 9,
		lastActivityDaysAgo: 4,
		agreement: ['2026-10-01', '2027-09-30']
	},
	{
		key: 'bit-meeting-25',
		title: 'МТУСИ: управление проектами, встреча с подразделением',
		institution: 'bit',
		contact: 'eldarova',
		customer: 'technosphere',
		programs: ['dpo-01'],
		owner: 'veresova',
		stage: 'meeting',
		startedDaysAgo: 113,
		sinceDaysAgo: 31,
		lastActivityDaysAgo: 12,
		agreement: ['2026-10-01', '2027-09-30'],
		closeChecklist: true
	},
	{
		key: 'puts-meeting-26',
		title: 'СГТУ им. Гагарина Ю. А.: управление проектами, встреча с подразделением',
		institution: 'puts',
		contact: 'yakovleva',
		customer: 'irbis',
		programs: ['dpo-01'],
		products: ['lab'],
		owner: 'zotov',
		stage: 'meeting',
		startedDaysAgo: 67,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2026-10-01', '2027-09-30']
	},
	{
		key: 'paid-meeting-27',
		title: 'НИУ «МЭИ»: управление проектами, встреча с подразделением',
		institution: 'paid',
		contact: 'gorbunova',
		sites: ['paid-main'],
		customer: 'meridian',
		programs: ['dpo-01'],
		owner: 'demo-manager',
		stage: 'meeting',
		startedDaysAgo: 74,
		sinceDaysAgo: 7,
		lastActivityDaysAgo: 3,
		agreement: ['2026-10-01', '2027-09-30'],
		comments: ['Встречу согласовали, уточняем состав участников.']
	},
	{
		key: 'ukct-meeting-28',
		title: 'УКЦТ: аналитику на Python, встреча с подразделением',
		institution: 'ukct',
		contact: 'ershova',
		sites: ['ukct-main'],
		customer: 'ladoga',
		programs: ['spo-02'],
		products: ['lms'],
		owner: 'veresova',
		stage: 'meeting',
		startedDaysAgo: 81,
		sinceDaysAgo: 9,
		lastActivityDaysAgo: 4,
		agreement: ['2026-09-01', '2027-08-31'],
		closeChecklist: true
	},
	{
		key: 'nkis-meeting-29',
		externalApplication: { id: 'site-2026-000207' },
		title: 'НКИС: SQL-разработчиков, встреча с подразделением',
		institution: 'nkis',
		contact: 'ilyin',
		sites: ['nkis-lab'],
		customer: 'polarcode',
		programs: ['spo-01'],
		owner: 'zotov',
		stage: 'meeting',
		startedDaysAgo: 105,
		sinceDaysAgo: 28,
		lastActivityDaysAgo: 11,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'vts-document_exchange-30',
		title: 'ВТС: аналитику на Python, обмен пакетом документов',
		institution: 'vts',
		contact: 'karpov',
		customer: 'digital',
		programs: ['spo-02'],
		owner: 'demo-manager',
		stage: 'document_exchange',
		startedDaysAgo: 101,
		sinceDaysAgo: 15,
		lastActivityDaysAgo: 6,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'skpa-document_exchange-31',
		title: 'СКПА: SQL-разработчиков, обмен пакетом документов',
		institution: 'skpa',
		contact: 'lebedeva',
		customer: 'technosphere',
		programs: ['spo-01'],
		owner: 'veresova',
		stage: 'document_exchange',
		startedDaysAgo: 95,
		sinceDaysAgo: 4,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31'],
		closeChecklist: true
	},
	{
		key: 'lyceum306-document_exchange-32',
		title: 'Лицей № 306 «Гравитон»: промпт-инжиниринг, обмен пакетом документов',
		institution: 'lyceum306',
		contact: 'morozov',
		customer: 'irbis',
		programs: ['school-01'],
		owner: 'zotov',
		stage: 'document_exchange',
		startedDaysAgo: 101,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-05-31'],
		comments: ['Пакет документов отправлен, ждём встречный от вуза.']
	},
	{
		key: 'school47-document_exchange-33',
		title: 'Школа № 47 «Вектор»: промпт-инжиниринг, обмен пакетом документов',
		institution: 'school47',
		contact: 'novikova',
		customer: 'meridian',
		programs: ['school-01'],
		owner: 'demo-manager',
		stage: 'document_exchange',
		startedDaysAgo: 107,
		sinceDaysAgo: 6,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-05-31']
	},
	{
		key: 'szpu-document_exchange-34',
		title: 'СПбПУ: управление проектами, обмен пакетом документов',
		institution: 'szpu',
		contact: 'astakhov',
		sites: ['szpu-main'],
		customer: 'ladoga',
		programs: ['dpo-01'],
		products: ['cloud'],
		owner: 'veresova',
		stage: 'document_exchange',
		startedDaysAgo: 133,
		sinceDaysAgo: 27,
		lastActivityDaysAgo: 11,
		agreement: ['2026-10-01', '2027-09-30'],
		closeChecklist: true
	},
	{
		key: 'pupi-document_exchange-35',
		title: 'МФТИ: управление проектами, обмен пакетом документов',
		institution: 'pupi',
		contact: 'ignatyeva',
		sites: ['pupi-dept-ai'],
		customer: 'polarcode',
		programs: ['dpo-01'],
		owner: 'zotov',
		stage: 'document_exchange',
		startedDaysAgo: 90,
		sinceDaysAgo: 4,
		lastActivityDaysAgo: 2,
		agreement: ['2026-10-01', '2027-09-30']
	},
	{
		key: 'uguis-document_exchange-36',
		title: 'ТПУ: web-разработку на «Аколе», обмен пакетом документов',
		institution: 'uguis',
		contact: 'mukhin',
		sites: ['uguis-dept-auto'],
		customer: 'digital',
		programs: ['vo-bak-02'],
		products: ['lab'],
		owner: 'demo-manager',
		stage: 'document_exchange',
		startedDaysAgo: 96,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'sivt-document_revision-37',
		title: 'НГУЭУ: аналитику данных (low-code), правки соглашения',
		institution: 'sivt',
		contact: 'orekhova',
		sites: ['sivt-main'],
		customer: 'technosphere',
		programs: ['vo-mag-01'],
		owner: 'veresova',
		stage: 'document_revision',
		startedDaysAgo: 122,
		sinceDaysAgo: 12,
		lastActivityDaysAgo: 5,
		agreement: ['2026-09-01', '2027-08-31'],
		closeChecklist: true,
		comments: ['Собираем замечания сторон по проекту соглашения.']
	},
	{
		key: 'yutus-document_revision-38',
		title: 'ВолгГТУ: web-разработку на «Аколе», правки соглашения',
		institution: 'yutus',
		contact: 'rodionova',
		customer: 'irbis',
		programs: ['vo-bak-02'],
		products: ['lab'],
		owner: 'zotov',
		stage: 'document_revision',
		startedDaysAgo: 117,
		sinceDaysAgo: 2,
		lastActivityDaysAgo: 1,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'batse-document_revision-39',
		title: 'Университет Иннополис: управление проектами, правки соглашения',
		institution: 'batse',
		contact: 'tarasyuk',
		customer: 'meridian',
		programs: ['dpo-01'],
		owner: 'demo-manager',
		stage: 'document_revision',
		startedDaysAgo: 124,
		sinceDaysAgo: 4,
		lastActivityDaysAgo: 2,
		agreement: ['2026-10-01', '2027-09-30']
	},
	{
		key: 'vkgtu-document_revision-40',
		title: 'ЧГУ им. И. Н. Ульянова: управление проектами, правки соглашения',
		institution: 'vkgtu',
		contact: 'tsvetkov',
		sites: ['vkgtu-dept-comm'],
		customer: 'ladoga',
		programs: ['dpo-01'],
		products: ['docs'],
		owner: 'veresova',
		stage: 'document_revision',
		startedDaysAgo: 130,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2026-10-01', '2027-09-30'],
		closeChecklist: true
	},
	{
		key: 'sruit-document_revision-41',
		title: 'Московский Политех: управление проектами, правки соглашения',
		institution: 'sruit',
		contact: 'chernysheva',
		customer: 'polarcode',
		programs: ['dpo-01'],
		owner: 'zotov',
		stage: 'document_revision',
		startedDaysAgo: 154,
		sinceDaysAgo: 24,
		lastActivityDaysAgo: 10,
		agreement: ['2026-10-01', '2027-09-30']
	},
	{
		key: 'bit-document_revision-42',
		title: 'МТУСИ: web-разработку на «Аколе», правки соглашения',
		institution: 'bit',
		contact: 'shcherbak',
		customer: 'digital',
		programs: ['vo-bak-02'],
		products: ['lab'],
		owner: 'demo-manager',
		stage: 'document_revision',
		startedDaysAgo: 112,
		sinceDaysAgo: 2,
		lastActivityDaysAgo: 1,
		agreement: ['2026-09-01', '2027-08-31'],
		comments: ['Собираем замечания сторон по проекту соглашения.']
	},
	{
		key: 'puts-signing-43',
		title: 'СГТУ им. Гагарина Ю. А.: web-разработку на «Аколе», подписание соглашения',
		institution: 'puts',
		contact: 'yurchenko',
		customer: 'technosphere',
		programs: ['vo-bak-02'],
		owner: 'veresova',
		stage: 'signing',
		startedDaysAgo: 153,
		sinceDaysAgo: 19,
		lastActivityDaysAgo: 8,
		agreement: ['2026-09-01', '2027-08-31'],
		closeChecklist: true
	},
	{
		key: 'paid-signing-44',
		externalApplication: { id: 'site-2026-000203' },
		title: 'НИУ «МЭИ»: мобильную разработку на «Авроре», подписание соглашения',
		institution: 'paid',
		contact: 'vikhrova',
		sites: ['paid-main'],
		customer: 'irbis',
		programs: ['vo-bak-03'],
		products: ['cloud'],
		owner: 'zotov',
		stage: 'signing',
		startedDaysAgo: 144,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'ukct-signing-45',
		title: 'УКЦТ: SQL-разработчиков, подписание соглашения',
		institution: 'ukct',
		contact: 'dementyev',
		sites: ['ukct-main'],
		customer: 'meridian',
		programs: ['spo-01'],
		owner: 'demo-manager',
		stage: 'signing',
		startedDaysAgo: 151,
		sinceDaysAgo: 7,
		lastActivityDaysAgo: 3,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'nkis-signing-46',
		title: 'НКИС: аналитику на Python, подписание соглашения',
		institution: 'nkis',
		contact: 'zueva',
		sites: ['nkis-main'],
		customer: 'ladoga',
		programs: ['spo-02'],
		products: ['analytics'],
		owner: 'veresova',
		stage: 'signing',
		startedDaysAgo: 158,
		sinceDaysAgo: 9,
		lastActivityDaysAgo: 4,
		agreement: ['2026-09-01', '2027-08-31'],
		closeChecklist: true
	},
	{
		key: 'vts-signing-47',
		title: 'ВТС: аналитику на Python, подписание соглашения',
		institution: 'vts',
		contact: 'karpov',
		customer: 'polarcode',
		programs: ['spo-02'],
		owner: 'zotov',
		stage: 'signing',
		startedDaysAgo: 185,
		sinceDaysAgo: 31,
		lastActivityDaysAgo: 12,
		agreement: ['2026-09-01', '2027-08-31'],
		comments: ['Соглашение на подписи у руководства вуза.']
	},
	{
		key: 'skpa-signing-48',
		title: 'СКПА: SQL-разработчиков, подписание соглашения',
		institution: 'skpa',
		contact: 'lebedeva',
		customer: 'digital',
		programs: ['spo-01'],
		owner: 'demo-manager',
		stage: 'signing',
		startedDaysAgo: 139,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'lyceum306-materials_handover-49',
		title: 'Лицей № 306 «Гравитон»: промпт-инжиниринг, передача материалов',
		institution: 'lyceum306',
		contact: 'morozov',
		customer: 'technosphere',
		programs: ['school-01'],
		owner: 'veresova',
		stage: 'materials_handover',
		startedDaysAgo: 173,
		sinceDaysAgo: 15,
		lastActivityDaysAgo: 6,
		agreement: ['2026-09-01', '2027-05-31'],
		closeChecklist: true
	},
	{
		key: 'school47-materials_handover-50',
		title: 'Школа № 47 «Вектор»: промпт-инжиниринг, передача материалов',
		institution: 'school47',
		contact: 'novikova',
		customer: 'irbis',
		programs: ['school-01'],
		owner: 'zotov',
		stage: 'materials_handover',
		startedDaysAgo: 167,
		sinceDaysAgo: 4,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-05-31']
	},
	{
		key: 'szpu-materials_handover-51',
		externalApplication: { id: 'site-2026-000201' },
		title: 'СПбПУ: DevOps-инженеров, передача материалов',
		institution: 'szpu',
		contact: 'guryev',
		sites: ['szpu-dept-is'],
		customer: 'meridian',
		programs: ['vo-bak-01'],
		owner: 'demo-manager',
		stage: 'materials_handover',
		startedDaysAgo: 173,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31']
	},
	{
		key: 'pupi-materials_handover-52',
		title: 'МФТИ: аналитику данных (low-code), передача материалов',
		institution: 'pupi',
		contact: 'zharova',
		sites: ['pupi-main'],
		customer: 'ladoga',
		programs: ['vo-mag-01'],
		products: ['analytics'],
		owner: 'veresova',
		stage: 'materials_handover',
		startedDaysAgo: 179,
		sinceDaysAgo: 6,
		lastActivityDaysAgo: 2,
		agreement: ['2026-09-01', '2027-08-31'],
		closeChecklist: true,
		comments: ['Готовим комплект материалов и лицензии к передаче.']
	},
	{
		key: 'uguis-materials_handover-53',
		title: 'ТПУ: управление проектами, передача материалов',
		institution: 'uguis',
		contact: 'koltsov',
		customer: 'polarcode',
		programs: ['dpo-01'],
		owner: 'zotov',
		stage: 'materials_handover',
		startedDaysAgo: 205,
		sinceDaysAgo: 27,
		lastActivityDaysAgo: 11,
		agreement: ['2026-10-01', '2027-09-30']
	},
	{
		key: 'sivt-implementation_support-54',
		title: 'НГУЭУ: управление проектами, сопровождение внедрения',
		institution: 'sivt',
		contact: 'pankratov',
		customer: 'digital',
		programs: ['dpo-01'],
		products: ['lms'],
		owner: 'demo-manager',
		stage: 'implementation_support',
		startedDaysAgo: 208,
		sinceDaysAgo: 26,
		lastActivityDaysAgo: 10,
		agreement: ['2026-10-01', '2027-09-30']
	},
	{
		key: 'yutus-implementation_support-55',
		title: 'ВолгГТУ: управление проектами, сопровождение внедрения',
		institution: 'yutus',
		contact: 'savelyev',
		customer: 'technosphere',
		programs: ['dpo-01'],
		owner: 'veresova',
		stage: 'implementation_support',
		startedDaysAgo: 194,
		sinceDaysAgo: 7,
		lastActivityDaysAgo: 3,
		agreement: ['2026-10-01', '2027-09-30'],
		closeChecklist: true
	},
	{
		key: 'batse-implementation_support-56',
		title: 'Университет Иннополис: управление проектами, сопровождение внедрения',
		institution: 'batse',
		contact: 'ulyanova',
		customer: 'irbis',
		programs: ['dpo-01'],
		products: ['docs'],
		owner: 'zotov',
		stage: 'implementation_support',
		startedDaysAgo: 202,
		sinceDaysAgo: 10,
		lastActivityDaysAgo: 4,
		agreement: ['2026-10-01', '2027-09-30']
	},
	{
		key: 'vkgtu-implementation_support-57',
		title: 'ЧГУ им. И. Н. Ульянова: web-разработку на «Аколе», сопровождение внедрения',
		institution: 'vkgtu',
		contact: 'fedotov',
		sites: ['vkgtu-main'],
		customer: 'meridian',
		programs: ['vo-bak-02'],
		owner: 'demo-manager',
		stage: 'implementation_support',
		startedDaysAgo: 211,
		sinceDaysAgo: 14,
		lastActivityDaysAgo: 6,
		agreement: ['2026-09-01', '2027-08-31'],
		comments: ['Настраиваем учебную среду вместе с ИТ-службой вуза.']
	},
	{
		key: 'sruit-teacher_training-58',
		externalApplication: { id: 'site-2026-000206' },
		title: 'Московский Политех: управление проектами, обучение преподавателей',
		institution: 'sruit',
		contact: 'shilov',
		customer: 'ladoga',
		programs: ['dpo-01'],
		products: ['docs'],
		owner: 'veresova',
		stage: 'teacher_training',
		startedDaysAgo: 241,
		sinceDaysAgo: 35,
		lastActivityDaysAgo: 14,
		agreement: ['2025-10-01', '2026-09-30'],
		closeChecklist: true
	},
	{
		key: 'bit-teacher_training-59',
		title: 'МТУСИ: управление проектами, обучение преподавателей',
		institution: 'bit',
		contact: 'eldarova',
		customer: 'polarcode',
		programs: ['dpo-01'],
		owner: 'zotov',
		stage: 'teacher_training',
		startedDaysAgo: 221,
		sinceDaysAgo: 10,
		lastActivityDaysAgo: 4,
		agreement: ['2025-10-01', '2026-09-30']
	},
	{
		key: 'puts-teacher_training-60',
		title: 'СГТУ им. Гагарина Ю. А.: управление проектами, обучение преподавателей',
		institution: 'puts',
		contact: 'yakovleva',
		customer: 'digital',
		programs: ['dpo-01'],
		products: ['lab'],
		owner: 'demo-manager',
		stage: 'teacher_training',
		startedDaysAgo: 231,
		sinceDaysAgo: 15,
		lastActivityDaysAgo: 6,
		agreement: ['2025-10-01', '2026-09-30']
	},
	{
		key: 'paid-teacher_training-61',
		title: 'НИУ «МЭИ»: управление проектами, обучение преподавателей',
		institution: 'paid',
		contact: 'gorbunova',
		sites: ['paid-main'],
		customer: 'technosphere',
		programs: ['dpo-01'],
		owner: 'veresova',
		stage: 'teacher_training',
		startedDaysAgo: 240,
		sinceDaysAgo: 19,
		lastActivityDaysAgo: 8,
		agreement: ['2025-10-01', '2026-09-30'],
		closeChecklist: true
	},
	{
		key: 'ukct-program_update-62',
		externalApplication: { id: 'site-2026-000208' },
		title: 'УКЦТ: аналитику на Python, актуализация программы',
		institution: 'ukct',
		contact: 'ershova',
		sites: ['ukct-main'],
		customer: 'irbis',
		programs: ['spo-02'],
		products: ['lms'],
		owner: 'zotov',
		stage: 'program_update',
		startedDaysAgo: 256,
		sinceDaysAgo: 26,
		lastActivityDaysAgo: 10,
		agreement: ['2025-09-01', '2026-08-31'],
		comments: ['Сверяем программу с актуальными требованиями вуза.']
	},
	{
		key: 'nkis-program_update-63',
		title: 'НКИС: SQL-разработчиков, актуализация программы',
		institution: 'nkis',
		contact: 'ilyin',
		sites: ['nkis-lab'],
		customer: 'meridian',
		programs: ['spo-01'],
		owner: 'demo-manager',
		stage: 'program_update',
		startedDaysAgo: 242,
		sinceDaysAgo: 7,
		lastActivityDaysAgo: 3,
		agreement: ['2025-09-01', '2026-08-31']
	},
	{
		key: 'vts-program_update-64',
		title: 'ВТС: аналитику на Python, актуализация программы',
		institution: 'vts',
		contact: 'karpov',
		customer: 'ladoga',
		programs: ['spo-02'],
		owner: 'veresova',
		stage: 'program_update',
		startedDaysAgo: 250,
		sinceDaysAgo: 10,
		lastActivityDaysAgo: 4,
		agreement: ['2025-09-01', '2026-08-31'],
		closeChecklist: true
	},
	{
		key: 'skpa-program_update-65',
		title: 'СКПА: SQL-разработчиков, актуализация программы',
		institution: 'skpa',
		contact: 'lebedeva',
		customer: 'polarcode',
		programs: ['spo-01'],
		owner: 'zotov',
		stage: 'program_update',
		startedDaysAgo: 259,
		sinceDaysAgo: 14,
		lastActivityDaysAgo: 6,
		agreement: ['2025-09-01', '2026-08-31']
	},
	{
		key: 'lyceum306-classes-66',
		title: 'Лицей № 306 «Гравитон»: промпт-инжиниринг, ведение занятий',
		institution: 'lyceum306',
		contact: 'morozov',
		customer: 'digital',
		programs: ['school-01'],
		owner: 'demo-manager',
		stage: 'classes',
		startedDaysAgo: 289,
		sinceDaysAgo: 35,
		lastActivityDaysAgo: 14,
		agreement: ['2025-09-01', '2026-05-31'],
		academic: ['2025-09-01', '2026-05-31'],
		learning: {
			groupExternalId: '70421',
			purpose: 'students',
			plannedSeats: 18,
			enrolled: 18,
			completed: 0,
			expelled: 1
		}
	},
	{
		key: 'school47-classes-67',
		externalApplication: { id: 'site-2026-000209' },
		title: 'Школа № 47 «Вектор»: промпт-инжиниринг, ведение занятий',
		institution: 'school47',
		contact: 'novikova',
		customer: 'technosphere',
		programs: ['school-01'],
		owner: 'veresova',
		stage: 'classes',
		startedDaysAgo: 269,
		sinceDaysAgo: 10,
		lastActivityDaysAgo: 4,
		agreement: ['2025-09-01', '2026-05-31'],
		academic: ['2025-09-01', '2026-05-31'],
		learning: {
			groupExternalId: '70422',
			purpose: 'students',
			plannedSeats: 23,
			enrolled: 22,
			completed: 0,
			expelled: 2
		},
		closeChecklist: true,
		comments: ['Занятия идут по расписанию, посещаемость в норме.']
	},
	{
		key: 'szpu-classes-68',
		title: 'СПбПУ: мобильную разработку на «Авроре», ведение занятий',
		institution: 'szpu',
		contact: 'efimov',
		sites: ['szpu-dept-is'],
		customer: 'irbis',
		programs: ['vo-bak-03'],
		products: ['analytics'],
		owner: 'zotov',
		stage: 'classes',
		startedDaysAgo: 279,
		sinceDaysAgo: 15,
		lastActivityDaysAgo: 6,
		agreement: ['2025-09-01', '2026-08-31'],
		academic: ['2025-09-01', '2026-06-30'],
		learning: {
			groupExternalId: '70423',
			purpose: 'students',
			plannedSeats: 28,
			enrolled: 26,
			completed: 0,
			expelled: 1
		}
	},
	{
		key: 'pupi-classes-69',
		title: 'МФТИ: DevOps-инженеров, ведение занятий',
		institution: 'pupi',
		contact: 'ignatyeva',
		sites: ['pupi-dept-ai'],
		customer: 'meridian',
		programs: ['vo-bak-01'],
		owner: 'demo-manager',
		stage: 'classes',
		startedDaysAgo: 288,
		sinceDaysAgo: 19,
		lastActivityDaysAgo: 8,
		agreement: ['2025-09-01', '2026-08-31'],
		academic: ['2025-09-01', '2026-06-30'],
		learning: {
			groupExternalId: '70424',
			purpose: 'students',
			plannedSeats: 33,
			enrolled: 33,
			completed: 0,
			expelled: 2
		}
	},
	{
		key: 'uguis-documentation_update-70',
		title: 'ТПУ: web-разработку на «Аколе», актуализация документации',
		institution: 'uguis',
		contact: 'lapina',
		customer: 'ladoga',
		programs: ['vo-bak-02'],
		products: ['lab'],
		owner: 'veresova',
		stage: 'documentation_update',
		startedDaysAgo: 297,
		sinceDaysAgo: 19,
		lastActivityDaysAgo: 8,
		agreement: ['2025-09-01', '2026-08-31'],
		academic: ['2025-09-01', '2026-06-30'],
		learning: {
			groupExternalId: '70425',
			purpose: 'students',
			plannedSeats: 38,
			enrolled: 37,
			completed: 35,
			expelled: 1
		},
		closeChecklist: true
	},
	{
		key: 'sivt-documentation_update-71',
		title: 'НГУЭУ: аналитику данных (low-code), актуализация документации',
		institution: 'sivt',
		contact: 'nesterov',
		sites: ['sivt-main'],
		customer: 'polarcode',
		programs: ['vo-mag-01'],
		owner: 'zotov',
		stage: 'documentation_update',
		startedDaysAgo: 288,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2025-09-01', '2026-08-31'],
		academic: ['2025-09-01', '2026-06-30'],
		learning: {
			groupExternalId: '70426',
			purpose: 'students',
			plannedSeats: 43,
			enrolled: 41,
			completed: 37,
			expelled: 2
		}
	},
	{
		key: 'yutus-documentation_update-72',
		title: 'ВолгГТУ: web-разработку на «Аколе», актуализация документации',
		institution: 'yutus',
		contact: 'rodionova',
		customer: 'digital',
		programs: ['vo-bak-02'],
		products: ['lab'],
		owner: 'demo-manager',
		stage: 'documentation_update',
		startedDaysAgo: 295,
		sinceDaysAgo: 7,
		lastActivityDaysAgo: 3,
		agreement: ['2025-09-01', '2026-08-31'],
		academic: ['2025-09-01', '2026-06-30'],
		learning: {
			groupExternalId: '70427',
			purpose: 'students',
			plannedSeats: 18,
			enrolled: 18,
			completed: 17,
			expelled: 1
		},
		comments: ['Обновляем учебные материалы по итогам семестра.']
	},
	{
		key: 'batse-qualification_upgrade-73',
		title: 'Университет Иннополис: управление проектами, повышение квалификации',
		institution: 'batse',
		contact: 'tarasyuk',
		customer: 'technosphere',
		programs: ['dpo-01'],
		owner: 'veresova',
		stage: 'qualification_upgrade',
		startedDaysAgo: 337,
		sinceDaysAgo: 35,
		lastActivityDaysAgo: 14,
		agreement: ['2025-10-01', '2026-09-30'],
		academic: ['2025-10-01', '2026-06-30'],
		learning: {
			groupExternalId: '70428',
			purpose: 'teachers',
			plannedSeats: 23,
			enrolled: 22,
			completed: 19,
			expelled: 2
		},
		closeChecklist: true
	},
	{
		key: 'vkgtu-qualification_upgrade-74',
		title: 'ЧГУ им. И. Н. Ульянова: распределённые реестры, повышение квалификации',
		institution: 'vkgtu',
		contact: 'khabibullina',
		sites: ['vkgtu-main'],
		customer: 'irbis',
		programs: ['vo-mag-02'],
		products: ['security'],
		owner: 'zotov',
		stage: 'qualification_upgrade',
		startedDaysAgo: 317,
		sinceDaysAgo: 10,
		lastActivityDaysAgo: 4,
		agreement: ['2025-09-01', '2026-08-31'],
		academic: ['2025-09-01', '2026-06-30'],
		learning: {
			groupExternalId: '70429',
			purpose: 'students',
			plannedSeats: 28,
			enrolled: 26,
			completed: 23,
			expelled: 1
		}
	},
	{
		key: 'sruit-qualification_upgrade-75',
		title: 'Московский Политех: управление проектами, повышение квалификации',
		institution: 'sruit',
		contact: 'chernysheva',
		customer: 'meridian',
		programs: ['dpo-01'],
		owner: 'demo-manager',
		stage: 'qualification_upgrade',
		startedDaysAgo: 327,
		sinceDaysAgo: 15,
		lastActivityDaysAgo: 6,
		agreement: ['2025-10-01', '2026-09-30'],
		academic: ['2025-10-01', '2026-06-30'],
		learning: {
			groupExternalId: '70430',
			purpose: 'teachers',
			plannedSeats: 33,
			enrolled: 33,
			completed: 31,
			expelled: 2
		}
	},
	{
		key: 'bit-execution_control-76',
		title: 'МТУСИ: web-разработку на «Аколе», контроль исполнения',
		institution: 'bit',
		contact: 'shcherbak',
		customer: 'ladoga',
		programs: ['vo-bak-02'],
		products: ['lab'],
		owner: 'veresova',
		stage: 'execution_control',
		startedDaysAgo: 351,
		sinceDaysAgo: 25,
		lastActivityDaysAgo: 10,
		agreement: ['2025-09-01', '2026-08-31'],
		academic: ['2025-09-01', '2026-06-30'],
		learning: {
			groupExternalId: '70431',
			purpose: 'students',
			plannedSeats: 38,
			enrolled: 37,
			completed: 35,
			expelled: 1
		},
		closeChecklist: true
	},
	{
		key: 'puts-execution_control-77',
		title: 'СГТУ им. Гагарина Ю. А.: web-разработку на «Аколе», контроль исполнения',
		institution: 'puts',
		contact: 'yurchenko',
		customer: 'polarcode',
		programs: ['vo-bak-02'],
		owner: 'zotov',
		stage: 'execution_control',
		startedDaysAgo: 338,
		sinceDaysAgo: 7,
		lastActivityDaysAgo: 3,
		agreement: ['2025-09-01', '2026-08-31'],
		academic: ['2025-09-01', '2026-06-30'],
		learning: {
			groupExternalId: '70432',
			purpose: 'students',
			plannedSeats: 43,
			enrolled: 41,
			completed: 37,
			expelled: 2
		},
		comments: ['Сверяем плановые и фактические показатели за период.']
	}
];
/**
 * Довесок к тридцати сюжетным записям: несколько дел с другим исходом.
 *
 * Завершённые здесь — тот же путь, что у пяти существующих: маршрут пройден
 * целиком. Отменённые — новый исход: `cancelledWith` останавливает дело там,
 * где до него дошли, без требования дойти до финальной стадии. Все пять
 * отменены рано — до подписания, — потому что так эти сделки чаще всего и
 * срываются: подписанное соглашение расторгают редко, а вот до него не
 * доходят часто.
 */
const B2B_EXTRA: readonly InteractionSeed[] = [
	{
		key: 'uguis-2025b',
		externalApplication: { id: 'site-2026-000210' },
		title: 'ТПУ: web-разработка на «Аколе», выпуск 2025/2026',
		institution: 'uguis',
		contact: 'lapina',
		customer: 'technosphere',
		programs: ['vo-bak-02'],
		products: ['lab'],
		owner: 'zotov',
		stage: 'execution_control',
		startedDaysAgo: 310,
		sinceDaysAgo: 18,
		lastActivityDaysAgo: 18,
		agreement: ['2025-09-01', '2026-08-31'],
		academic: ['2025-09-01', '2026-06-30'],
		learning: {
			groupExternalId: '70600',
			purpose: 'students',
			plannedSeats: 36,
			enrolled: 35,
			completed: 33,
			expelled: 2
		},
		completedWith:
			'Web-разработка на «Аколе» прочитана полностью, 33 студента получили документы об обучении.'
	},
	{
		key: 'vkgtu-2025-mag',
		externalApplication: { id: 'site-2026-000211' },
		title: 'ЧГУ им. И. Н. Ульянова: распределённые реестры, выпуск 2025/2026',
		institution: 'vkgtu',
		contact: 'fedotov',
		sites: ['vkgtu-main'],
		customer: 'meridian',
		programs: ['vo-mag-02'],
		products: ['security'],
		owner: 'demo-manager',
		stage: 'execution_control',
		startedDaysAgo: 340,
		sinceDaysAgo: 22,
		lastActivityDaysAgo: 22,
		agreement: ['2025-09-01', '2026-08-31'],
		academic: ['2025-09-01', '2026-06-30'],
		learning: {
			groupExternalId: '70601',
			purpose: 'students',
			plannedSeats: 15,
			enrolled: 14,
			completed: 12,
			expelled: 1
		},
		completedWith:
			'Магистерская программа по распределённым реестрам закрыта, документы выданы двенадцати выпускникам.'
	},
	{
		key: 'ukct-2025-spo',
		title: 'УКЦТ: аналитика на Python, выпуск 2025/2026',
		institution: 'ukct',
		contact: 'ershova',
		sites: ['ukct-main'],
		customer: 'ladoga',
		programs: ['spo-02'],
		products: ['lms'],
		owner: 'veresova',
		stage: 'execution_control',
		startedDaysAgo: 295,
		sinceDaysAgo: 14,
		lastActivityDaysAgo: 14,
		agreement: ['2025-09-01', '2026-06-30'],
		academic: ['2025-09-01', '2026-06-30'],
		learning: {
			groupExternalId: '70602',
			purpose: 'students',
			plannedSeats: 32,
			enrolled: 30,
			completed: 28,
			expelled: 2
		},
		completedWith: 'Группа СПО завершила обучение, дипломы о переподготовке выданы.'
	},
	{
		key: 'skpa-otkaz-contact',
		title: 'СКПА: SQL-разработчики, вторая группа',
		institution: 'skpa',
		contact: 'lebedeva',
		customer: 'technosphere',
		programs: ['spo-01'],
		owner: 'zotov',
		stage: 'contact_search',
		startedDaysAgo: 40,
		sinceDaysAgo: 40,
		lastActivityDaysAgo: 40,
		agreement: ['2026-09-01', '2027-08-31'],
		cancelledWith:
			'Колледж не вышел на связь: профильное подразделение за месяц не нашли, работу остановили.'
	},
	{
		key: 'vts-otkaz-comm',
		title: 'ВТС: аналитика на Python, вечерний поток',
		institution: 'vts',
		contact: 'karpov',
		customer: 'ladoga',
		programs: ['spo-02'],
		owner: 'demo-manager',
		stage: 'communication',
		startedDaysAgo: 55,
		sinceDaysAgo: 30,
		lastActivityDaysAgo: 28,
		agreement: ['2026-09-01', '2027-08-31'],
		cancelledWith: 'Техникум перенёс набор на следующий год: бюджет на курс не согласовали.'
	},
	{
		key: 'batse-otkaz-meeting',
		title: 'Университет Иннополис: повышение квалификации, весенний поток',
		institution: 'batse',
		contact: 'tarasyuk',
		customer: 'irbis',
		programs: ['dpo-01'],
		owner: 'veresova',
		stage: 'meeting',
		startedDaysAgo: 70,
		sinceDaysAgo: 35,
		lastActivityDaysAgo: 33,
		agreement: ['2026-10-01', '2027-09-30'],
		cancelledWith:
			'Встречу трижды переносили: вуз выбрал другого подрядчика по повышению квалификации.'
	},
	{
		key: 'paid-otkaz-docs',
		title: 'НИУ «МЭИ»: мобильная разработка на «Авроре», пилотный поток',
		institution: 'paid',
		contact: 'vikhrova',
		sites: ['paid-main'],
		customer: 'digital',
		programs: ['vo-bak-03'],
		owner: 'zotov',
		stage: 'document_exchange',
		startedDaysAgo: 90,
		sinceDaysAgo: 45,
		lastActivityDaysAgo: 40,
		agreement: ['2026-09-01', '2027-08-31'],
		cancelledWith:
			'Реквизиты так и не сверили: переписка с вузом прекратилась после смены проректора.'
	},
	{
		key: 'sruit-otkaz-revision',
		title: 'Московский Политех: управление проектами, корпоративная группа',
		institution: 'sruit',
		contact: 'chernysheva',
		customer: 'polarcode',
		programs: ['dpo-01'],
		owner: 'demo-manager',
		stage: 'document_revision',
		startedDaysAgo: 100,
		sinceDaysAgo: 20,
		lastActivityDaysAgo: 18,
		agreement: ['2026-10-01', '2027-09-30'],
		cancelledWith: 'Юридическая служба вуза отклонила правки без альтернативы, стороны разошлись.'
	}
];

/**
 * Коммерческое обучение — короткий процесс из пяти стадий.
 *
 * Четыре сюжетные записи, и каждая отвечает на свой вопрос демонстрации: заявка
 * только что принята, договор на оплате, обучение идёт (и подтверждено фактом
 * из системы обучения), обучение закончено с выданным документом. Ключи и
 * состав — часть демонстрационного сценария, не трогать. Довесок — в
 * `B2C_EXTRA` ниже: те же два контрагента, физическое лицо и юридическое, —
 * пространство `b2c` собирает именно их, а процесс у них один, — ведут ещё
 * несколько дел за год.
 */
const B2C_INTERACTIONS: readonly InteractionSeed[] = [
	{
		key: 'sorokin-zayavka',
		title: 'Сорокин А. П.: управление проектами, заявка',
		counterparty: 'individual-sorokin',
		contact: 'sorokin',
		programs: ['dpo-01'],
		owner: 'demo-manager',
		stage: 'lead_intake',
		startedDaysAgo: 2,
		sinceDaysAgo: 2,
		lastActivityDaysAgo: 1,
		agreement: ['2026-09-01', '2026-12-31'],
		comments: ['Просит вечернюю группу и счёт на физическое лицо.']
	},
	{
		key: 'sorokin-obuchenie',
		title: 'Сорокин А. П.: управление проектами, поток 2026/1',
		counterparty: 'individual-sorokin',
		contact: 'sorokin',
		programs: ['dpo-01'],
		products: ['docs'],
		owner: 'demo-manager',
		stage: 'learning',
		startedDaysAgo: 64,
		sinceDaysAgo: 20,
		lastActivityDaysAgo: 4,
		agreement: ['2026-06-01', '2026-12-31'],
		academic: ['2026-07-01', '2026-11-30'],
		// Обучение идёт: выпускников ещё нет, даты окончания у потока тоже.
		learning: {
			groupExternalId: '70501',
			purpose: 'upskilling',
			plannedSeats: 1,
			enrolled: 1,
			completed: 0,
			expelled: 0
		},
		closeChecklist: true
	},
	{
		key: 'mayak-dogovor',
		title: 'Маяк-Телеком: аналитика на Python для аналитиков',
		counterparty: 'mayak',
		contact: 'kudryashova',
		programs: ['spo-02'],
		products: ['analytics'],
		owner: 'demo-manager',
		stage: 'contract_payment',
		startedDaysAgo: 25,
		sinceDaysAgo: 6,
		lastActivityDaysAgo: 3,
		agreement: ['2026-10-01', '2027-03-31'],
		comments: ['Счёт выставлен на двенадцать сотрудников, ждём оплату от бухгалтерии.']
	},
	{
		key: 'mayak-vypusk',
		title: 'Маяк-Телеком: промпт-инжиниринг, выпуск весны 2026',
		counterparty: 'mayak',
		contact: 'kudryashova',
		programs: ['school-01'],
		owner: 'demo-manager',
		stage: 'completion',
		startedDaysAgo: 200,
		sinceDaysAgo: 30,
		lastActivityDaysAgo: 30,
		agreement: ['2026-01-15', '2026-06-30'],
		academic: ['2026-02-01', '2026-05-31'],
		learning: {
			groupExternalId: '70502',
			purpose: 'upskilling',
			plannedSeats: 10,
			enrolled: 11,
			completed: 10,
			expelled: 1
		},
		completedWith: 'Десять сотрудников прошли курс, удостоверения выданы и переданы работодателю.'
	}
];

/**
 * Довесок к четырём сюжетным записям B2C: та же пара контрагентов ведёт
 * ещё несколько дел — так и выглядела бы их история за год, — плюс завершённое
 * и отменённое дело, которых у исходных четырёх не было.
 */
const B2C_EXTRA: readonly InteractionSeed[] = [
	{
		key: 'mayak-offer-1',
		title: 'Маяк-Телеком: аналитика на Python, предложение для отдела ИТ',
		counterparty: 'mayak',
		contact: 'kudryashova',
		programs: ['spo-02'],
		owner: 'demo-manager',
		stage: 'offer',
		startedDaysAgo: 10,
		sinceDaysAgo: 6,
		lastActivityDaysAgo: 2,
		agreement: ['2026-11-01', '2027-04-30']
	},
	{
		key: 'sorokin-offer-1',
		title: 'Сорокин А. П.: промпт-инжиниринг, предложение',
		counterparty: 'individual-sorokin',
		contact: 'sorokin',
		programs: ['school-01'],
		owner: 'demo-manager',
		stage: 'offer',
		startedDaysAgo: 8,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 2,
		agreement: ['2026-10-01', '2027-01-31']
	},
	{
		key: 'mayak-offer-2',
		externalApplication: { id: 'site-2026-000213' },
		title: 'Маяк-Телеком: управление проектами, предложение для руководителей смен',
		counterparty: 'mayak',
		contact: 'kudryashova',
		programs: ['dpo-01'],
		owner: 'demo-manager',
		stage: 'offer',
		startedDaysAgo: 15,
		sinceDaysAgo: 9,
		lastActivityDaysAgo: 4,
		agreement: ['2026-11-15', '2027-05-15']
	},
	{
		key: 'sorokin-zayavka-2',
		externalApplication: { id: 'site-2026-000212' },
		title: 'Сорокин А. П.: аналитика на Python, вторая заявка',
		counterparty: 'individual-sorokin',
		contact: 'sorokin',
		programs: ['spo-02'],
		owner: 'demo-manager',
		stage: 'lead_intake',
		startedDaysAgo: 3,
		sinceDaysAgo: 3,
		lastActivityDaysAgo: 1,
		agreement: ['2026-09-15', '2026-12-15']
	},
	{
		key: 'mayak-dogovor-2',
		externalApplication: { id: 'site-2026-000214' },
		title: 'Маяк-Телеком: промпт-инжиниринг, вторая группа сотрудников',
		counterparty: 'mayak',
		contact: 'kudryashova',
		programs: ['school-01'],
		owner: 'demo-manager',
		stage: 'contract_payment',
		startedDaysAgo: 35,
		sinceDaysAgo: 12,
		lastActivityDaysAgo: 5,
		agreement: ['2026-08-01', '2027-01-31'],
		comments: ['Договор согласован, ждём оплату по счёту от бухгалтерии заказчика.']
	},
	{
		key: 'mayak-obuchenie-2',
		title: 'Маяк-Телеком: SQL-разработчики, поток 2026/2',
		counterparty: 'mayak',
		contact: 'kudryashova',
		programs: ['spo-01'],
		products: ['docs'],
		owner: 'demo-manager',
		stage: 'learning',
		startedDaysAgo: 70,
		sinceDaysAgo: 25,
		lastActivityDaysAgo: 5,
		agreement: ['2026-07-01', '2026-12-31'],
		academic: ['2026-08-01', '2026-12-15'],
		learning: {
			groupExternalId: '70503',
			purpose: 'upskilling',
			plannedSeats: 8,
			enrolled: 8,
			completed: 0,
			expelled: 0
		},
		closeChecklist: true
	},
	{
		key: 'sorokin-vypusk',
		externalApplication: { id: 'site-2026-000215' },
		title: 'Сорокин А. П.: SQL-разработчик, выпуск 2026',
		counterparty: 'individual-sorokin',
		contact: 'sorokin',
		programs: ['spo-01'],
		products: ['docs'],
		owner: 'demo-manager',
		stage: 'completion',
		startedDaysAgo: 150,
		sinceDaysAgo: 20,
		lastActivityDaysAgo: 20,
		agreement: ['2026-04-01', '2026-09-30'],
		academic: ['2026-05-01', '2026-08-31'],
		learning: {
			groupExternalId: '70504',
			purpose: 'upskilling',
			plannedSeats: 1,
			enrolled: 1,
			completed: 1,
			expelled: 0
		},
		completedWith: 'Курс SQL-разработчика завершён, удостоверение выдано.'
	},
	{
		key: 'sorokin-otkaz',
		title: 'Сорокин А. П.: управление проектами, вторая заявка',
		counterparty: 'individual-sorokin',
		contact: 'sorokin',
		programs: ['dpo-01'],
		owner: 'demo-manager',
		stage: 'contract_payment',
		startedDaysAgo: 45,
		sinceDaysAgo: 20,
		lastActivityDaysAgo: 18,
		agreement: ['2026-08-01', '2027-01-31'],
		cancelledWith: 'Слушатель отказался от обучения после счёта: оплату переносить не стал.'
	}
];

/** Все записи пространства `b2b`: сюжетные, воронка и довесок с другим исходом. */
const B2B_ALL: readonly InteractionSeed[] = [...INTERACTIONS, ...FUNNEL_INTERACTIONS, ...B2B_EXTRA];

/** Все записи пространства `b2c`: сюжетные и довесок. */
const B2C_ALL: readonly InteractionSeed[] = [...B2C_INTERACTIONS, ...B2C_EXTRA];

/**
 * Весь набор взаимодействий: оба пространства одним списком. Порядок значения
 * не имеет — каждая запись сама говорит, по какому процессу идёт.
 */
const ALL_INTERACTIONS: readonly InteractionSeed[] = [...B2B_ALL, ...B2C_ALL];

/**
 * Результат стадии там, где маршрут его требует. Пустая строка движок не
 * устроит, а «результат стадии» вместо текста не расскажет ничего тому, кто
 * откроет историю на демонстрации.
 */
const STAGE_RESULTS: Record<string, string> = {
	materials_handover: 'Комплект материалов и лицензии переданы, акт подписан обеими сторонами.',
	implementation_support: 'Учебная среда развёрнута, канал поддержки открыт.',
	teacher_training: 'Группа преподавателей обучена, обратная связь собрана.',
	program_update: 'Изменения внесены в программу и согласованы с учебным заведением.',
	classes: 'Занятия проведены по расписанию, промежуточный разбор выполнен.',
	documentation_update: 'Учебные материалы обновлены и выложены в хранилище.',
	qualification_upgrade: 'Участники прошли повышение квалификации, документы выданы.',
	learning: 'Слушатели зачислены в поток, занятия идут по расписанию.',
	completion: 'Итоговая аттестация проведена, документы об обучении выданы.'
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBefore(base: Date, days: number): Date {
	return new Date(base.getTime() - days * DAY_MS);
}

/** Стадия маршрута по ключу конфигурации. */
function stageByKey(stages: readonly StageView[], key: string): StageView {
	const stage = stages.find((candidate) => candidate.key === key);

	if (stage === undefined) {
		throw new Error(`В процессе нет стадии «${key}»`);
	}

	return stage;
}

/** Описание процесса, по которому идёт эта запись: его задаёт вид контрагента. */
function processOf(seed: InteractionSeed): ProcessDefinitionInput {
	return 'institution' in seed ? B2B_PROCESS : B2C_PROCESS;
}

/** Ключ пространства записи — тем же правилом, что и само описание. */
function workspaceKeyOf(seed: InteractionSeed): string {
	return 'institution' in seed ? B2B_WORKSPACE_KEY : B2C_WORKSPACE_KEY;
}

/** Просрочка — следствие данных набора, а не отдельный флаг: часы считает база. */
function isOverdueSeed(seed: InteractionSeed): boolean {
	if (
		seed.completedWith !== undefined ||
		seed.cancelledWith !== undefined ||
		seed.pause !== undefined
	) {
		return false;
	}

	const process = processOf(seed);
	const stage = process.stages.find((candidate) => candidate.key === seed.stage);

	if (stage === undefined) {
		throw new Error(`В процессе «${process.name}» нет стадии «${seed.stage}»`);
	}

	// «>=», а не «>»: представление `stage_entry_status` сравнивает `due_at`
	// (момент входа плюс норматив) со временем чтения, а не со временем
	// заливки. У записи, вошедшей в стадию ровно `slaDays` дней назад, `due_at`
	// совпадает с моментом заливки и оказывается раньше любого более позднего
	// чтения — она просрочена всегда, а не только пока идёт сама заливка.
	return seed.sinceDaysAgo >= stage.slaDays;
}

/**
 * Сколько чего описано в наборе. Тест сверяет с этим то, что оказалось в базе:
 * расхождение означает, что движок или представление со сроком ведут себя не
 * так, как задумано в демонстрации.
 */
export const INTERACTION_SEED_SIZES = {
	interactions: ALL_INTERACTIONS.length,
	/** Записи пространства B2C: обучение физических и юридических лиц. */
	b2c: B2C_ALL.length,
	completed: ALL_INTERACTIONS.filter((seed) => seed.completedWith !== undefined).length,
	/** Завершённые по пространствам: маршруты у них разной длины. */
	completedB2b: B2B_ALL.filter((seed) => seed.completedWith !== undefined).length,
	completedB2c: B2C_ALL.filter((seed) => seed.completedWith !== undefined).length,
	/**
	 * Отменённые: маршрут не пройден, дело остановлено там, где до него дошли.
	 * В отличие от завершённых, отмена не требует финальной стадии — считать по
	 * пространствам всё равно приходится: у отменённого дела нет всех записей
	 * стадий маршрута, а у завершённого есть.
	 */
	cancelled: ALL_INTERACTIONS.filter((seed) => seed.cancelledWith !== undefined).length,
	cancelledB2b: B2B_ALL.filter((seed) => seed.cancelledWith !== undefined).length,
	cancelledB2c: B2C_ALL.filter((seed) => seed.cancelledWith !== undefined).length,
	overdue: ALL_INTERACTIONS.filter(isOverdueSeed).length,
	paused: ALL_INTERACTIONS.filter((seed) => seed.pause !== undefined).length,
	blockers: ALL_INTERACTIONS.filter((seed) => seed.blocker !== undefined).length,
	comments: ALL_INTERACTIONS.reduce((total, seed) => total + (seed.comments?.length ?? 0), 0),
	documents: ALL_INTERACTIONS.filter((seed) => seed.document === true).length,
	// Скан и его вторая редакция — две записи на каждое такое взаимодействие.
	scans: ALL_INTERACTIONS.filter((seed) => seed.scanWithRevision === true).length * 2,
	/**
	 * Подписанные экземпляры соглашения: по одному на дело, прошедшее стадию
	 * подписания, и на то, которое стоит на ней с приложенным экземпляром. Без
	 * такого документа стадия не отпускает вперёд — это не украшение набора, а
	 * условие движения.
	 */
	signedAgreements: ALL_INTERACTIONS.filter(needsSignedAgreement).length,
	handovers: ALL_INTERACTIONS.filter((seed) => seed.handedTo !== undefined).length,
	/**
	 * Потоки обучения и их результаты: по одному на запись, дошедшую до стадии с
	 * данными из системы обучения. Строка результата одна, сколько бы раз набор
	 * ни звал подтверждение: её ключ — пара «поток и момент», а момент считается
	 * от одной точки отсчёта на всю заливку.
	 */
	learningGroups: ALL_INTERACTIONS.filter((seed) => seed.learning !== undefined).length,
	learningResults: ALL_INTERACTIONS.filter((seed) => seed.learning !== undefined).length
} as const;

/**
 * Появится ли у дела подписанный экземпляр соглашения.
 *
 * Правило то же, по которому его кладёт заливка: шаг вперёд со стадии с
 * `requiresDocumentMark` без отметки не проходит, а дело, оставшееся на ней,
 * получает экземпляр только по явному признаку набора.
 */
function needsSignedAgreement(seed: InteractionSeed): boolean {
	const signing = B2B_PROCESS.stages.findIndex((stage) => stage.requiresDocumentMark !== null);
	const position = B2B_PROCESS.stages.findIndex((stage) => stage.key === seed.stage);

	if (signing === -1 || position === -1) {
		return false;
	}

	if (position > signing) {
		return true;
	}

	// Дело, сходившее вперёд и вернувшееся, стадию подписания проходило — значит,
	// экземпляр у него есть.
	return position === signing && (seed.signedDocument === true || seed.returnedFrom !== undefined);
}

/**
 * Действующее лицо набора — сотрудник, а не «система».
 *
 * Источник у контекста всё-таки системный: набор заливают скрипт и контейнер, и
 * ни запроса, ни браузера за ним нет. Но у комментария, помехи и отметки
 * подтверждения есть автор, и назвать им систему значило бы соврать в карточке
 * и в журнале.
 */
function seedActor(user: {
	id: string;
	email: string;
	fullName: string;
	roleId: string;
}): ActorContext {
	return {
		requestId: randomUUID(),
		source: 'system',
		user: {
			id: user.id,
			email: user.email,
			fullName: user.fullName,
			roleId: user.roleId,
			roleName: user.roleId,
			permissions: defaultRolePermissions(user.roleId),
			isDemo: false,
			scope: { kind: 'all' }
		},
		apiKeyId: null,
		ip: null,
		userAgent: null,
		scope: { kind: 'all' }
	};
}

type Database = ReturnType<typeof getDb>;

async function readOwners(db: Database): Promise<Map<OwnerKey, ActorContext>> {
	const idByKey = new Map(OWNER_KEYS.map((key) => [seedId('user', key), key]));
	const rows = await db
		.select({
			id: users.id,
			email: users.email,
			fullName: users.fullName,
			roleId: users.roleId
		})
		.from(users)
		.where(inArray(users.id, [...idByKey.keys()]));

	const owners = new Map<OwnerKey, ActorContext>();

	for (const row of rows) {
		const key = idByKey.get(row.id);

		if (key !== undefined) {
			owners.set(key, seedActor(row));
		}
	}

	for (const key of OWNER_KEYS) {
		if (!owners.has(key)) {
			throw new Error(`Учётная запись «${key}» не заведена: сначала заливаются пользователи`);
		}
	}

	return owners;
}

/**
 * Машинный субъект обмена: от его имени в систему приходит то, что прислала
 * чужая система. По почте, а не по вычисляемому идентификатору: учётная запись
 * с такой почтой могла появиться на стенде раньше набора, и тогда
 * идентификатор у неё другой (`users.ts`).
 */
async function readService(db: Database): Promise<ActorContext> {
	const [row] = await db
		.select({
			id: users.id,
			email: users.email,
			fullName: users.fullName,
			roleId: users.roleId
		})
		.from(users)
		.where(eq(users.email, SERVICE_USER_EMAIL))
		.limit(1);

	if (row === undefined) {
		throw new Error('Машинный субъект обмена не заведён: сначала заливаются пользователи');
	}

	return seedActor(row);
}

/** Последняя версия каждой программы: взаимодействие ссылается именно на неё. */
async function readLatestProgramVersions(db: Database): Promise<Map<string, string>> {
	const rows = await db
		.select({
			id: programVersions.id,
			programId: programVersions.programId,
			version: programVersions.version
		})
		.from(programVersions)
		.orderBy(asc(programVersions.version));

	const latest = new Map<string, string>();

	// Строки идут от младшей версии к старшей, поэтому последняя запись по
	// программе и есть её текущая версия.
	for (const row of rows) {
		latest.set(row.programId, row.id);
	}

	return latest;
}

/** Оператор стоит стороной в каждой записи: процесс ведёт он. */
const OPERATOR_PARTY = {
	organizationId: seedId('organization', 'operator'),
	partyRole: 'operator',
	isPrimary: false,
	contactAffiliationId: seedId('affiliation', 'orlov-primary'),
	siteIds: []
};

/** Стороны записи в том виде, в каком их принимает контракт создания. */
function partiesOf(seed: InteractionSeed) {
	if ('institution' in seed) {
		return [
			{
				organizationId: seedId('organization', seed.institution),
				partyRole: 'educational_institution',
				isPrimary: true,
				contactAffiliationId: seedId('affiliation', `${seed.contact}-primary`),
				siteIds: (seed.sites ?? []).map((site) => seedId('site', site))
			},
			{
				organizationId: seedId('organization', seed.customer),
				partyRole: 'customer',
				isPrimary: false,
				contactAffiliationId: null,
				siteIds: []
			},
			OPERATOR_PARTY
		];
	}

	return [
		{
			organizationId: seedId('organization', seed.counterparty),
			partyRole: 'customer',
			isPrimary: true,
			contactAffiliationId: seedId('affiliation', `${seed.contact}-primary`),
			siteIds: []
		},
		OPERATOR_PARTY
	];
}

function toCreateInput(
	seed: InteractionSeed,
	versions: Map<string, string>,
	cmsInstance: string
): CreateInteractionInput {
	const raw = {
		title: seed.title,
		agreementPeriodStart: seed.agreement[0],
		agreementPeriodEnd: seed.agreement[1],
		academicPeriodStart: seed.academic?.[0] ?? null,
		academicPeriodEnd: seed.academic?.[1] ?? null,
		ownerUserId: seedId('user', seed.owner),
		parties: partiesOf(seed),
		programs: seed.programs.map((program) => {
			const programId = seedId('program', program);

			return { programId, programVersionId: versions.get(programId) ?? null };
		}),
		productIds: (seed.products ?? []).map((product) => seedId('product', product)),
		// Экземпляр подключения — тот же, что у обмена: заявка, заведённая набором,
		// не должна отличаться источником от той, что реально примет `POST
		// /v1/applications` (`externalSourceOf`, `integrations/exchange/intake.ts`).
		externalSource:
			seed.externalApplication === undefined ? null : externalSourceOf('cms', cmsInstance),
		externalId: seed.externalApplication?.id ?? null
	};

	const parsed = createInteractionSchema.safeParse(raw);

	if (!parsed.success) {
		throw new Error(
			`Взаимодействие «${seed.key}» не прошло проверку контракта: ${parsed.error.issues
				.map((issue) => issue.message)
				.join('; ')}`
		);
	}

	return parsed.data;
}

/**
 * Заводит взаимодействие с заранее известным идентификатором и ставит его на
 * первую стадию.
 *
 * Это единственное место, где набор пишет в таблицы взаимодействия сам, а не
 * через `createInteraction`: сервис выдаёт запись случайный идентификатор, а
 * повторный сид узнаёт свои строки только по вычисляемому. Первая стадия и
 * событие журнала всё равно достаются движку — запись без стадии не должна
 * существовать даже мгновение, поэтому всё происходит одной транзакцией.
 */
async function createSeededInteraction(
	ctx: ActorContext,
	db: Database,
	id: string,
	input: CreateInteractionInput,
	workspace: { id: string; key: string; revision: ProcessRevisionView },
	externalRevision: number | null
): Promise<boolean> {
	return db.transaction(async (tx: Tx) => {
		const created = await tx
			.insert(interactions)
			.values({
				id,
				title: input.title,
				workspaceId: workspace.id,
				agreementPeriodStart: input.agreementPeriodStart,
				agreementPeriodEnd: input.agreementPeriodEnd,
				academicPeriodStart: input.academicPeriodStart,
				academicPeriodEnd: input.academicPeriodEnd,
				ownerUserId: input.ownerUserId,
				// Как у настоящей заявки (`intake.ts`): источник и номер обращения
				// остаются на деле, а ревизия — последняя применённая заявкой.
				externalSource: input.externalSource,
				externalId: input.externalId,
				externalRevision
			})
			.onConflictDoNothing({ target: interactions.id })
			.returning({ id: interactions.id });

		if (created.length === 0) {
			return false;
		}

		for (const party of input.parties) {
			const [row] = await tx
				.insert(interactionParties)
				.values({
					interactionId: id,
					organizationId: party.organizationId,
					partyRole: party.partyRole,
					isPrimary: party.isPrimary,
					contactAffiliationId: party.contactAffiliationId
				})
				.returning({ id: interactionParties.id });

			if (party.siteIds.length > 0) {
				await tx
					.insert(interactionPartySites)
					.values(party.siteIds.map((siteId) => ({ partyId: row.id, siteId })));
			}
		}

		if (input.programs.length > 0) {
			await tx.insert(interactionPrograms).values(
				input.programs.map((program) => ({
					interactionId: id,
					programId: program.programId,
					programVersionId: program.programVersionId
				}))
			);
		}

		if (input.productIds.length > 0) {
			await tx
				.insert(interactionProducts)
				.values(input.productIds.map((productId) => ({ interactionId: id, productId })));
		}

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.created',
				outcome: 'success',
				subject: { type: 'interaction', id },
				details: { workspaceKey: workspace.key, revisionId: workspace.revision.id }
			},
			tx
		);

		await startInteractionIn(
			ctx,
			tx,
			{ id, workspaceId: workspace.id, ownerUserId: input.ownerUserId },
			workspace.revision
		);

		return true;
	});
}

/**
 * Поток обучения и его результат: факт, которым подтверждается стадия
 * «Ведение занятий».
 *
 * На стенде такой факт приезжает обменом — заявкой в систему обучения и
 * ответным сообщением (`docs/exchange-contract.md`, направления 3 и 4). Набор
 * кладёт его строками: имитатор системы обучения поднят не на каждой
 * установке, а стадия без данных обучения не подтверждается и не отпускает
 * вперёд. Подтверждение при этом ставит движок — `applyLmsEvidence`, тот же
 * код, что зовёт приём результата; набор пишет только сам факт.
 *
 * Действует машинный субъект, а не менеджер: результат прислала чужая система,
 * и подпись сотрудника под ним была бы неправдой.
 *
 * Повторный вызов ничего не портит: строки узнают себя по ключам, а стадия,
 * уже подтверждённая итогом, второй раз не подтверждается.
 */
async function recordLearningResult(
	service: ActorContext,
	seed: InteractionSeed,
	interactionId: string,
	instance: string,
	runStart: Date
): Promise<void> {
	const learning = seed.learning;

	if (learning === undefined) {
		throw new Error(
			`Взаимодействию «${seed.key}» нужен поток обучения: стадия «${seed.stage}» требует факта из системы обучения`
		);
	}

	if (seed.programs.length !== 1) {
		throw new Error(
			`Взаимодействию «${seed.key}» с потоком обучения нужна ровно одна программа: группа закрепляет её без выбора`
		);
	}

	const [periodStart, periodEnd] = seed.academic ?? seed.agreement;
	const learningGroupId = seedId('learning-group', seed.key);
	// Точных дат у набора нет, а порядок важен: поток заводят задолго до
	// результата, а результат — последнее, что по взаимодействию случилось.
	const requestedAt = daysBefore(runStart, seed.lastActivityDaysAgo + 30);
	const occurredAt = daysBefore(runStart, seed.lastActivityDaysAgo);
	const evidence = {
		kind: 'result',
		system: 'lms',
		instance,
		groupExternalId: learning.groupExternalId,
		learningGroupId,
		occurredAt: occurredAt.toISOString(),
		enrolled: learning.enrolled,
		completed: learning.completed,
		expelled: learning.expelled,
		// Обучение ещё идёт — даты окончания у потока нет.
		finishedOn: learning.completed === 0 ? null : periodEnd,
		periodStart,
		periodEnd
	} satisfies LmsEvidence;

	await withTransaction(service, async (tx: Tx) => {
		await tx
			.insert(learningGroups)
			.values({
				id: learningGroupId,
				interactionId,
				streamNumber: 1,
				system: evidence.system,
				instance: evidence.instance,
				groupExternalId: evidence.groupExternalId,
				requestedAt,
				plannedSeats: learning.plannedSeats,
				startsOn: periodStart,
				endsOn: periodEnd,
				lastResultAt: occurredAt,
				programId: seedId('program', seed.programs[0]),
				purpose: learning.purpose
			})
			.onConflictDoNothing({ target: learningGroups.id });

		if ((seed.products ?? []).length > 0) {
			await tx
				.insert(learningGroupProducts)
				.values(
					(seed.products ?? []).map((product) => ({
						learningGroupId,
						productId: seedId('product', product)
					}))
				)
				.onConflictDoNothing();
		}

		await tx
			.insert(learningGroupResults)
			.values({
				learningGroupId,
				occurredAt,
				periodStart,
				periodEnd,
				finishedOn: evidence.finishedOn,
				enrolled: evidence.enrolled,
				completed: evidence.completed,
				expelled: evidence.expelled
			})
			.onConflictDoNothing({
				target: [learningGroupResults.learningGroupId, learningGroupResults.occurredAt]
			});

		await applyLmsEvidence(service, tx, { interactionId, evidence });
	});
}

/**
 * Подписанный экземпляр соглашения и отметка на нём: факт, которым
 * подтверждается стадия подписания.
 *
 * Подтверждение ставит движок — он зовётся из самой отметки (`markDocument`);
 * набор кладёт только документ и отметку, ровно как это сделал бы менеджер,
 * получивший подписанный экземпляр.
 *
 * Повторный вызов ничего не портит: отметка неизменяема, и там, где нужная уже
 * стоит, набор не заводит второй документ.
 */
async function recordSignedAgreement(
	ctx: ActorContext,
	interactionId: string,
	mark: DocumentStatusFact
): Promise<void> {
	if ((await readDocumentMark(getDb(), interactionId, mark)) !== null) {
		return;
	}

	const document = await uploadDocument(ctx, {
		interactionId,
		kind: 'agreement',
		title: 'Соглашение о сотрудничестве, подписанный экземпляр',
		file: {
			mime: 'text/plain',
			bytes: new TextEncoder().encode(
				'Соглашение о сотрудничестве.\nПодписанный сторонами экземпляр, приложенный к делу.\n'
			)
		}
	});

	await markDocument(ctx, document.id, mark, undefined, 'Подписан обеими сторонами');
}

/**
 * Доказательство исполнения финальной стадии — перед завершением дела.
 *
 * Завершение требует того же, что и шаг вперёд: результат, подтверждение, факт
 * из системы обучения. У длинного процесса работы с вузом финальная стадия
 * ничего этого не просит, а у короткого процесса обучения лиц — просит
 * результат, и без него `completeInteraction` справедливо отвечает отказом.
 * Факт обучения к этому моменту уже записан — его кладёт сам проход.
 */
async function closeFinalStage(
	ctx: ActorContext,
	interactionId: string,
	stage: StageView
): Promise<void> {
	if (!stage.requiresLmsData && stage.requiresConfirmation) {
		await confirmStage(ctx, {
			interactionId,
			fromStageId: stage.id,
			confirmation: { kind: 'mark' }
		});
	}

	if (stage.requiresResult) {
		const resultText = STAGE_RESULTS[stage.key];

		if (resultText === undefined) {
			throw new Error(`Для финальной стадии «${stage.key}» не описан результат`);
		}

		await setStageResult(ctx, { interactionId, resultText });
	}
}

/** Один шаг вперёд со всем, чего стадия требует перед выходом. */
async function stepForward(
	ctx: ActorContext,
	interactionId: string,
	from: StageView,
	toStageId: string,
	revision: number,
	/** Факт обучения — для стадии, которая без него никуда не отпускает. */
	provideLmsEvidence: () => Promise<void>
): Promise<void> {
	if (from.requiresDocumentMark !== null) {
		// Стадию с отметкой по документу закрывает сам документ: движок ставит на
		// неё подтверждение видом `document_mark`.
		await recordSignedAgreement(ctx, interactionId, from.requiresDocumentMark);
	}

	if (from.requiresLmsData) {
		// Стадию с данными обучения подтверждает сам факт: движок ставит на неё
		// подтверждение видом `lms_record`. Отметка ответственного поверх него
		// стёрла бы то, чем стадия подтверждена на самом деле.
		await provideLmsEvidence();
	} else if (from.requiresConfirmation) {
		await confirmStage(ctx, {
			interactionId,
			fromStageId: from.id,
			confirmation: { kind: 'mark' }
		});
	}

	await advanceStage(ctx, {
		interactionId,
		fromStageId: from.id,
		toStageId,
		revision,
		// Комментарий к шагу вперёд просит только процесс, который так настроен;
		// у демонстрационного такого перехода нет.
		reason: null,
		resultText: from.requiresResult ? (STAGE_RESULTS[from.key] ?? null) : null,
		// Отметки чек-листа едут вместе с переходом: «закрыть последний пункт и
		// сразу перейти» — законная операция движка, а не два круга.
		checklistState: Object.fromEntries(
			from.checklist.filter((item) => item.required).map((item) => [item.key, true])
		)
	});
}

type Process = {
	stages: StageView[];
	/** Куда ведёт шаг вперёд с этой стадии. */
	forward: Map<string, string>;
	/** Номер действующей редакции: его несёт каждая команда перехода. */
	revision: number;
	/** Сама редакция: её снимок кладёт первая стадия заведённой записи. */
	revisionView: ProcessRevisionView;
};

/** Проводит взаимодействие по процессу до нужной стадии. */
async function walkTo(
	ctx: ActorContext,
	interactionId: string,
	process: Process,
	targetKey: string,
	provideLmsEvidence: () => Promise<void>
): Promise<void> {
	const target = stageByKey(process.stages, targetKey);

	for (const stage of process.stages) {
		if (stage.position >= target.position) {
			break;
		}

		const next = process.forward.get(stage.id);

		if (next === undefined) {
			throw new Error(`Со стадии «${stage.key}» нет шага вперёд`);
		}

		await stepForward(ctx, interactionId, stage, next, process.revision, provideLmsEvidence);
	}
}

/** Открытая запись стадии: к ней привязаны пауза, помеха и отметки. */
async function readOpenEntry(
	db: Database,
	interactionId: string
): Promise<{ id: string; stageId: string }> {
	const [row] = await db
		.select({ id: stageEntries.id, stageId: stageEntries.stageId })
		.from(stageEntries)
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)))
		.limit(1);

	if (row === undefined) {
		throw new Error(`Взаимодействие ${interactionId} не стоит ни на одной стадии`);
	}

	return row;
}

/**
 * Основная сторона записи: её и ждут, когда стадия на паузе. По признаку
 * `is_primary`, а не по роли участника, — у обучения лица роль другая, а ждут
 * всё равно контрагента.
 */
async function readPrimaryPartyId(db: Database, interactionId: string): Promise<string> {
	const [row] = await db
		.select({ id: interactionParties.id })
		.from(interactionParties)
		.where(
			and(
				eq(interactionParties.interactionId, interactionId),
				eq(interactionParties.isPrimary, true)
			)
		)
		.limit(1);

	if (row === undefined) {
		throw new Error(`У взаимодействия ${interactionId} нет основной стороны`);
	}

	return row.id;
}

/**
 * Собирает соглашение по шаблону. Недоступный Gotenberg не должен ронять
 * заливку: на машине без него стенд всё равно нужен — просто без документов.
 * Это единственное место набора, где ошибка не останавливает работу, и молчать
 * о ней нельзя.
 */
async function generateAgreement(ctx: ActorContext, interactionId: string): Promise<boolean> {
	const view = await getInteraction(ctx, interactionId);
	const institution = view.parties.find((party) => party.partyRole === 'educational_institution');
	const customer = view.parties.find((party) => party.partyRole === 'customer');
	const operator = view.parties.find((party) => party.partyRole === 'operator');

	if (
		institution === undefined ||
		customer === undefined ||
		operator === undefined ||
		view.agreementPeriodStart === null ||
		view.agreementPeriodEnd === null
	) {
		throw new Error(`Взаимодействию «${view.title}» не хватает данных для соглашения`);
	}

	try {
		await generateDocument(ctx, {
			templateKey: 'agreement',
			interactionId,
			title: `Соглашение — ${view.title}`,
			formats: ['docx', 'pdf'],
			data: {
				city: 'Москва',
				date: formatDate(new Date()),
				operatorName: operator.organizationName,
				operatorSigner: 'директора Орлова В. С.',
				institutionName: institution.organizationName,
				institutionSigner: 'ректора',
				customerName: customer.organizationName,
				periodStart: formatDate(view.agreementPeriodStart),
				periodEnd: formatDate(view.agreementPeriodEnd),
				programs: view.programs.map((program) => ({ name: program.name }))
			}
		});

		return true;
	} catch (error) {
		if (error instanceof DocumentConversionError) {
			console.log(
				`seed: соглашение для «${view.title}» не собрано — служба преобразования в PDF недоступна (${error.message})`
			);

			return false;
		}

		throw error;
	}
}

/**
 * Текстовый «скан» соглашения. Настоящий PDF набору не нужен: в хранилище
 * проверяется соответствие содержимого заявленному типу, и `text/plain` этой
 * проверке отвечает честнее, чем подделанный заголовок PDF.
 */
function scanBytes(revision: number): Uint8Array {
	return new TextEncoder().encode(
		`Соглашение о сотрудничестве. Редакция ${revision}.\n` +
			'Скан подписанного экземпляра, приложенный к взаимодействию.\n'
	);
}

/**
 * Скан и его вторая редакция: исправленный документ не затирает прежний файл, а
 * встаёт рядом со ссылкой на него. Без такой пары на стенде нечем показать ни
 * цепочку редакций, ни фильтр «только действующие».
 */
async function uploadScanWithRevision(ctx: ActorContext, interactionId: string): Promise<void> {
	const first = await uploadDocument(ctx, {
		interactionId,
		kind: 'agreement',
		title: 'Скан подписанного соглашения',
		file: { mime: 'text/plain', bytes: scanBytes(1) }
	});

	await uploadDocumentRevision(ctx, {
		supersedesId: first.id,
		file: { mime: 'text/plain', bytes: scanBytes(2) }
	});
}

/** Паузы, помехи, комментарии и отметки чек-листа текущей стадии. */
async function applyState(
	ctx: ActorContext,
	db: Database,
	seed: InteractionSeed,
	interactionId: string,
	process: Process
): Promise<boolean> {
	const entry = await readOpenEntry(db, interactionId);
	const stage = process.stages.find((candidate) => candidate.id === entry.stageId);

	if (stage === undefined) {
		throw new Error(`Стадия ${entry.stageId} не принадлежит действующему процессу`);
	}

	if (seed.closeChecklist === true) {
		for (const item of stage.checklist) {
			if (item.required) {
				await setChecklistItem(ctx, { interactionId, key: item.key, done: true });
			}
		}
	}

	if (seed.blocker !== undefined) {
		await raiseBlocker(ctx, {
			interactionId,
			reasonCode: seed.blocker.reasonCode,
			description: seed.blocker.description,
			blocksTransition: seed.blocker.blocksTransition,
			assigneeUserId: null
		});
	}

	for (const body of seed.comments ?? []) {
		await addComment(ctx, { interactionId, body });
	}

	let generated = false;

	if (seed.document === true) {
		generated = await generateAgreement(ctx, interactionId);
	}

	if (seed.scanWithRevision === true) {
		await uploadScanWithRevision(ctx, interactionId);
	}

	// Передача другому менеджеру: команда сама пишет строку в историю плана —
	// сдвиг работы обязан быть объясним рядом с полем, а не только в журнале.
	if (seed.handedTo !== undefined) {
		await setResponsible(ctx, {
			interactionIds: [interactionId],
			userId: seedId('user', seed.handedTo)
		});
	}

	// Пауза — последней: она останавливает часы стадии, и всё остальное по
	// взаимодействию делается до того, как работа встала.
	if (seed.pause !== undefined) {
		await pauseStage(ctx, {
			interactionId,
			fromStageId: entry.stageId,
			reason: 'waiting_counterparty',
			waitingPartyId: await readPrimaryPartyId(db, interactionId),
			nextAction: seed.pause.nextAction,
			note: seed.pause.note
		});
	}

	return generated;
}

/**
 * Раздвигает историю по времени.
 *
 * Движок ставит `now()` — и правильно делает: команду отдают сейчас. Но
 * демонстрации нужна запись, которая идёт третий месяц, а подмешивать «а на
 * самом деле это было в мае» в сами команды значит завести в движке параметр,
 * которым в работе никто никогда не воспользуется. Поэтому время правится
 * после: одной транзакцией, прямым UPDATE по уже написанной истории. Сроки,
 * паузы и просрочку пересчитает представление `stage_entry_status`.
 */
async function shiftTime(
	db: Database,
	seed: InteractionSeed,
	interactionId: string,
	runStart: Date
): Promise<void> {
	const entries = await db
		.select({ id: stageEntries.id, leftAt: stageEntries.leftAt })
		.from(stageEntries)
		.where(eq(stageEntries.interactionId, interactionId))
		.orderBy(asc(stageEntries.enteredAt));

	const openEntry = entries.at(-1)?.leftAt === null ? entries.at(-1) : undefined;

	if (entries.length === 1 && seed.startedDaysAgo !== seed.sinceDaysAgo) {
		throw new Error(
			`Взаимодействие «${seed.key}» стоит на первой стадии: startedDaysAgo и sinceDaysAgo обязаны совпадать`
		);
	}

	const start = daysBefore(runStart, seed.startedDaysAgo);
	const end = daysBefore(runStart, seed.sinceDaysAgo);
	// У открытой записи последний отрезок ещё идёт, поэтому промежуток делят
	// закрытые записи; у закрытой истории — все.
	const step =
		(end.getTime() - start.getTime()) /
		Math.max(openEntry === undefined ? entries.length : entries.length - 1, 1);

	await db.transaction(async (tx: Tx) => {
		for (const [index, entry] of entries.entries()) {
			await tx
				.update(stageEntries)
				.set({
					enteredAt: new Date(start.getTime() + step * index),
					leftAt: entry.leftAt === null ? null : new Date(start.getTime() + step * (index + 1))
				})
				.where(eq(stageEntries.id, entry.id));
		}

		// Пауза, помеха и комментарии появились не в момент входа на последнюю
		// стадию: сначала работали, потом упёрлись в ожидание. И не в одну
		// секунду: события, слипшиеся в одну отметку времени, читаются как сбой
		// системы, а не как ход работы, — поэтому каждое получает свой момент.
		const lastEnteredAt = new Date(start.getTime() + step * (entries.length - 1));
		const lastWindowEnd = openEntry === undefined ? end : runStart;
		const span = lastWindowEnd.getTime() - lastEnteredAt.getTime();
		// Работа укладывается в первую треть стадии: дальше по этому же отрезку
		// стоит пауза, и её начало двигать нельзя — из него считается,
		// сколько часы стадии простояли, а значит и просрочка.
		const moment = (index: number, total: number): Date =>
			new Date(lastEnteredAt.getTime() + span * (0.05 + (0.3 * index) / Math.max(total, 1)));

		// Порядок тот же, в каком набор их заводил: помеха, разговор, передача.
		const commentRows = await tx
			.select({ id: comments.id })
			.from(comments)
			.where(eq(comments.interactionId, interactionId))
			.orderBy(asc(comments.createdAt));
		const changeRows = await tx
			.select({ id: interactionChanges.id })
			.from(interactionChanges)
			.where(eq(interactionChanges.interactionId, interactionId))
			.orderBy(asc(interactionChanges.changedAt));

		const total = 1 + commentRows.length + changeRows.length;

		await tx
			.update(blockers)
			.set({ raisedAt: moment(0, total) })
			.where(eq(blockers.interactionId, interactionId));

		for (const [index, comment] of commentRows.entries()) {
			const at = moment(index + 1, total);

			await tx
				.update(comments)
				.set({ createdAt: at, updatedAt: at })
				.where(eq(comments.id, comment.id));
		}

		for (const [index, change] of changeRows.entries()) {
			await tx
				.update(interactionChanges)
				.set({ changedAt: moment(commentRows.length + index + 1, total) })
				.where(eq(interactionChanges.id, change.id));
		}

		// Пауза — после работы: сначала делали, потом упёрлись в ожидание.
		if (openEntry !== undefined) {
			await tx
				.update(stagePauses)
				.set({ startedAt: new Date(lastEnteredAt.getTime() + span * 0.4) })
				.where(and(eq(stagePauses.stageEntryId, openEntry.id), isNull(stagePauses.endedAt)));
		}

		await tx
			.update(interactions)
			.set({
				createdAt: start,
				lastActivityAt: daysBefore(runStart, seed.lastActivityDaysAgo),
				updatedAt: daysBefore(runStart, seed.lastActivityDaysAgo)
			})
			.where(eq(interactions.id, interactionId));
	});
}

/** Идентификаторы взаимодействий набора, которые в базе уже есть. */
async function readExisting(db: Database, ids: string[]): Promise<Set<string>> {
	const rows = await db
		.select({ id: interactions.id })
		.from(interactions)
		.where(inArray(interactions.id, ids));

	return new Set(rows.map((row) => row.id));
}

/**
 * Заливает взаимодействия. Повторный запуск не трогает уже заведённые: их
 * историю нельзя «досоздать», а переписать её заново значило бы стереть работу,
 * проделанную на стенде руками.
 */
export async function seedInteractions(): Promise<void> {
	const db = getDb();

	// Оба пространства разом: набор ведёт и работу с вузами, и обучение
	// физических и юридических лиц, а по какому процессу идёт запись, говорит
	// вид её контрагента — тем же правилом, что и у команды создания.
	const plans = new Map<
		string,
		{ workspace: Awaited<ReturnType<typeof readWorkspaceByKey>>; plan: Process }
	>();

	for (const workspaceKey of [B2B_WORKSPACE_KEY, B2C_WORKSPACE_KEY]) {
		const workspace = await readWorkspaceByKey(db, workspaceKey);
		const revision = await requireActiveRevisionForWorkspace(db, workspace.id);

		plans.set(workspaceKey, {
			workspace,
			plan: {
				stages: [...revision.stages].sort((left, right) => left.position - right.position),
				forward: new Map(
					revision.transitions
						.filter((transition) => transition.kind === 'forward')
						.map((transition) => [transition.fromStageId, transition.toStageId])
				),
				revision: revision.version,
				revisionView: revision
			}
		});
	}

	const [owners, service, versions, existing] = await Promise.all([
		readOwners(db),
		readService(db),
		readLatestProgramVersions(db),
		readExisting(
			db,
			ALL_INTERACTIONS.map((seed) => seedId('interaction', seed.key))
		)
	]);

	// Экземпляр подключения к системе обучения: поток набора заведён в том же,
	// куда ходит обмен, — иначе результат оттуда встал бы рядом со своим.
	const lmsInstance = (await getExchangeSettings()).lms.instance;
	// Тот же экземпляр — источник дел, отмеченных заявкой с сайта.
	const cmsInstance = (await getExchangeSettings()).cms.instance;

	// Одна точка отсчёта на всю заливку: два вызова `new Date()` расходятся на
	// миллисекунды, а смещения записей считаются друг относительно друга.
	const runStart = new Date();
	let created = 0;
	let documents = 0;

	for (const seed of ALL_INTERACTIONS) {
		const id = seedId('interaction', seed.key);

		if (existing.has(id)) {
			continue;
		}

		const ctx = owners.get(seed.owner);

		if (ctx === undefined) {
			throw new Error(`Учётная запись «${seed.owner}» не заведена`);
		}

		const workspaceKey = workspaceKeyOf(seed);
		const process = plans.get(workspaceKey);

		if (process === undefined) {
			throw new Error(`Пространство «${workspaceKey}» не заведено`);
		}

		const { workspace, plan } = process;
		const stages = plan.stages;
		const input = toCreateInput(seed, versions, cmsInstance);

		if (
			!(await createSeededInteraction(
				ctx,
				db,
				id,
				input,
				{ ...workspace, revision: plan.revisionView },
				seed.externalApplication === undefined ? null : (seed.externalApplication.revision ?? 1)
			))
		) {
			continue;
		}

		const provideLmsEvidence = () => recordLearningResult(service, seed, id, lmsInstance, runStart);

		await walkTo(ctx, id, plan, seed.stage, provideLmsEvidence);

		// Стадия, на которой взаимодействие остановилось, тоже бывает с данными
		// обучения: её никто не закрывает, но подтверждённой она обязана быть —
		// факт из системы обучения приходит по её расписанию, а не по нашему.
		if (stageByKey(stages, seed.stage).requiresLmsData) {
			await provideLmsEvidence();
		}

		// С отметкой по документу иначе: дело, стоящее на подписании, показывает
		// либо подтверждённую стадию, либо требование, которое ещё не выполнено, —
		// и стенду нужны оба состояния.
		const markOnStage = stageByKey(stages, seed.stage).requiresDocumentMark;

		if (markOnStage !== null && seed.signedDocument === true) {
			await recordSignedAgreement(ctx, id, markOnStage);
		}

		if (seed.returnedFrom !== undefined) {
			const from = stageByKey(stages, seed.stage);
			const to = stageByKey(stages, seed.returnedFrom);

			await stepForward(ctx, id, from, to.id, plan.revision, provideLmsEvidence);
			await returnStage(ctx, {
				interactionId: id,
				fromStageId: to.id,
				toStageId: from.id,
				revision: plan.revision,
				reason: 'В пакете документов не хватало приложения со списком дисциплин'
			});
		}

		if (await applyState(ctx, db, seed, id, plan)) {
			documents += 1;
		}

		if (seed.completedWith !== undefined) {
			await closeFinalStage(ctx, id, stageByKey(stages, seed.stage));

			await completeInteraction(ctx, {
				interactionId: id,
				revision: plan.revision,
				summary: seed.completedWith,
				force: false
			});
		}

		// Отмена не требует финальной стадии: дело останавливают там, где до него
		// дошли, — в отличие от завершения, чек-лист и результат текущей стадии
		// закрывать не нужно.
		if (seed.cancelledWith !== undefined) {
			await cancelInteraction(ctx, {
				interactionId: id,
				revision: plan.revision,
				reason: seed.cancelledWith
			});
		}

		await shiftTime(db, seed, id, runStart);
		created += 1;
	}

	console.log(
		created === 0
			? 'seed: взаимодействия уже залиты — история не пересоздаётся'
			: `seed: взаимодействий заведено ${created}, документов собрано ${documents}`
	);
}
