/**
 * Взаимодействия демонстрационного стенда: тридцать записей на разных стадиях
 * маршрута, с историей, паузами, помехами, комментариями и документами.
 *
 * Историю пишет сам движок стадий: набор зовёт те же команды, что и карточка
 * (`advanceStage`, `confirmStage`, `pauseStage`, …). Разложить записи стадий
 * прямо в таблицу было бы вдвое короче и вдвое хуже: слепки стадий, отметки
 * чек-листа, закрытие пауз и записи журнала — это правила движка, и вторая их
 * реализация в сиде однажды разойдётся с первой. Поэтому набор не пишет в
 * `stage_entries` ничего, кроме времени: движок ставит `now()`, а
 * демонстрации нужна запись, которая идёт третий месяц.
 *
 * Данные полностью выдуманы — см. `directory.ts`: организации, люди, программы
 * и продукты берутся оттуда по тем же ключам.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
	createInteractionSchema,
	type CreateInteractionInput,
	type StageView
} from '$lib/contracts/interactions';
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
	programVersions,
	stageEntries,
	stagePauses,
	users
} from '$lib/server/db/schema';
import type { Tx } from '$lib/server/db/transaction';
import { DocumentConversionError } from '$lib/server/documents/errors';
import { generateDocument } from '$lib/server/documents/generate';
import { getInteraction } from '$lib/server/interactions/read';
import { defaultRolePermissions } from '$lib/server/rbac/seed';
import {
	addComment,
	advanceStage,
	completeInteraction,
	confirmStage,
	pauseStage,
	raiseBlocker,
	returnStage,
	setChecklistItem,
	setResponsible,
	startInteractionIn
} from '$lib/server/stages/commands';
import { DEMO_ROUTE } from '$lib/server/stages/demo-route';
import { readRoute } from '$lib/server/stages/routes';
import { seedId } from './ids';

/** Ключи учётных записей, на которых ведутся демонстрационные взаимодействия. */
const OWNER_KEYS = ['demo-manager', 'veresova', 'zotov'] as const;

type OwnerKey = (typeof OWNER_KEYS)[number];

type PauseSeed = { note: string; nextAction: string };

type BlockerSeed = { reasonCode: string; description: string; blocksTransition: boolean };

type InteractionSeed = {
	key: string;
	title: string;
	/** Ключи из `directory.ts`: учебное заведение, его контакт и площадки. */
	institution: string;
	contact: string;
	sites?: readonly string[];
	/** Компания-заказчик подготовки. */
	customer: string;
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
	agreement?: readonly [string, string];
	academic?: readonly [string, string];
	/** Закрыть обязательные пункты чек-листа текущей стадии. */
	closeChecklist?: boolean;
	pause?: PauseSeed;
	blocker?: BlockerSeed;
	comments?: readonly string[];
	/** Собрать соглашение по шаблону — нужен доступный Gotenberg. */
	document?: boolean;
	/** Стадия, на которую сходили и вернулись назад: след в истории. */
	returnedFrom?: string;
	/** Кому передали взаимодействие: смена ответственного попадает в историю плана. */
	handedTo?: OwnerKey;
	/** Итог: заполнен у завершённых, маршрут при этом пройден целиком. */
	completedWith?: string;
};

/**
 * Тридцать взаимодействий. Больше всего их на ранних стадиях и на
 * исполнительских: так выглядит живая воронка — контактов много, до занятий
 * доходят единицы.
 */
const INTERACTIONS: readonly InteractionSeed[] = [
	{
		key: 'szpu-vo',
		title: 'СЗПУ: подготовка по прикладной информатике, 2026/2027',
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
		key: 'lyceum1812-school',
		title: 'Лицей № 1812: основы программирования для старших классов',
		institution: 'lyceum1812',
		contact: 'morozov',
		customer: 'polarcode',
		programs: ['school-01'],
		owner: 'veresova',
		stage: 'contact_search',
		startedDaysAgo: 6,
		sinceDaysAgo: 6,
		lastActivityDaysAgo: 2
	},
	{
		key: 'vts-spo',
		title: 'ВТС: сетевое администрирование для отделения связи',
		institution: 'vts',
		contact: 'karpov',
		customer: 'technosphere',
		programs: ['spo-02'],
		owner: 'zotov',
		stage: 'contact_search',
		startedDaysAgo: 4,
		sinceDaysAgo: 4,
		lastActivityDaysAgo: 1
	},
	{
		key: 'paid-praktiki',
		title: 'ПАИД: практики и стажировки на программах бакалавриата',
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
		closeChecklist: true
	},
	{
		key: 'pupi-ai',
		title: 'ПУПИ: магистратура по инженерии данных',
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
		pause: {
			note: 'Ждём от вуза перечень дисциплин, которые готовы отдать под программу',
			nextAction: 'Созвон с координатором после учёного совета'
		}
	},
	{
		key: 'nkis-set',
		title: 'НКИС: сетевое и системное администрирование, набор 2026',
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
		comments: [
			'Колледж просит начать с одной группы и расширяться со второго семестра.',
			'Отправили описание программ и требования к учебной среде.'
		]
	},
	{
		key: 'school47-start',
		title: 'Школа № 47 «Вектор»: кружок программирования',
		institution: 'school47',
		contact: 'novikova',
		customer: 'polarcode',
		programs: ['school-01'],
		owner: 'demo-manager',
		stage: 'communication',
		startedDaysAgo: 11,
		sinceDaysAgo: 6,
		lastActivityDaysAgo: 5,
		closeChecklist: true
	},
	{
		key: 'uguis-avtomat',
		title: 'УГУИС: автоматизация производств, совместная лаборатория',
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
		title: 'СКПА: информационные системы и программирование',
		institution: 'skpa',
		contact: 'lebedeva',
		customer: 'technosphere',
		programs: ['spo-01'],
		owner: 'zotov',
		stage: 'meeting',
		startedDaysAgo: 25,
		sinceDaysAgo: 10,
		lastActivityDaysAgo: 9,
		returnedFrom: 'document_exchange'
	},
	{
		key: 'sruit-dpo',
		title: 'СУИТ: повышение квалификации преподавателей',
		institution: 'sruit',
		contact: 'shilov',
		customer: 'digital',
		programs: ['dpo-01'],
		owner: 'demo-manager',
		stage: 'meeting',
		startedDaysAgo: 22,
		sinceDaysAgo: 7,
		lastActivityDaysAgo: 2,
		closeChecklist: true
	},
	{
		key: 'vkgtu-svyaz',
		title: 'ВКГТУ: системы связи, пакет документов на 2026/2027',
		institution: 'vkgtu',
		contact: 'khabibullina',
		sites: ['vkgtu-dept-comm'],
		customer: 'meridian',
		programs: ['vo-bak-02', 'vo-mag-02'],
		products: ['lab', 'cloud'],
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
		title: 'УКЦТ: программирование для колледжа, договор на год',
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
		title: 'ЮТУС: информационные системы и технологии связи',
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
			reasonCode: 'legal-review',
			description: 'Юристы вуза просят изменить раздел об интеллектуальной собственности',
			blocksTransition: false
		},
		comments: ['Замечание по разделу 7 согласовали устно, ждём правку от вуза.']
	},
	{
		key: 'batse-econom',
		title: 'БАЦЭ: цифровая экономика, корректировка пакета документов',
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
		title: 'СИВТ: магистратура по инженерии данных, подписание',
		institution: 'sivt',
		contact: 'orekhova',
		sites: ['sivt-main'],
		customer: 'digital',
		programs: ['vo-mag-01'],
		products: ['cloud'],
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
		title: 'БИТ: телекоммуникации, соглашение о сотрудничестве',
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
		comments: ['Подписанты подтверждены с обеих сторон, скан ждём до пятницы.']
	},
	{
		key: 'puts-telecom',
		title: 'ПУТС: передача материалов и лицензий на учебный год',
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
		title: 'ПУПИ: бакалавриат по прикладной информатике, комплект материалов',
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
		title: 'СЗПУ: сопровождение внедрения учебной платформы',
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
		title: 'УГУИС: внедрение тренажёра сетевых лабораторий',
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
		title: 'ВКГТУ: обучение преподавателей промышленной разработке',
		institution: 'vkgtu',
		contact: 'tsvetkov',
		customer: 'ladoga',
		programs: ['dpo-01'],
		products: ['lms'],
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
		title: 'СИВТ: повышение квалификации преподавательского состава',
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
		title: 'ЮТУС: актуализация программы под требования заказчика',
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
		academic: ['2026-02-01', '2026-06-30']
	},
	{
		key: 'batse-kontrol',
		title: 'БАЦЭ: контроль исполнения обязательств за учебный год',
		institution: 'batse',
		contact: 'tarasyuk',
		customer: 'irbis',
		programs: ['dpo-01'],
		owner: 'demo-manager',
		stage: 'execution_control',
		startedDaysAgo: 200,
		sinceDaysAgo: 12,
		lastActivityDaysAgo: 7,
		agreement: ['2025-09-01', '2026-08-31']
	},
	{
		key: 'szpu-2025',
		title: 'СЗПУ: прикладная информатика, 2025/2026',
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
		completedWith:
			'Программа прочитана полностью, 48 студентов получили документы об обучении, отчёт принят заказчиком.'
	},
	{
		key: 'pupi-2025',
		title: 'ПУПИ: инженерия данных, 2025/2026',
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
		completedWith:
			'Магистерская программа закрыта, семь выпускников вышли на стажировку к заказчику.'
	},
	{
		key: 'nkis-2025',
		title: 'НКИС: системное администрирование, 2025/2026',
		institution: 'nkis',
		contact: 'ilyin',
		sites: ['nkis-lab'],
		customer: 'ladoga',
		programs: ['spo-02'],
		products: ['cloud'],
		owner: 'demo-manager',
		stage: 'execution_control',
		startedDaysAgo: 280,
		sinceDaysAgo: 28,
		lastActivityDaysAgo: 28,
		agreement: ['2025-09-01', '2026-06-30'],
		completedWith: 'Две группы завершили обучение, лаборатория передана колледжу на баланс.'
	},
	{
		key: 'puts-2025',
		title: 'ПУТС: телекоммуникации, 2025/2026',
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
		completedWith: 'Занятия проведены, плановые показатели по набору выполнены на 112 %.'
	},
	{
		key: 'sruit-2025',
		title: 'СУИТ: переподготовка преподавателей, 2025/2026',
		institution: 'sruit',
		contact: 'chernysheva',
		customer: 'polarcode',
		programs: ['dpo-01'],
		products: ['assistant'],
		owner: 'zotov',
		stage: 'execution_control',
		startedDaysAgo: 250,
		sinceDaysAgo: 5,
		lastActivityDaysAgo: 5,
		agreement: ['2025-09-01', '2026-08-31'],
		completedWith: 'Повышение квалификации прошли 24 преподавателя, документы выданы.'
	}
];

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
	qualification_upgrade: 'Участники прошли повышение квалификации, документы выданы.'
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBefore(base: Date, days: number): Date {
	return new Date(base.getTime() - days * DAY_MS);
}

/** Стадия маршрута по ключу конфигурации. */
function stageByKey(stages: readonly StageView[], key: string): StageView {
	const stage = stages.find((candidate) => candidate.key === key);

	if (stage === undefined) {
		throw new Error(`В маршруте нет стадии «${key}»`);
	}

	return stage;
}

/** Просрочка — следствие данных набора, а не отдельный флаг: часы считает база. */
function isOverdueSeed(seed: InteractionSeed): boolean {
	if (seed.completedWith !== undefined || seed.pause !== undefined) {
		return false;
	}

	const stage = DEMO_ROUTE.stages.find((candidate) => candidate.key === seed.stage);

	if (stage === undefined) {
		throw new Error(`В демонстрационном маршруте нет стадии «${seed.stage}»`);
	}

	return seed.sinceDaysAgo > stage.slaDays;
}

/**
 * Сколько чего описано в наборе. Тест сверяет с этим то, что оказалось в базе:
 * расхождение означает, что движок или представление со сроком ведут себя не
 * так, как задумано в демонстрации.
 */
export const INTERACTION_SEED_SIZES = {
	interactions: INTERACTIONS.length,
	completed: INTERACTIONS.filter((seed) => seed.completedWith !== undefined).length,
	overdue: INTERACTIONS.filter(isOverdueSeed).length,
	paused: INTERACTIONS.filter((seed) => seed.pause !== undefined).length,
	blockers: INTERACTIONS.filter((seed) => seed.blocker !== undefined).length,
	comments: INTERACTIONS.reduce((total, seed) => total + (seed.comments?.length ?? 0), 0),
	documents: INTERACTIONS.filter((seed) => seed.document === true).length,
	handovers: INTERACTIONS.filter((seed) => seed.handedTo !== undefined).length
} as const;

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

function toCreateInput(
	seed: InteractionSeed,
	routeId: string,
	versions: Map<string, string>
): CreateInteractionInput {
	const raw = {
		title: seed.title,
		routeId,
		agreementPeriodStart: seed.agreement?.[0] ?? null,
		agreementPeriodEnd: seed.agreement?.[1] ?? null,
		academicPeriodStart: seed.academic?.[0] ?? null,
		academicPeriodEnd: seed.academic?.[1] ?? null,
		ownerUserId: seedId('user', seed.owner),
		parties: [
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
			{
				organizationId: seedId('organization', 'operator'),
				partyRole: 'operator',
				isPrimary: false,
				contactAffiliationId: seedId('affiliation', 'orlov-primary'),
				siteIds: []
			}
		],
		programs: seed.programs.map((program) => {
			const programId = seedId('program', program);

			return { programId, programVersionId: versions.get(programId) ?? null };
		}),
		productIds: (seed.products ?? []).map((product) => seedId('product', product)),
		externalSource: null,
		externalId: null
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
	input: CreateInteractionInput
): Promise<boolean> {
	return db.transaction(async (tx: Tx) => {
		const created = await tx
			.insert(interactions)
			.values({
				id,
				title: input.title,
				routeId: input.routeId,
				agreementPeriodStart: input.agreementPeriodStart,
				agreementPeriodEnd: input.agreementPeriodEnd,
				academicPeriodStart: input.academicPeriodStart,
				academicPeriodEnd: input.academicPeriodEnd,
				ownerUserId: input.ownerUserId
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
				details: { routeId: input.routeId }
			},
			tx
		);

		await startInteractionIn(ctx, tx, {
			id,
			routeId: input.routeId,
			ownerUserId: input.ownerUserId
		});

		return true;
	});
}

/** Один шаг вперёд со всем, чего стадия требует перед выходом. */
async function stepForward(
	ctx: ActorContext,
	interactionId: string,
	from: StageView,
	toStageId: string
): Promise<void> {
	if (from.requiresConfirmation) {
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
		resultText: from.requiresResult ? (STAGE_RESULTS[from.key] ?? null) : null,
		// Отметки чек-листа едут вместе с переходом: «закрыть последний пункт и
		// сразу перейти» — законная операция движка, а не два круга.
		checklistState: Object.fromEntries(
			from.checklist.filter((item) => item.required).map((item) => [item.key, true])
		)
	});
}

type Route = {
	stages: StageView[];
	/** Куда ведёт шаг вперёд с этой стадии. */
	forward: Map<string, string>;
};

/** Проводит взаимодействие по маршруту до нужной стадии. */
async function walkTo(
	ctx: ActorContext,
	interactionId: string,
	route: Route,
	targetKey: string
): Promise<void> {
	const target = stageByKey(route.stages, targetKey);

	for (const stage of route.stages) {
		if (stage.position >= target.position) {
			break;
		}

		const next = route.forward.get(stage.id);

		if (next === undefined) {
			throw new Error(`Со стадии «${stage.key}» нет шага вперёд`);
		}

		await stepForward(ctx, interactionId, stage, next);
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

/** Участник-учебное заведение: его и ждут, когда стадия на паузе. */
async function readInstitutionPartyId(db: Database, interactionId: string): Promise<string> {
	const [row] = await db
		.select({ id: interactionParties.id })
		.from(interactionParties)
		.where(
			and(
				eq(interactionParties.interactionId, interactionId),
				eq(interactionParties.partyRole, 'educational_institution')
			)
		)
		.limit(1);

	if (row === undefined) {
		throw new Error(`У взаимодействия ${interactionId} нет участника — учебного заведения`);
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

/** Паузы, помехи, комментарии и отметки чек-листа текущей стадии. */
async function applyState(
	ctx: ActorContext,
	db: Database,
	seed: InteractionSeed,
	interactionId: string,
	route: Route
): Promise<boolean> {
	const entry = await readOpenEntry(db, interactionId);
	const stage = route.stages.find((candidate) => candidate.id === entry.stageId);

	if (stage === undefined) {
		throw new Error(`Стадия ${entry.stageId} не принадлежит маршруту`);
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
			waitingPartyId: await readInstitutionPartyId(db, interactionId),
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
		// стадию: сначала работали, потом упёрлись в ожидание.
		const lastEnteredAt = new Date(start.getTime() + step * (entries.length - 1));
		const lastWindowEnd = openEntry === undefined ? end : runStart;
		const happenedAt = new Date(
			lastEnteredAt.getTime() + (lastWindowEnd.getTime() - lastEnteredAt.getTime()) * 0.4
		);

		if (openEntry !== undefined) {
			await tx
				.update(stagePauses)
				.set({ startedAt: happenedAt })
				.where(and(eq(stagePauses.stageEntryId, openEntry.id), isNull(stagePauses.endedAt)));
		}

		await tx
			.update(blockers)
			.set({ raisedAt: happenedAt })
			.where(eq(blockers.interactionId, interactionId));

		await tx
			.update(comments)
			.set({ createdAt: happenedAt, updatedAt: happenedAt })
			.where(eq(comments.interactionId, interactionId));

		await tx
			.update(interactionChanges)
			.set({ changedAt: happenedAt })
			.where(eq(interactionChanges.interactionId, interactionId));

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
export async function seedInteractions(options: { routeId: string }): Promise<void> {
	const db = getDb();
	const route = await readRoute(db, options.routeId);
	const stages = [...route.stages].sort((left, right) => left.position - right.position);

	const plan: Route = {
		stages,
		forward: new Map(
			route.transitions
				.filter((transition) => transition.kind === 'forward')
				.map((transition) => [transition.fromStageId, transition.toStageId])
		)
	};

	const [owners, versions, existing] = await Promise.all([
		readOwners(db),
		readLatestProgramVersions(db),
		readExisting(
			db,
			INTERACTIONS.map((seed) => seedId('interaction', seed.key))
		)
	]);

	// Одна точка отсчёта на всю заливку: два вызова `new Date()` расходятся на
	// миллисекунды, а смещения записей считаются друг относительно друга.
	const runStart = new Date();
	let created = 0;
	let documents = 0;

	for (const seed of INTERACTIONS) {
		const id = seedId('interaction', seed.key);

		if (existing.has(id)) {
			continue;
		}

		const ctx = owners.get(seed.owner);

		if (ctx === undefined) {
			throw new Error(`Учётная запись «${seed.owner}» не заведена`);
		}

		const input = toCreateInput(seed, options.routeId, versions);

		if (!(await createSeededInteraction(ctx, db, id, input))) {
			continue;
		}

		await walkTo(ctx, id, plan, seed.stage);

		if (seed.returnedFrom !== undefined) {
			const from = stageByKey(stages, seed.stage);
			const to = stageByKey(stages, seed.returnedFrom);

			await stepForward(ctx, id, from, to.id);
			await returnStage(ctx, {
				interactionId: id,
				fromStageId: to.id,
				toStageId: from.id,
				reason: 'В пакете документов не хватало приложения со списком дисциплин'
			});
		}

		if (await applyState(ctx, db, seed, id, plan)) {
			documents += 1;
		}

		if (seed.completedWith !== undefined) {
			await completeInteraction(ctx, {
				interactionId: id,
				summary: seed.completedWith,
				force: false
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
