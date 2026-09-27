/**
 * Взаимодействие с учебным заведением — центральная сущность процесса — и
 * команды, которыми его двигают по стадиям.
 *
 * Процесс принадлежит группе контрагентов, и в группе действует ровно одна
 * редакция структуры: стадии с параметрами и переходы между ними. Номер
 * редакции — внутреннее понятие; взаимодействие ссылается на группу, а не на
 * редакцию, и изменение процесса применяется ко всем сразу. Текущая стадия —
 * это открытая запись `stage_entries`, отдельного поля-кэша нет.
 */
import { z } from 'zod';
import {
	id,
	optionalId,
	optionalIsoDate,
	optionalText,
	pageQuerySchema,
	requiredText,
	searchQuery
} from './common';
import {
	DOCUMENT_STATUS_FACTS,
	DOCUMENT_TEMPLATE_KEYS,
	type DocumentMarkEvidence,
	type DocumentStatusFact,
	type DocumentTemplateKey
} from './documents';
import type { ApplicationStatus, LearningPurpose } from './exchange';
import { MY_DAY_INTERACTION_KINDS } from './my-day';
import type { ConsentBasis, PersonView } from './directory';
import { CHECKLIST_ACTION_KEYS } from '$lib/platform/checklist';
import { CHECKLIST_RULE_KEYS, type ChecklistRuleKey } from '$lib/platform/checklist-rules';

/** Смысловая группа стадии; по ней раскрашивают ленту и считают сводки. */
export const STAGE_CATEGORIES = [
	'contact',
	'documents',
	'delivery',
	'implementation',
	'training',
	'teaching',
	'update',
	'control'
] as const;
/**
 * Кого уведомить, когда дело входит на стадию: ответственного за дело или его
 * руководителя. Настраивает администратор в редакторе процесса; `null` у стадии
 * — не уведомлять никого. Публикация процесса, переносящая записи на новую
 * структуру, уведомления не даёт: дело туда перенёс администратор, а не работа.
 */
export const STAGE_ENTER_NOTIFY_TARGETS = ['responsible', 'manager'] as const;

export type StageEnterNotifyTarget = (typeof STAGE_ENTER_NOTIFY_TARGETS)[number];

export const STAGE_ENTER_NOTIFY_LABELS: Record<StageEnterNotifyTarget, string> = {
	responsible: 'Ответственного',
	manager: 'Руководителя ответственного'
};

/** Куда ведёт переход: вперёд по маршруту, назад на доработку, мимо стадии. */
export const STAGE_TRANSITION_KINDS = ['forward', 'return', 'skip'] as const;
/** Состояние взаимодействия целиком. */
export const INTERACTION_STATUSES = ['active', 'completed', 'cancelled'] as const;
/** Кем организация участвует в конкретном взаимодействии. */
export const PARTY_ROLES = ['educational_institution', 'customer', 'operator'] as const;
/**
 * Чем закончилось пребывание на стадии. Исход `migrated` ставит не человек, а
 * публикация изменённого процесса: запись закрыта переносом, а не работой, и
 * движением по воронке она не считается.
 */
export const STAGE_OUTCOMES = ['completed', 'returned', 'skipped', 'migrated'] as const;
/** Состояние договора: черновик, действует, закрыт. */
export const CONTRACT_STATUSES = ['draft', 'active', 'closed'] as const;
/** Почему часы на стадии остановлены. */
export const PAUSE_REASONS = ['waiting_counterparty', 'waiting_internal', 'other'] as const;
/**
 * Откуда взялся текст комментария.
 *
 * Различие нужно уничтожению персональных данных, а не экрану. `manual` — текст
 * сотрудника: его никто не переписывает, это содержание работы. Комментарий
 * заявки (`application_intake`) — свободный текст, который человек написал о
 * себе сам в форме на сайте, вместе с фамилией и телефоном внутри; при
 * обезличивании контрагента-физлица он заменяется пометкой, потому что искать в
 * нём ФИО подстрокой значило бы однажды испортить чужой текст и всё равно
 * оставить контакты.
 */
export const COMMENT_SOURCES = ['manual', 'application_intake'] as const;

/**
 * Кто сдвинул версию правки записи: сотрудник, сайт заказчика (заявка
 * дополнила состав) или система (обезличивание, ключ без пользователя). Нужен
 * отказу «запись изменил …»: у правки из обмена автора-человека нет, и назвать
 * её именем сотрудника, от чьего лица принята заявка, значило бы солгать.
 */
export const EDIT_SOURCES = ['user', 'site', 'system'] as const;

/**
 * Причины помех.
 *
 * Справочник, а не свободная строка: вопрос «на чём чаще всего встаёт работа с
 * вузами» — половина ценности воронки, а по рукописным `no-contact`, «нет
 * контакта» и `budget` он не считается. Код латиницей едет в
 * `blockers.reason_code` и в журнал, на экран выходит название.
 */
export const BLOCKER_REASONS = [
	'no-contact',
	'no-answer',
	'waiting-legal',
	'waiting-decision',
	'documents',
	'budget',
	'no-room',
	'schedule',
	'other'
] as const;

export type StageCategory = (typeof STAGE_CATEGORIES)[number];
export type StageTransitionKind = (typeof STAGE_TRANSITION_KINDS)[number];
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];
export type PartyRole = (typeof PARTY_ROLES)[number];
export type StageOutcome = (typeof STAGE_OUTCOMES)[number];
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export type PauseReason = (typeof PAUSE_REASONS)[number];
export type CommentSource = (typeof COMMENT_SOURCES)[number];
export type EditSource = (typeof EDIT_SOURCES)[number];
export type BlockerReason = (typeof BLOCKER_REASONS)[number];

/**
 * Кем организация участвует — словами, и словами теми же, что в справочнике
 * организаций (`ORGANIZATION_KIND_LABELS`).
 *
 * Единственное место, где роль стороны называется по-русски. Пока названий было
 * три — «Заказчик» в колонке списка, «Заказчик подготовки» в форме,
 * «Компания-заказчик» в справочнике, — на демонстрации это читалось как три
 * разные сущности процесса.
 */
export const PARTY_ROLE_LABELS: Record<PartyRole, string> = {
	educational_institution: 'Учебное заведение',
	customer: 'Компания-заказчик',
	operator: 'Оператор'
};

/**
 * Состояние договора — словами. Названия одни и те же на карточке вуза, в
 * карточке взаимодействия и в списке договоров API: состояние едет в базу
 * кодом, а на экран выходит названием.
 */
export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
	draft: 'Черновик',
	active: 'Действует',
	closed: 'Закрыт'
};

/** Почему часы стадии остановлены — словами. */
export const PAUSE_REASON_LABELS: Record<PauseReason, string> = {
	waiting_counterparty: 'Ждём ответа контрагента',
	waiting_internal: 'Ждём коллег внутри',
	other: 'Другая причина'
};

export const BLOCKER_REASON_LABELS: Record<BlockerReason, string> = {
	'no-contact': 'Нет выхода на ответственное лицо',
	'no-answer': 'Не отвечают на запрос',
	'waiting-legal': 'Ждём юридическую службу',
	'waiting-decision': 'Ждём решения руководства',
	documents: 'Не хватает документов',
	budget: 'Нет финансирования',
	'no-room': 'Нет помещения или оборудования',
	schedule: 'Не согласован график',
	other: 'Другая причина'
};

/**
 * Название причины для показа. Код не из справочника печатается как записан:
 * придумывать название за того, кто завёл помеху, значит показывать не то, что
 * лежит в базе.
 */
export function blockerReasonLabel(reasonCode: string): string {
	return reasonCode in BLOCKER_REASON_LABELS
		? BLOCKER_REASON_LABELS[reasonCode as BlockerReason]
		: reasonCode;
}

/**
 * Чем закрывается пункт: отметкой человека или фактом из данных дела по
 * правилу закрытого каталога (`$lib/platform/checklist`). Факт галочкой не
 * заменяется — ни из карточки, ни в команде перехода.
 */
export const checklistCompletionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('manual') }),
	z.object({
		kind: z.literal('fact'),
		rule: z.enum(CHECKLIST_RULE_KEYS, { error: 'Такого правила проверки пункта нет' })
	})
]);

export type ChecklistCompletion = z.output<typeof checklistCompletionSchema>;

/**
 * Пункт чек-листа стадии. `key` стабилен, по нему хранится отметка.
 *
 * `help`, `completion` и `action` необязательны: пункты, описанные до них,
 * лежат в базе без этих полей, и отсутствие означает прежнее — ручную отметку
 * без пояснения и без кнопки. Пустое пояснение из формы — то же отсутствие.
 */
export const checklistItemSchema = z.object({
	key: requiredText(100, 'У пункта чек-листа должен быть ключ'),
	label: requiredText(300, 'У пункта чек-листа должно быть название'),
	required: z.boolean().default(false),
	/** Что значит сделать пункт — словами для того, кто ведёт дело. */
	help: z
		.string()
		.trim()
		.max(500, { error: 'Пояснение к пункту — не длиннее 500 символов' })
		.transform((value) => (value === '' ? undefined : value))
		.optional(),
	/** Способ закрытия; отсутствие — ручная отметка. */
	completion: checklistCompletionSchema.optional(),
	/** Кнопка рядом с пунктом: открывает форму карточки, но пункт не закрывает. */
	action: z.enum(CHECKLIST_ACTION_KEYS, { error: 'Такого действия у пункта нет' }).optional()
});

export type ChecklistItem = z.output<typeof checklistItemSchema>;

/** Пункт закрывается фактом из данных дела, а не отметкой. */
export function isFactItem(
	item: ChecklistItem
): item is ChecklistItem & { completion: { kind: 'fact'; rule: ChecklistRuleKey } } {
	return item.completion?.kind === 'fact';
}

/**
 * Результат проверки пункта-факта: выполнен ли и чем — словами («Выбрано
 * подразделение: кафедра ИТ»). У открытой стадии его считает сервер при каждом
 * чтении; у закрытой — сохранён при выходе и не пересчитывается.
 */
export type ChecklistFact = { done: boolean; evidence: string | null };

/** Отметки по чек-листу: ключ пункта → выполнен или нет. */
export const checklistStateSchema = z.record(z.string(), z.boolean());

export type ChecklistState = z.output<typeof checklistStateSchema>;

/**
 * Назначения учебных групп, которые стадия может потребовать. Каталог
 * принадлежит обмену (`LEARNING_PURPOSES`), но импортировать его значения сюда
 * нельзя: контракт обмена через справочник сам зависит от этого модуля, и круг
 * импортов оставил бы одну из сторон неинициализированной. Тип ниже требует
 * ровно те же ключи, что у каталога: разойтись им не даст компилятор.
 */
const STAGE_GROUP_PURPOSES = {
	students: 'students',
	teachers: 'teachers',
	upskilling: 'upskilling'
} as const satisfies { [Purpose in LearningPurpose]: Purpose };

/**
 * Слепок стадии на момент входа в неё. Хранится в записи о стадии, потому что
 * процесс группы могут изменить, а сроки и чек-лист уже пройденной стадии
 * обязаны остаться такими, какими их видел исполнитель.
 *
 * Правила перехода движок берёт именно отсюда, а не из текущей структуры:
 * поэтому в слепке лежит всё, о чём спрашивает `evaluateTransition`, и
 * добавление поля в стадию означает добавление поля сюда.
 */
export const stageSnapshotSchema = z.object({
	key: z.string().min(1),
	name: z.string().min(1),
	position: z.number().int().min(1),
	category: z.enum(STAGE_CATEGORIES),
	/** Норматив стадии в днях; из него считается срок в представлении статуса. */
	slaDays: z.number().int().min(0),
	/** Через сколько дней без событий стадия считается протухшей. */
	staleAfterDays: z.number().int().min(0).nullable(),
	requiresResult: z.boolean(),
	requiresConfirmation: z.boolean(),
	/** Стадию подтверждают фактом из системы обучения. */
	requiresLmsData: z.boolean(),
	/**
	 * Отметка, которой по документу взаимодействия подтверждается стадия;
	 * `null` — отметки не требуется. Одна, а не список: стадия спрашивает
	 * «подписан ли документ», и два ответа на один вопрос означали бы две разных
	 * стадии.
	 */
	requiresDocumentMark: z.enum(DOCUMENT_STATUS_FACTS).nullable(),
	/**
	 * На документе какого шаблона ищется отметка; `null` — на любом документе
	 * взаимодействия. Без сужения стадию передачи материалов закрыло бы
	 * соглашение, утверждённое ещё на подписании.
	 */
	requiresDocumentTemplate: z.enum(DOCUMENT_TEMPLATE_KEYS).nullable(),
	/**
	 * Назначения учебных групп, итог которых подтверждает стадию; `null` —
	 * любое назначение. Итог группы преподавателей не доказывает занятий со
	 * студентами.
	 */
	lmsGroupPurposes: z.array(z.enum(STAGE_GROUP_PURPOSES)).min(1).nullable(),
	/** С этой стадии процесс заканчивается: дальше не идут, а завершают. */
	isFinal: z.boolean(),
	checklist: z.array(checklistItemSchema)
});

export type StageSnapshot = z.output<typeof stageSnapshotSchema>;

/**
 * Чем подтверждён факт прохождения стадии: приложенным документом, отметкой
 * ответственного, записью во внешней системе обучения или отметкой по
 * документу дела.
 *
 * `document_mark` от `file` отличается тем, кто его ставит: файл прикладывает
 * сотрудник, а отметку по документу засчитывает движок — сам факт «документ
 * утверждён» и есть подтверждение, и переписать его вручную нельзя.
 */
export const stageConfirmationSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('file'), documentId: z.uuid() }),
	z.object({ kind: z.literal('mark'), byUserId: z.uuid(), at: z.iso.datetime({ offset: true }) }),
	z.object({
		kind: z.literal('lms_record'),
		source: z.string().min(1),
		recordId: z.string().min(1)
	}),
	z.object({
		kind: z.literal('document_mark'),
		documentId: z.uuid(),
		mark: z.enum(DOCUMENT_STATUS_FACTS),
		markedAt: z.iso.datetime({ offset: true })
	})
]);

export type StageConfirmation = z.output<typeof stageConfirmationSchema>;

const interactionPartySchema = z.object({
	organizationId: id('Выберите организацию-участника'),
	partyRole: z.enum(PARTY_ROLES, { error: 'Выберите роль участника' }),
	/** Основная сторона взаимодействия: с ней ведётся процесс. */
	isPrimary: z.boolean().default(false),
	/** Контактное лицо участника — одна из его ролей в организации. */
	contactAffiliationId: optionalId('Некорректный идентификатор контактного лица'),
	siteIds: z.array(z.uuid({ error: 'Некорректный идентификатор площадки' })).default([])
});

const interactionProgramSchema = z.object({
	programId: id('Выберите программу'),
	/** Конкретная версия программы, если взаимодействие привязано к ней. */
	programVersionId: optionalId('Некорректный идентификатор версии программы')
});

const interactionFields = {
	title: requiredText(300, 'Укажите название взаимодействия'),
	/** Срок действия договора или соглашения. */
	agreementPeriodStart: optionalIsoDate('Дата начала соглашения указана неверно'),
	agreementPeriodEnd: optionalIsoDate('Дата окончания соглашения указана неверно'),
	/** Учебный период, к которому относится взаимодействие. */
	academicPeriodStart: optionalIsoDate('Дата начала учебного периода указана неверно'),
	academicPeriodEnd: optionalIsoDate('Дата окончания учебного периода указана неверно'),
	ownerUserId: id('Выберите ответственного'),
	parties: z
		.array(interactionPartySchema)
		.min(1, { error: 'Во взаимодействии должен быть хотя бы один участник' }),
	programs: z.array(interactionProgramSchema).default([]),
	productIds: z.array(z.uuid({ error: 'Некорректный идентификатор продукта' })).default([]),
	/**
	 * Договор контрагента, по которому идёт работа. Принадлежит основной
	 * стороне: договор живёт у контрагента, а взаимодействие его только выбирает
	 * (`docs/domain.md`, раздел 3.2). Проверку принадлежности делает сервис — по
	 * идентификатору её не сделать.
	 */
	contractId: optionalId('Некорректный идентификатор договора'),
	/**
	 * Позиции выбранного договора: по каким именно продуктам этого договора идёт
	 * работа. Состав продуктов они не задают — он в `productIds`; позиция
	 * добавляет к продукту коммерческие условия.
	 */
	contractItemIds: z
		.array(z.uuid({ error: 'Некорректный идентификатор позиции договора' }))
		.default([]),
	externalSource: optionalText(100),
	externalId: optionalText(200)
};

type InteractionPeriods = {
	agreementPeriodStart: string | null;
	agreementPeriodEnd: string | null;
	academicPeriodStart: string | null;
	academicPeriodEnd: string | null;
};

function agreementPeriodIsOrdered(value: InteractionPeriods): boolean {
	return (
		value.agreementPeriodStart === null ||
		value.agreementPeriodEnd === null ||
		value.agreementPeriodEnd >= value.agreementPeriodStart
	);
}

function academicPeriodIsOrdered(value: InteractionPeriods): boolean {
	return (
		value.academicPeriodStart === null ||
		value.academicPeriodEnd === null ||
		value.academicPeriodEnd >= value.academicPeriodStart
	);
}

function partiesAreDistinct(value: { parties: { organizationId: string }[] }): boolean {
	return new Set(value.parties.map((party) => party.organizationId)).size === value.parties.length;
}

function exactlyOnePrimaryParty(value: { parties: { isPrimary: boolean }[] }): boolean {
	return value.parties.filter((party) => party.isPrimary).length === 1;
}

function programsAreDistinct(value: { programs: { programId: string }[] }): boolean {
	return new Set(value.programs.map((program) => program.programId)).size === value.programs.length;
}

/**
 * Позиции бывают только у выбранного договора: позиция без договора — это
 * ссылка в никуда, и проверить её принадлежность нечему.
 */
function contractItemsHaveContract(value: {
	contractId: string | null;
	contractItemIds: string[];
}): boolean {
	return value.contractId !== null || value.contractItemIds.length === 0;
}

function contractItemsAreDistinct(value: { contractItemIds: string[] }): boolean {
	return new Set(value.contractItemIds).size === value.contractItemIds.length;
}

export const createInteractionSchema = z
	.object(interactionFields)
	.refine(agreementPeriodIsOrdered, {
		error: 'Дата окончания соглашения не может быть раньше даты начала',
		path: ['agreementPeriodEnd']
	})
	.refine(academicPeriodIsOrdered, {
		error: 'Дата окончания учебного периода не может быть раньше даты начала',
		path: ['academicPeriodEnd']
	})
	.refine(partiesAreDistinct, {
		error: 'Организация может участвовать во взаимодействии только один раз',
		path: ['parties']
	})
	.refine(exactlyOnePrimaryParty, {
		error: 'Отметьте ровно одного основного участника взаимодействия',
		path: ['parties']
	})
	.refine(programsAreDistinct, {
		error: 'Программа может быть выбрана только один раз',
		path: ['programs']
	})
	.refine(contractItemsHaveContract, {
		error: 'Позиции выбираются из договора: сначала выберите договор',
		path: ['contractItemIds']
	})
	.refine(contractItemsAreDistinct, {
		error: 'Позиция договора может быть выбрана только один раз',
		path: ['contractItemIds']
	});

/**
 * Версия правки записи, с которой открыта форма.
 *
 * Обязательна: форма без версии — это форма, про которую нельзя сказать, не
 * затрёт ли она чужую правку, и разрешать ей запись значило бы отключить
 * защиту. Сверяет её команда под блокировкой строки (`docs/workflow.md`,
 * «Одновременная работа»).
 */
export const editVersionField = z
	.number({ error: 'Форма не знает версию записи: обновите карточку' })
	.int({ error: 'Некорректная версия записи' })
	.min(1, { error: 'Некорректная версия записи' });

export const updateInteractionSchema = createInteractionSchema.extend({
	id: id('Некорректный идентификатор взаимодействия'),
	/** Версия записи, с которой открыта форма; чужая правка после неё — отказ. */
	editVersion: editVersionField,
	/**
	 * Причина правки плана: попадает в предметную историю изменений, чтобы
	 * сдвиг сроков не выглядел как случайность.
	 */
	reason: optionalText(1000)
});

/**
 * Смена контактного лица стороны из карточки. Контакт — одна из действующих
 * ролей организации этой стороны; `null` — контакт снят. Остальные поля
 * стороны команда не трогает, поэтому форме их везти незачем.
 */
/**
 * «Как связываться» — канал связи в роли контактного лица, как в карточке
 * организации. `null` — не менять записанный.
 */
export const contactChannelField = optionalText(200);

export const changeInteractionContactSchema = z.object({
	interactionId: id('Некорректный идентификатор взаимодействия'),
	partyId: id('Некорректный идентификатор стороны'),
	contactAffiliationId: optionalId('Некорректный идентификатор контактного лица'),
	editVersion: editVersionField,
	reason: optionalText(1000),
	channel: contactChannelField
});

export type ChangeInteractionContactDraft = z.input<typeof changeInteractionContactSchema>;

/** По какому столбцу и в какую сторону упорядочен список взаимодействий. */
export const INTERACTION_SORTS = [
	'lastActivityAt',
	'-lastActivityAt',
	'title',
	'-title',
	'dueAt',
	'-dueAt'
] as const;

export type InteractionSort = (typeof INTERACTION_SORTS)[number];

/**
 * Многозначный параметр адреса: `dir=a,b` и `dir=a&dir=b` — одно и то же.
 * Непонятное значение — не ошибка запроса, а просто не фильтр: ссылку на
 * список правят руками не реже, чем ссылку на отчёт.
 *
 * Имена и смысл — те же, что у отчёта (`org`, `dir`, `prog`, `prod` в
 * `contracts/reports.ts`): вуз, направление, программа и продукт значат одно и
 * то же в списке и в отчёте, и ссылка одного читается фильтром другого.
 */
const multiUuid = z
	.union([z.string(), z.array(z.string())])
	.default([])
	.transform((value) =>
		(Array.isArray(value) ? value : [value])
			.flatMap((item) => item.split(','))
			.map((item) => item.trim())
			.filter((item) => z.uuid().safeParse(item).success)
	);

/** Состояния портфеля, по которым отбирает список. */
export const INTERACTION_LIST_STATES = ['paused', 'blocked', 'stale'] as const;

export type InteractionListState = (typeof INTERACTION_LIST_STATES)[number];

export const INTERACTION_LIST_STATE_LABELS: Record<InteractionListState, string> = {
	paused: 'На паузе',
	blocked: 'С помехами',
	stale: 'Тишина'
};

export const interactionListQuerySchema = z.object({
	status: z.enum(INTERACTION_STATUSES).nullable().default(null),
	ownerUserId: optionalId('Некорректный идентификатор ответственного'),
	organizationId: optionalId('Некорректный идентификатор организации'),
	/**
	 * Пространство ключом (`b2b`, `b2c`). По нему же доска выбирает, чьи стадии
	 * станут колонками: список и доска — один отбор, показанный дважды.
	 */
	workspace: optionalText(100),
	/** Смысловая группа текущей стадии: «на каком участке процесса стоим». */
	stageCategory: z.enum(STAGE_CATEGORIES).nullable().default(null),
	/** Только просроченные: срок текущей стадии уже прошёл. */
	overdue: z
		.union([z.boolean(), z.enum(['true', 'false'])])
		.default(false)
		.transform((value) => value === true || value === 'true'),
	/**
	 * Состояние портфеля — то же правило, что у плиток главной
	 * (`interactions/overview.ts`): на паузе, с открытой помехой, тишина дольше
	 * нормы стадии.
	 */
	state: z.enum(INTERACTION_LIST_STATES).nullable().default(null),
	/**
	 * Раздел «Моего дня»: ровно те дела, что главная положила в этот раздел, —
	 * тем же разбором (`interactions/my-day.ts`), а не вторым описанием правила.
	 */
	day: z.enum(MY_DAY_INTERACTION_KINDS).nullable().default(null),
	/**
	 * Закрыты (завершены или отменены) за последние N дней — по последнему
	 * событию, как плитка «Завершённые» главной.
	 */
	closedWithin: z.coerce
		.number({ error: 'Окно закрытия — число дней' })
		.int({ error: 'Окно закрытия — целое число дней' })
		.min(1, { error: 'Окно закрытия — от 1 дня' })
		.max(365, { error: 'Окно закрытия — не больше 365 дней' })
		.nullable()
		.default(null),
	/** Вуз — основная сторона взаимодействия (`interaction_parties.is_primary`). */
	org: multiUuid,
	/**
	 * Направление — объединение направлений продуктов и программ взаимодействия,
	 * тем же условием, что у отчёта (`reports/conditions.ts`).
	 */
	dir: multiUuid,
	prog: multiUuid,
	prod: multiUuid,
	/**
	 * Ответственные — несколько сразу, как аватарки над доской. С `ownerUserId`
	 * складывается через «и»: оба условия сужают один и тот же набор.
	 */
	owner: multiUuid,
	sort: z.enum(INTERACTION_SORTS).default('-lastActivityAt'),
	q: searchQuery,
	...pageQuerySchema.shape
});

/**
 * Номер редакции процесса, с которой была отрисована карточка.
 *
 * Стадия с тем же идентификатором после публикации принадлежит прежней
 * редакции, поэтому одной сверки `fromStageId` мало: команда несёт номер, и под
 * блокировкой строки взаимодействия он сверяется с действующей редакцией
 * группы. Несовпадение — отказ до единой записи.
 */
const revisionField = z
	.number({ error: 'Некорректный номер редакции процесса' })
	.int({ error: 'Некорректный номер редакции процесса' })
	.min(1, { error: 'Некорректный номер редакции процесса' });

/**
 * Команды, обращённые к текущей записи стадии, а не к переходу: пауза и её
 * снятие, подтверждение, результат, отметка чек-листа, помеха.
 *
 * Запись стадии — та, что была открыта у человека в форме. Сверки стадии мало:
 * при возврате на ту же стадию открывается новая запись с тем же `stageId`, и
 * результат, набранный для прежней, лёг бы в новую. Другая открытая запись —
 * отказ «стадия уже сменилась», до единой записи.
 */
const stageEntryFields = {
	interactionId: id('Некорректный идентификатор взаимодействия'),
	stageEntryId: id('Некорректный идентификатор записи стадии')
};

/** Переходы двигают процесс: у всех трёх видов общий набор полей. */
const stageMoveFields = {
	interactionId: id('Некорректный идентификатор взаимодействия'),
	/**
	 * Стадия, с которой команда отдана. Сервер сверяет её с открытой записью и
	 * отказывает, если кто-то успел сдвинуть взаимодействие раньше.
	 */
	fromStageId: id('Некорректный идентификатор стадии'),
	revision: revisionField
};

export const advanceStageSchema = z.object({
	...stageMoveFields,
	toStageId: id('Выберите стадию, на которую переходим'),
	/**
	 * Комментарий к шагу вперёд: чем закончили стадию. По умолчанию
	 * необязателен, но переход процесса может потребовать его (`requiresReason`),
	 * и тогда отказывает движок — схема про настройку процесса не знает.
	 */
	reason: optionalText(1000),
	/** Результат стадии; обязателен, если стадия его требует. */
	resultText: optionalText(4000),
	checklistState: checklistStateSchema.default({})
});

export const returnStageSchema = z.object({
	...stageMoveFields,
	toStageId: id('Выберите стадию, на которую возвращаем'),
	reason: requiredText(1000, 'Опишите, почему взаимодействие возвращается назад')
});

export const skipStageSchema = z.object({
	...stageMoveFields,
	toStageId: id('Выберите стадию, на которую переходим'),
	reason: requiredText(1000, 'Опишите, почему стадия пропускается')
});

export const pauseStageSchema = z.object({
	...stageEntryFields,
	reason: z.enum(PAUSE_REASONS, { error: 'Выберите причину паузы' }),
	/** Кого ждём — участник взаимодействия, а не произвольная организация. */
	waitingPartyId: optionalId('Некорректный идентификатор участника'),
	nextAction: optionalText(1000),
	note: requiredText(1000, 'Опишите, чего ждём')
});

export const resumeStageSchema = z.object({
	...stageEntryFields,
	note: optionalText(1000)
});

export const confirmStageSchema = z.object({
	...stageEntryFields,
	/**
	 * Отметку исполнителя (`mark`) сервер дополняет автором и временем сам:
	 * клиент не может назначить, кто и когда подтвердил. Вида `document_mark`
	 * здесь нет намеренно: его ставит движок из самой отметки по документу, и
	 * принятый от клиента он означал бы подтверждение документом, которого никто
	 * не отмечал.
	 */
	confirmation: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('file'), documentId: id('Выберите документ-подтверждение') }),
		z.object({ kind: z.literal('mark') }),
		z.object({
			kind: z.literal('lms_record'),
			source: requiredText(100, 'Укажите систему обучения'),
			recordId: requiredText(200, 'Укажите идентификатор записи в системе обучения')
		})
	])
});

export const raiseBlockerSchema = z.object({
	/**
	 * Помеха принадлежит взаимодействию, но ставится на запись стадии, которую
	 * человек видел: без неё помеха о прежней стадии повисла бы на новой.
	 */
	...stageEntryFields,
	/** Код причины из настраиваемого справочника; текст — в описании. */
	reasonCode: requiredText(100, 'Выберите причину блокировки'),
	description: requiredText(4000, 'Опишите, что мешает двигаться дальше'),
	/** Блокирующая проблема запрещает переход на следующую стадию. */
	blocksTransition: z.boolean().default(true),
	assigneeUserId: optionalId('Некорректный идентификатор ответственного за снятие')
});

export const resolveBlockerSchema = z.object({
	blockerId: id('Некорректный идентификатор блокировки'),
	resolution: requiredText(4000, 'Опишите, как проблема решена')
});

export const createCommentSchema = z.object({
	interactionId: id('Некорректный идентификатор взаимодействия'),
	body: requiredText(4000, 'Комментарий не может быть пустым'),
	/**
	 * Ключ повтора формы: один на черновик. Повторная отправка того же
	 * черновика (двойной щелчок, повтор после обрыва связи) возвращает уже
	 * записанный комментарий и не зовёт упомянутых второй раз. У API свой
	 * механизм — заголовок `Idempotency-Key`.
	 */
	requestKey: z.uuid({ error: 'Некорректный ключ отправки комментария' }).optional()
});

/** Отметка по одному пункту чек-листа текущей стадии. */
export const setChecklistItemSchema = z.object({
	...stageEntryFields,
	key: requiredText(100, 'Укажите пункт чек-листа'),
	done: z.boolean()
});

/** Результат текущей стадии — текстом, без перехода. */
export const setStageResultSchema = z.object({
	...stageEntryFields,
	resultText: requiredText(4000, 'Опишите результат стадии')
});

/**
 * Смена ответственного за взаимодействие. Отдельная команда, а не поле формы
 * правки: её отдают из списка сразу по нескольким записям, и она обязана
 * оставлять след в истории изменений.
 */
export const setResponsibleSchema = z.object({
	interactionIds: z
		.array(id('Некорректный идентификатор взаимодействия'))
		.min(1, { error: 'Выберите хотя бы одно взаимодействие' }),
	userId: id('Выберите ответственного')
});

/**
 * Закрытие взаимодействия как выполненного.
 *
 * Итог необязателен там, где взаимодействие дошло до конца маршрута: сама
 * последняя стадия и её результат уже всё рассказали. У досрочного закрытия
 * (`force`) итог обязателен — иначе в карточке останется взаимодействие,
 * закрытое посреди процесса без единого слова о том, почему.
 *
 * Номер редакции обязателен по той же причине, что и у перехода: «завершить»
 * нажимают, посмотрев на финальную стадию и её требования, а публикация
 * изменения процесса могла к этому моменту сделать финальной другую стадию.
 */
export const completeInteractionSchema = z
	.object({
		interactionId: id('Некорректный идентификатор взаимодействия'),
		/** Редакция процесса, с которой была отрисована карточка. */
		revision: revisionField,
		/** Чем всё кончилось; попадает в историю как исход последней стадии. */
		summary: optionalText(4000),
		/** Закрыть не с последней стадии маршрута — отступление от процесса. */
		force: z.boolean().default(false)
	})
	.refine((value) => !value.force || (value.summary ?? '').trim() !== '', {
		error: 'Досрочное закрытие нужно объяснить: опишите итог',
		path: ['summary']
	});

/**
 * Отмена взаимодействия: причина обязательна на любой стадии, номер редакции —
 * как у завершения.
 */
export const cancelInteractionSchema = z.object({
	interactionId: id('Некорректный идентификатор взаимодействия'),
	/** Редакция процесса, с которой была отрисована карточка. */
	revision: revisionField,
	reason: requiredText(1000, 'Опишите, почему взаимодействие отменяется')
});

/**
 * Структура процесса: стадии и переходы между ними.
 *
 * Стадии и переходы адресуются ключами, а не идентификаторами: структуру
 * описывают данными (процессы, с которыми приезжает система, — константы в
 * коде), а идентификаторы появляются только в базе. Ключ стадии устойчив: по
 * нему записи сопоставляются с новой структурой при изменении процесса.
 */
export const stageDefinitionSchema = z
	.object({
		key: requiredText(100, 'У стадии должен быть ключ'),
		name: requiredText(300, 'У стадии должно быть название'),
		category: z.enum(STAGE_CATEGORIES, { error: 'Выберите смысловую группу стадии' }),
		/** Норматив стадии в днях; из него считается срок в представлении статуса. */
		slaDays: z
			.number({ error: 'Норматив стадии — целое число дней' })
			.int()
			.min(0, { error: 'Норматив стадии не может быть отрицательным' })
			.max(365, { error: 'Норматив стадии не длиннее года' }),
		/** Через сколько дней без событий стадия считается протухшей. */
		staleAfterDays: z
			.number({ error: 'Срок протухания — целое число дней' })
			.int()
			.min(1, { error: 'Срок протухания — хотя бы один день' })
			.max(365, { error: 'Срок протухания не длиннее года' })
			.nullable()
			.default(null),
		requiresResult: z.boolean().default(false),
		requiresConfirmation: z.boolean().default(false),
		/** Стадию подтверждают фактом из системы обучения. */
		requiresLmsData: z.boolean().default(false),
		/** Отметка по документу дела, без которой со стадии не уходят. */
		requiresDocumentMark: z.enum(DOCUMENT_STATUS_FACTS).nullable().default(null),
		/** Шаблон документа, на котором ищется отметка; `null` — любой документ. */
		requiresDocumentTemplate: z
			.enum(DOCUMENT_TEMPLATE_KEYS, { error: 'Такого шаблона документа нет' })
			.nullable()
			.default(null),
		/** Назначения групп, итог которых подтверждает стадию; `null` — любые. */
		lmsGroupPurposes: z
			.array(z.enum(STAGE_GROUP_PURPOSES, { error: 'Такого назначения группы нет' }))
			.min(1, { error: 'Выберите хотя бы одно назначение группы или снимите сужение' })
			.nullable()
			.default(null),
		/** Кого уведомить при входе дела на стадию; `null` — никого. */
		onEnterNotify: z.enum(STAGE_ENTER_NOTIFY_TARGETS).nullable().default(null),
		/** С этой стадии процесс заканчивается: переходов вперёд с неё не требуют. */
		isFinal: z.boolean().default(false),
		checklist: z.array(checklistItemSchema).default([])
	})
	.refine(
		(stage) => stage.requiresDocumentTemplate === null || stage.requiresDocumentMark !== null,
		{
			error: 'Шаблон документа задают вместе с требуемой отметкой',
			path: ['requiresDocumentTemplate']
		}
	)
	.refine((stage) => stage.lmsGroupPurposes === null || stage.requiresLmsData, {
		error: 'Назначения групп задают у стадии, которую подтверждают данные обучения',
		path: ['lmsGroupPurposes']
	});

export const stageTransitionDefinitionSchema = z.object({
	fromStageKey: requiredText(100, 'Укажите стадию, с которой возможен переход'),
	toStageKey: requiredText(100, 'Укажите стадию, на которую ведёт переход'),
	kind: z.enum(STAGE_TRANSITION_KINDS, { error: 'Выберите вид перехода' }),
	/** Право, без которого переход недоступен. */
	requiredPermissionKey: requiredText(100, 'Укажите право, которое требует переход'),
	requiresReason: z.boolean().default(false)
});

/**
 * Правило переноса: куда переедут взаимодействия со стадии, которой в новой
 * структуре больше нет. Ключи, а не идентификаторы: стадия новой редакции —
 * другая строка, а ключ тот же.
 */
export const stageMigrationRuleSchema = z
	.object({
		removedStageKey: requiredText(100, 'Укажите ключ удаляемой стадии'),
		targetStageKey: requiredText(100, 'Укажите стадию, на которую переедут записи')
	})
	.refine((value) => value.removedStageKey !== value.targetStageKey, {
		error: 'Переносить записи на ту же стадию бессмысленно',
		path: ['targetStageKey']
	});

type ProcessDefinition = {
	stages: { key: string }[];
	transitions: { fromStageKey: string; toStageKey: string }[];
	migrationRules: { removedStageKey: string; targetStageKey: string }[];
};

function stageKeysAreDistinct(value: ProcessDefinition): boolean {
	return new Set(value.stages.map((stage) => stage.key)).size === value.stages.length;
}

function transitionsReferenceStages(value: ProcessDefinition): boolean {
	const keys = new Set(value.stages.map((stage) => stage.key));

	return value.transitions.every(
		(transition) => keys.has(transition.fromStageKey) && keys.has(transition.toStageKey)
	);
}

function transitionsAreDistinct(value: ProcessDefinition): boolean {
	const pairs = value.transitions.map(
		(transition) => `${transition.fromStageKey}→${transition.toStageKey}`
	);

	return new Set(pairs).size === pairs.length;
}

function transitionsGoSomewhereElse(value: ProcessDefinition): boolean {
	return value.transitions.every((transition) => transition.fromStageKey !== transition.toStageKey);
}

/** Правило переноса ведёт на стадию, которая в новой структуре есть. */
function migrationRulesReferenceStages(value: ProcessDefinition): boolean {
	const keys = new Set(value.stages.map((stage) => stage.key));

	return value.migrationRules.every(
		(rule) => !keys.has(rule.removedStageKey) && keys.has(rule.targetStageKey)
	);
}

function migrationRulesAreDistinct(value: ProcessDefinition): boolean {
	const keys = value.migrationRules.map((rule) => rule.removedStageKey);

	return new Set(keys).size === keys.length;
}

/**
 * Структура процесса целиком — то, что записывает редакцию.
 *
 * Пишется всегда целиком, а не полями: правится описание процесса, а не
 * отдельная стадия, и половина описания ничего не описывает. Ключа у структуры
 * нет — она принадлежит группе, а групп столько, сколько сценариев работы.
 */
export const processDefinitionSchema = z
	.object({
		name: requiredText(300, 'Укажите название процесса'),
		note: optionalText(1000),
		stages: z
			.array(stageDefinitionSchema)
			.min(1, { error: 'В процессе должна быть хотя бы одна стадия' }),
		transitions: z.array(stageTransitionDefinitionSchema).default([]),
		/** По строке на каждую стадию, которой в этой редакции не стало. */
		migrationRules: z.array(stageMigrationRuleSchema).default([])
	})
	.refine(stageKeysAreDistinct, { error: 'Ключи стадий не повторяются', path: ['stages'] })
	.refine(transitionsReferenceStages, {
		error: 'Переход ссылается на стадию, которой нет в процессе',
		path: ['transitions']
	})
	.refine(transitionsAreDistinct, {
		error: 'Между двумя стадиями возможен только один переход',
		path: ['transitions']
	})
	.refine(transitionsGoSomewhereElse, {
		error: 'Переход не может вести на ту же стадию',
		path: ['transitions']
	})
	.refine(migrationRulesReferenceStages, {
		error: 'Правило переноса ведёт мимо стадий процесса',
		path: ['migrationRules']
	})
	.refine(migrationRulesAreDistinct, {
		error: 'У удалённой стадии не бывает двух правил переноса',
		path: ['migrationRules']
	});

export type CreateInteractionInput = z.output<typeof createInteractionSchema>;
export type UpdateInteractionInput = z.output<typeof updateInteractionSchema>;
/**
 * То, что присылают команде до разбора схемой.
 *
 * Команда заведения и команда правки разбирают вход сами, поэтому и принимают
 * они именно вход: поле со значением по умолчанию (состав продуктов, позиции
 * договора) вызывающий вправе не называть — за него ответит схема, а не
 * россыпь пустых списков по всем вызовам.
 */
export type CreateInteractionDraft = z.input<typeof createInteractionSchema>;
export type UpdateInteractionDraft = z.input<typeof updateInteractionSchema>;
export type InteractionListQuery = z.output<typeof interactionListQuerySchema>;

/** Пункт выпадающего списка фильтра: то же значение и подпись, что у отчёта. */
export type InteractionFilterOption = { value: string; label: string };

/**
 * Варианты фильтров вуз/направление/программа/продукт списка и доски —
 * узкие: только то, что реально встречается в пространстве и в области
 * доступа того, кто список открыл (`interactions/read.ts`,
 * `readInteractionFilterOptions`). Каталог отчёта (`reports/options.ts`)
 * здесь не подходит — он не сужен ни по пространству, ни по факту участия в
 * взаимодействии.
 */
export type InteractionFilterOptions = {
	organizations: InteractionFilterOption[];
	directions: InteractionFilterOption[];
	programs: InteractionFilterOption[];
	products: InteractionFilterOption[];
	/** Ответственные, у которых в пространстве есть хотя бы одно взаимодействие. */
	owners: InteractionFilterOption[];
};
export type AdvanceStageInput = z.output<typeof advanceStageSchema>;
export type ReturnStageInput = z.output<typeof returnStageSchema>;
export type SkipStageInput = z.output<typeof skipStageSchema>;
export type PauseStageInput = z.output<typeof pauseStageSchema>;
export type ResumeStageInput = z.output<typeof resumeStageSchema>;
export type ConfirmStageInput = z.output<typeof confirmStageSchema>;
export type RaiseBlockerInput = z.output<typeof raiseBlockerSchema>;
export type ResolveBlockerInput = z.output<typeof resolveBlockerSchema>;
export type CreateCommentInput = z.output<typeof createCommentSchema>;
export type SetChecklistItemInput = z.output<typeof setChecklistItemSchema>;
export type SetStageResultInput = z.output<typeof setStageResultSchema>;
export type SetResponsibleInput = z.output<typeof setResponsibleSchema>;
export type CompleteInteractionInput = z.output<typeof completeInteractionSchema>;
export type CancelInteractionInput = z.output<typeof cancelInteractionSchema>;
export type StageDefinitionInput = z.output<typeof stageDefinitionSchema>;
export type StageTransitionDefinitionInput = z.output<typeof stageTransitionDefinitionSchema>;
export type StageMigrationRuleInput = z.output<typeof stageMigrationRuleSchema>;
export type ProcessDefinitionInput = z.output<typeof processDefinitionSchema>;

/**
 * Представления, которые сервер отдаёт наружу. Строки таблиц Drizzle за
 * границу сервера не выходят: тип ответа описан здесь и не меняется от того,
 * что происходит со схемой базы.
 */
export type StageView = {
	id: string;
	revisionId: string;
	position: number;
	key: string;
	name: string;
	category: StageCategory;
	slaDays: number;
	staleAfterDays: number | null;
	requiresResult: boolean;
	requiresConfirmation: boolean;
	requiresLmsData: boolean;
	/** Отметка по документу дела, которой подтверждается стадия; `null` — не нужна. */
	requiresDocumentMark: DocumentStatusFact | null;
	/** Шаблон документа, на котором ищется отметка; `null` — любой документ дела. */
	requiresDocumentTemplate: DocumentTemplateKey | null;
	/** Назначения учебных групп, итог которых подтверждает стадию; `null` — любые. */
	lmsGroupPurposes: LearningPurpose[] | null;
	/**
	 * Кого уведомить при входе дела на стадию; `null` — никого. В слепок записи
	 * не входит: это действие при входе, а не правило, по которому со стадии
	 * уходят.
	 */
	onEnterNotify: StageEnterNotifyTarget | null;
	isFinal: boolean;
	checklist: ChecklistItem[];
};

export type StageTransitionView = {
	id: string;
	fromStageId: string;
	toStageId: string;
	kind: StageTransitionKind;
	requiredPermissionKey: string;
	requiresReason: boolean;
};

export type StageMigrationRuleView = {
	removedStageKey: string;
	targetStageKey: string;
};

/**
 * Редакция процесса: снимок его структуры. Номер редакции живёт в базе и в
 * журнале, но пользовательских решений не принимает — версию никто не выбирает.
 */
export type ProcessRevisionView = {
	id: string;
	workflowId: string;
	version: number;
	name: string;
	note: string | null;
	publishedAt: Date | null;
	stages: StageView[];
	transitions: StageTransitionView[];
	migrationRules: StageMigrationRuleView[];
};

/** Пространство в списке раздела «Процесс». */
export type WorkspaceSummary = {
	id: string;
	key: string;
	name: string;
	description: string | null;
	position: number;
	/** Назначенный процесс; `null` — работать в пространстве ещё нечем. */
	workflow: { id: string; key: string; name: string } | null;
	/** Сколько стадий в действующей редакции; ноль — процесс ещё не заведён. */
	stageCount: number;
	/** Сколько незавершённых взаимодействий идут в этом пространстве сейчас. */
	activeInteractions: number;
	/**
	 * Сколько взаимодействий заведено в нём всего, включая закрытые. По этому
	 * числу решается, можно ли сменить процесс: закрытая запись помнит свои
	 * стадии не хуже открытой, и ключи чужого процесса ей так же ничего не
	 * говорят.
	 */
	interactions: number;
	hasDraft: boolean;
};

/** Процесс в списке: то, что видно при назначении его пространству. */
export type WorkflowSummary = {
	id: string;
	key: string;
	name: string;
	description: string | null;
	/** Сколько стадий в действующей редакции; ноль — стадии ещё не заведены. */
	stageCount: number;
	/** Скольким пространствам процесс назначен. */
	workspaces: number;
	/** Сколько незавершённых взаимодействий идёт по нему во всех них. */
	activeInteractions: number;
	hasDraft: boolean;
};

/**
 * Ключ пространства: он стоит в адресе, и его читают люди.
 *
 * Строчные латинские буквы, цифры и дефис — потому что ключ едет сегментом
 * пути, попадает в письма и в закладки, и кириллица там превращается в
 * проценты. Длина — под заголовок секции меню, а не под предложение.
 */
export const workspaceKeySchema = z
	.string({ error: 'Укажите ключ пространства' })
	.trim()
	.min(2, { error: 'Ключ пространства — не короче двух символов' })
	.max(40, { error: 'Ключ пространства — не длиннее 40 символов' })
	.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
		error: 'Ключ пространства: строчные латинские буквы, цифры и дефис между ними'
	});

/** Заведение пространства. Процесс можно назначить сразу, а можно позже. */
export const createWorkspaceSchema = z.object({
	key: workspaceKeySchema,
	name: requiredText(200, 'Укажите название пространства'),
	description: optionalText(500),
	/** Ключ процесса; `null` — пространство заводится без него. */
	workflowKey: optionalText(40)
});

export type CreateWorkspaceInput = z.output<typeof createWorkspaceSchema>;

/** Переименование: ключ не меняется — он стоит в разосланных ссылках. */
export const renameWorkspaceSchema = z.object({
	key: workspaceKeySchema,
	name: requiredText(200, 'Укажите название пространства'),
	description: optionalText(500)
});

export type RenameWorkspaceInput = z.output<typeof renameWorkspaceSchema>;

/** Назначение процесса пространству. */
export const assignWorkspaceWorkflowSchema = z.object({
	key: workspaceKeySchema,
	/** Ключ процесса; `null` — снять назначение. */
	workflowKey: optionalText(40)
});

export type AssignWorkspaceWorkflowInput = z.output<typeof assignWorkspaceWorkflowSchema>;

/** Новый порядок пространств: ключи целиком, в том порядке, в каком их видно. */
export const reorderWorkspacesSchema = z.object({
	keys: z.array(workspaceKeySchema).min(1, { error: 'Порядок задаётся списком ключей' })
});

export type ReorderWorkspacesInput = z.output<typeof reorderWorkspacesSchema>;

/** Сотрудник, включённый в пространство. */
export type WorkspaceMemberView = {
	userId: string;
	fullName: string;
	roleName: string;
	isActive: boolean;
	/** С какого момента он в пространстве. */
	since: Date;
	/**
	 * За сколько незавершённых взаимодействий пространства он отвечает. Не ноль —
	 * исключение спрашивает подтверждения: эти записи он перестанет видеть.
	 */
	ownedActive: number;
};

/** Пространство с его составом — строка настройки членства. */
export type WorkspaceMembership = {
	id: string;
	key: string;
	name: string;
	members: WorkspaceMemberView[];
};

/** Кого можно включить: действующие сотрудники, которым членство что-то даёт. */
export type WorkspaceMemberCandidate = {
	userId: string;
	fullName: string;
	roleName: string;
	/**
	 * Руководитель сотрудника. Руководитель видит работу подчинённого только в
	 * тех пространствах, куда включён сам, поэтому при включении подчинённого
	 * страница предлагает включить и его.
	 */
	managerUserId: string | null;
};

/** Включить сотрудника в пространство. */
export const addWorkspaceMemberSchema = z.object({
	key: workspaceKeySchema,
	userId: id('Не выбран сотрудник')
});

export type AddWorkspaceMemberInput = z.output<typeof addWorkspaceMemberSchema>;

/**
 * Исключить сотрудника из пространства. `confirmOwned` — согласие потерять
 * из виду взаимодействия, за которые он отвечает: без него команда с такими
 * записями отказывает и называет их число, а не исключает молча.
 */
export const removeWorkspaceMemberSchema = z.object({
	key: workspaceKeySchema,
	userId: id('Не выбран сотрудник'),
	confirmOwned: z.boolean()
});

export type RemoveWorkspaceMemberInput = z.output<typeof removeWorkspaceMemberSchema>;

/** Процесс целиком: что действует, что в черновике и что мешает его применить. */
export type WorkflowDetail = {
	workflow: WorkflowSummary;
	/** Действующая редакция; `null` — стадии ещё не заведены. */
	active: ProcessRevisionView | null;
	draft: ProcessRevisionView | null;
	/** Что мешает применить черновик; у процесса без черновика — пусто. */
	issues: string[];
	/**
	 * Ключи стадий, снятые прошлыми публикациями: они заняты навсегда, и форма
	 * новой стадии не предлагает их из названия.
	 */
	retiredStageKeys: string[];
	/**
	 * Пространства, которым процесс назначен, по порядку в меню. Публикация
	 * меняет работу во всех сразу, и редактор обязан сказать это заранее.
	 */
	workspaces: { key: string; name: string }[];
};

/** Ключ процесса: он стоит в адресе редактора и читается людьми. */
export const workflowKeySchema = z
	.string({ error: 'Укажите ключ процесса' })
	.trim()
	.min(2, { error: 'Ключ процесса — не короче двух символов' })
	.max(40, { error: 'Ключ процесса — не длиннее 40 символов' })
	.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
		error: 'Ключ процесса: строчные латинские буквы, цифры и дефис между ними'
	});

/**
 * Заведение процесса: пустым — стадии описывают черновиком в редакторе — или
 * копией действующих стадий другого процесса.
 */
export const createWorkflowSchema = z.object({
	key: workflowKeySchema,
	name: requiredText(200, 'Укажите название процесса'),
	description: optionalText(500),
	/** Ключ процесса-образца; `null` — процесс заводится пустым. */
	copyFromKey: optionalText(40)
});

export type CreateWorkflowInput = z.output<typeof createWorkflowSchema>;

/** Что стало со стадией действующей структуры в черновике. */
export const STAGE_CHANGE_KINDS = ['kept', 'renamed', 'changed', 'added', 'removed'] as const;

export type StageChangeKind = (typeof STAGE_CHANGE_KINDS)[number];

/** Строка предпросмотра: одна затронутая стадия и куда переедут её записи. */
export type ProcessPreviewRow = {
	stageKey: string;
	stageName: string;
	change: StageChangeKind;
	/** Что именно поменялось в параметрах — по фразе на параметр. */
	changes: string[];
	/** Сколько незавершённых взаимодействий стоит на стадии прямо сейчас. */
	interactions: number;
	/** Куда переедут записи; заполнено только у удалённой стадии. */
	targetStageKey: string | null;
	targetStageName: string | null;
};

/**
 * Дело, которое применение черновика переставит на другую стадию: его стадия
 * исчезла. Предпросмотр называет дела поимённо, а не числом, — процесс бывает
 * назначен нескольким пространствам, и администратор обязан видеть, чью
 * работу он двигает.
 */
export type ProcessPreviewMove = {
	interactionId: string;
	title: string;
	workspaceKey: string;
	workspaceName: string;
	ownerName: string;
	fromStageName: string;
	/** Куда переедет; `null` — правило переноса не задано, и применить нельзя. */
	toStageName: string | null;
};

/**
 * Предпросмотр применения черновика. Считается без блокировок и справочен:
 * пока администратор читает таблицу, КАМы работают. Фактические числа считает
 * транзакция публикации, и в журнал попадают они.
 */
export type ProcessPreview = {
	workflowId: string;
	/** Сколько незавершённых взаимодействий затронет изменение. */
	affected: number;
	rows: ProcessPreviewRow[];
	/** Переезжающие дела поимённо, по пространствам и названиям. */
	moves: ProcessPreviewMove[];
	/** Что мешает применить черновик; непусто — кнопка недоступна. */
	issues: string[];
};

/** Как стадия выглядит на ленте взаимодействия. */
export const STAGE_PROGRESS_STATES = [
	'pending',
	'done',
	'current',
	'paused',
	'overdue',
	'blocked',
	'skipped'
] as const;

export type StageProgressState = (typeof STAGE_PROGRESS_STATES)[number];

export type StageProgressItem = {
	stageId: string;
	key: string;
	name: string;
	position: number;
	category: StageCategory;
	state: StageProgressState;
	/** Срок текущей стадии; у остальных пусто. */
	dueAt: Date | null;
	note: string | null;
	/** Чек-лист стадии по действующему процессу: его показывают, раскрыв стадию. */
	checklist: ChecklistItem[];
	/**
	 * Стадию прошли, а потом убрали из процесса: она остаётся в пути дела
	 * названием и номером из снимка записи, чек-листа по процессу у неё нет.
	 */
	removed: boolean;
};

export type StagePauseView = {
	id: string;
	reason: PauseReason;
	waitingPartyId: string | null;
	nextAction: string | null;
	note: string;
	startedAt: Date;
	endedAt: Date | null;
};

/**
 * Запись о пребывании на стадии вместе со сроком из представления
 * `stage_entry_status`: часы стадии считает база, а не интерфейс.
 */
export type StageEntryView = {
	id: string;
	stageId: string;
	snapshot: StageSnapshot;
	enteredAt: Date;
	leftAt: Date | null;
	outcome: StageOutcome | null;
	outcomeReason: string | null;
	responsibleUserId: string | null;
	responsibleName: string | null;
	waitingPartyId: string | null;
	resultText: string | null;
	confirmation: StageConfirmation | null;
	confirmedAt: Date | null;
	/** Факты системы обучения, которыми подтверждена стадия; `null` — их нет. */
	lmsEvidence: unknown;
	/** Отметка по документу, которой подтверждена стадия; `null` — её нет. */
	documentMarkEvidence: DocumentMarkEvidence | null;
	checklistState: ChecklistState;
	/**
	 * Пункты-факты: ключ пункта → результат проверки. У открытой записи его
	 * считает сервер при чтении, у закрытой — сохранённый при выходе.
	 */
	facts: Record<string, ChecklistFact>;
	/** Файлы, приложенные к этой записи стадии вместе с переходом. */
	documents: { id: string; title: string; mime: string; sizeBytes: number }[];
	dueAt: Date;
	pausedSeconds: number;
	activeSeconds: number;
	remainingSeconds: number;
	overdueSeconds: number;
	isOverdue: boolean;
	isPaused: boolean;
	pauses: StagePauseView[];
};

export type BlockerView = {
	id: string;
	interactionId: string;
	stageEntryId: string | null;
	reasonCode: string;
	description: string;
	blocksTransition: boolean;
	raisedBy: string;
	raisedByName: string;
	assigneeUserId: string | null;
	raisedAt: Date;
	resolvedAt: Date | null;
	resolvedBy: string | null;
	resolution: string | null;
};

export type CommentView = {
	id: string;
	authorId: string;
	/**
	 * Подпись автора в ленте. У текста, пришедшего с заявкой сайта, — источник
	 * («Заявка с сайта»), а не сотрудник, от имени которого её приняли.
	 */
	authorName: string;
	source: CommentSource;
	body: string;
	createdAt: Date;
};

export type InteractionChangeView = {
	id: string;
	changedAt: Date;
	authorId: string;
	authorName: string;
	field: string;
	oldValue: unknown;
	newValue: unknown;
	/**
	 * Подпись значения для ссылочных полей — ответственного, сторон, программ и
	 * продуктов. В `oldValue`/`newValue` у них лежат идентификаторы, а карточка
	 * обязана называть имена; `null` — поле не ссылочное, и показывается само
	 * значение. У записи, которой уже нет, подпись говорит «недоступно»: сырой
	 * идентификатор ничего не объясняет и никуда не ведёт.
	 */
	oldLabel: string | null;
	newLabel: string | null;
	reason: string | null;
};

export type InteractionPartyView = {
	id: string;
	organizationId: string;
	organizationName: string;
	partyRole: PartyRole;
	isPrimary: boolean;
	contactAffiliationId: string | null;
	/** Контактное лицо участника; контакты маскирует `toPersonView`. */
	contact: PersonView | null;
	contactPosition: string | null;
	/**
	 * «Как связываться» из роли контактного лица; `null` — не указан или нет
	 * права видеть людей организации.
	 */
	contactChannel: string | null;
	sites: { id: string; name: string }[];
};

/**
 * Заявка с сайта, из которой заведено дело, и что о ней знает сайт: ключ
 * заявки и последний отправленный на сайт статус с исходом доставки. Читается
 * из журнала обмена по делу — КАМу журнал целиком не открыт, а «ушло ли на
 * сайт» он спрашивает у карточки.
 */
export type SiteApplicationView = {
	/** Ключ заявки на сайте (`externalId` дела). */
	key: string;
	/** Последний статус, который ушёл на сайт; `null` — ещё ничего не уходило. */
	sent: { status: ApplicationStatus; at: Date } | null;
	/**
	 * Исход последнего сообщения о статусе: доставлено, ждёт отправки или
	 * повтора, не доставлено, разобрано вручную; `null` — сообщений не было.
	 */
	delivery: 'delivered' | 'waiting' | 'failed' | 'dismissed' | null;
};

/** Статус заявки словами заявителя — как его показывает сайт. */
export const SITE_APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
	received: 'Принята',
	in_progress: 'В работе',
	on_hold: 'Приостановлена',
	completed: 'Завершена',
	cancelled: 'Отменена'
};

export type InteractionProgramView = {
	programId: string;
	code: string;
	name: string;
	programVersionId: string | null;
};

export type InteractionProductView = {
	productId: string;
	code: string;
	name: string;
};

/**
 * Договор взаимодействия и выбранные из него позиции.
 *
 * Здесь только то подмножество позиций, которое выбрало взаимодействие: сам
 * договор со всеми позициями живёт на карточке контрагента, и дублировать его
 * целиком значило бы отвечать на другой вопрос. Позиция названа продуктом и
 * несёт его коммерческие условия — сроки лицензии и статус по передаче.
 */
export type InteractionContractView = {
	id: string;
	number: string;
	status: ContractStatus;
	signedOn: string | null;
	validUntil: string | null;
	items: {
		id: string;
		productId: string;
		code: string;
		name: string;
		licenseSignedAt: string | null;
		licenseUntil: string | null;
		transferStatus: string;
	}[];
};

/** Взаимодействие целиком — то, из чего собирается карточка. */
export type InteractionView = {
	id: string;
	title: string;
	status: InteractionStatus;
	/** Пространство: выводится из вида основной стороны и не выбирается. */
	workspaceId: string;
	workspaceKey: string;
	workspaceName: string;
	agreementPeriodStart: string | null;
	agreementPeriodEnd: string | null;
	academicPeriodStart: string | null;
	academicPeriodEnd: string | null;
	ownerUserId: string;
	ownerName: string;
	lastActivityAt: Date;
	externalSource: string | null;
	externalId: string | null;
	createdAt: Date;
	updatedAt: Date;
	/**
	 * Версия правки записи: форма плана и договора замораживает её при
	 * открытии и отправляет вместе с полями.
	 */
	editVersion: number;
	parties: InteractionPartyView[];
	programs: InteractionProgramView[];
	products: InteractionProductView[];
	/** Договор контрагента и выбранные позиции; `null` — договор не выбран. */
	contract: InteractionContractView | null;
	documents: InteractionDocumentView[];
};

/** Документ взаимодействия в списке карточки: только то, что видно в строке. */
export type InteractionDocumentView = {
	id: string;
	kind: string;
	/**
	 * Шаблон, по которому документ собран (у новой редакции — унаследованный);
	 * `null` — загружен руками. Стадия, ждущая акт, засчитывает только его.
	 */
	templateKey: DocumentTemplateKey | null;
	/**
	 * Скан, загруженный новой редакцией собранного документа: шаблон у него
	 * унаследован, но сам файл сборщик не собирал.
	 */
	scan: boolean;
	title: string;
	mime: string;
	sizeBytes: number;
	createdAt: Date;
	agreedAt: Date | null;
	approvedAt: Date | null;
	inEffectAt: Date | null;
	/** Комментарии к отметкам: чем каждая из них объясняется. */
	agreedNote: string | null;
	approvedNote: string | null;
	inEffectNote: string | null;
};

/** Строка списка взаимодействий. */
export type InteractionListItem = {
	id: string;
	title: string;
	status: InteractionStatus;
	ownerUserId: string;
	ownerName: string;
	lastActivityAt: Date;
	/** Основные стороны процесса, по одной на роль. */
	institutionName: string | null;
	customerName: string | null;
	stage: {
		id: string;
		key: string;
		name: string;
		position: number;
		category: StageCategory;
	} | null;
	progress: StageProgressItem[];
	dueAt: Date | null;
	remainingSeconds: number | null;
	isOverdue: boolean;
	isPaused: boolean;
	/** Вокруг записи тихо дольше, чем допускает стадия. */
	isStale: boolean;
	openBlockers: number;
};

/** Состояние взаимодействия: где стоим, сколько осталось, что мешает. */
export type InteractionStatusView = {
	interactionId: string;
	workspaceId: string;
	/**
	 * Номер действующей редакции процесса на момент отрисовки. Команда перехода
	 * возвращает его серверу, и тот сверяет номер под блокировкой: стадия с тем
	 * же идентификатором после публикации принадлежит прежней редакции.
	 */
	revision: number;
	current: StageEntryView | null;
	history: StageEntryView[];
	progress: StageProgressItem[];
	blockers: BlockerView[];
	isStale: boolean;
	lastActivityAt: Date;
	/**
	 * Открытую запись перенесла публикация изменённого процесса: откуда и когда.
	 * Показывается, пока запись открыта, и отдельного состояния не заводит.
	 */
	migratedFrom: { stageKey: string; stageName: string; at: Date } | null;
};

/** Что можно сделать помимо перехода по стадиям. */
export const INTERACTION_ACTIONS = [
	'pause',
	'resume',
	'raise_blocker',
	'resolve_blocker',
	'set_result',
	'confirm',
	'set_checklist',
	'set_responsible',
	'upload_document',
	'generate_document',
	'comment',
	'edit'
] as const;

export type InteractionAction = (typeof INTERACTION_ACTIONS)[number];

/**
 * Можно ли закрыть взаимодействие прямо сейчас. Приговор считает сервер — тот
 * же код, который потом выполняет команду; карточка его только показывает,
 * вместе с причиной отказа.
 */
export type InteractionClosingView = {
	complete: {
		allowed: boolean;
		/** Закрытие не с последней стадии: нужны объяснение и право настраивать процесс. */
		requiresForce: boolean;
		reasons: string[];
	};
	cancel: { allowed: boolean; reasons: string[] };
};

/** Переход вместе с приговором: можно ли им воспользоваться и почему нет. */
export type TransitionOptionView = {
	transition: StageTransitionView;
	toStage: { id: string; key: string; name: string; position: number; category: StageCategory };
	allowed: boolean;
	reasons: string[];
};

/**
 * Сводка карточки: что происходит, что мешает, кто должен действовать и что
 * можно сделать прямо сейчас. Это ответ на четыре вопроса, с которыми человек
 * открывает взаимодействие, — поэтому он собирается на сервере целиком.
 */
export type InteractionSummaryView = {
	happening: {
		stage: {
			id: string;
			key: string;
			name: string;
			position: number;
			category: StageCategory;
		} | null;
		dueAt: Date | null;
		remainingSeconds: number | null;
		isOverdue: boolean;
		isPaused: boolean;
		pause: StagePauseView | null;
		waitingParty: { id: string; organizationName: string } | null;
		nextAction: string | null;
	};
	blocking: {
		blockers: BlockerView[];
		openChecklist: ChecklistItem[];
	};
	whoActs: {
		responsibleUser: { id: string; name: string } | null;
		waitingParty: { id: string; organizationName: string } | null;
	};
	canDo: {
		transitions: TransitionOptionView[];
		actions: InteractionAction[];
	};
};

/**
 * Каким представлением показан раздел взаимодействий. Список и доска — это
 * один и тот же отобранный набор записей, показанный двумя способами, поэтому
 * выбор живёт в адресе рядом с фильтрами, а не в памяти страницы.
 */
export const INTERACTION_VIEW_MODES = ['table', 'board'] as const;

export type InteractionViewMode = (typeof INTERACTION_VIEW_MODES)[number];

/**
 * Что происходит с карточкой на доске — теми же словами, что на ленте стадий.
 * Пройденных и предстоящих стадий у карточки не бывает: она стоит ровно на
 * одной, и вопрос только в том, что с этой стадией сейчас.
 */
export type BoardCardState = Extract<
	StageProgressState,
	'current' | 'overdue' | 'paused' | 'blocked'
>;

/**
 * Переход, предложенный карточке доски, вместе с приговором движка. Причина
 * отказа приезжает сюда целиком: недоступный переход остаётся в меню с
 * объяснением, а не исчезает из него.
 */
export type BoardTransitionOption = {
	toStageId: string;
	toStageName: string;
	kind: StageTransitionKind;
	/**
	 * Переход требует объяснения — его спрашивают перед командой. Возврат и
	 * пропуск требуют его всегда, шаг вперёд — если так настроен маршрут.
	 */
	requiresReason: boolean;
	allowed: boolean;
	reasons: string[];
};

/** Карточка доски: по чему дело узнают и из-за чего берутся за него сейчас. */
export type InteractionBoardCard = {
	id: string;
	title: string;
	/** Учебное заведение — основная сторона процесса. */
	organizationName: string | null;
	/** Программы и продукты взаимодействия: чем именно занимаемся. */
	offerings: string[];
	ownerName: string;
	stageId: string;
	dueAt: Date | null;
	state: BoardCardState;
	openBlockers: number;
	/** Переходы с текущей стадии в порядке стадий маршрута. */
	transitions: BoardTransitionOption[];
};

/** Колонка доски — стадия процесса вместе с тем, что на ней стоит. */
export type InteractionBoardColumn = {
	stageId: string;
	key: string;
	name: string;
	position: number;
	category: StageCategory;
	/** Сколько карточек стоит на стадии всего, а не сколько показано. */
	count: number;
	overdue: number;
	cards: InteractionBoardCard[];
};

/**
 * Доска: стадии действующего процесса одного пространства и карточки по ним.
 *
 * Выбора версии на доске нет: в пространстве действует ровно один процесс.
 * Пространство задаёт фильтр списка, а без фильтра берётся то, где у
 * смотрящего есть работа.
 */
export type InteractionBoardView = {
	/** Пространство, чьи стадии стали колонками; пусто — процесса нет. */
	workspaceId: string | null;
	workspaceKey: string | null;
	workspaceName: string | null;
	columns: InteractionBoardColumn[];
	/** Сколько карточек показано на доске. */
	total: number;
	/** Потолок карточек в колонке: столько их влезает на экран. */
	cardsPerColumn: number;
	/** Номер действующей редакции: с ним карточка доски отдаёт переход. */
	revision: number | null;
};

/**
 * Представление взаимодействия для публичного API: моменты времени — строки
 * ISO 8601, а не `Date`. Перевод описан явно, иначе формат ответа менялся бы
 * вместе с внутренним типом, о котором интегратор ничего не знает.
 */
export const apiInteractionSchema = z.object({
	id: z.uuid(),
	title: z.string(),
	status: z.enum(INTERACTION_STATUSES),
	ownerUserId: z.uuid(),
	ownerName: z.string(),
	institutionName: z.string().nullable().describe('Основное учебное заведение взаимодействия'),
	customerName: z.string().nullable().describe('Компания-заказчик, если она указана'),
	stageKey: z.string().nullable().describe('Ключ текущей стадии маршрута'),
	stageName: z.string().nullable(),
	stagePosition: z.number().int().nullable(),
	stageCategory: z.enum(STAGE_CATEGORIES).nullable(),
	dueAt: z.iso.datetime().nullable().describe('Срок текущей стадии с учётом пауз'),
	isOverdue: z.boolean(),
	isPaused: z.boolean(),
	isStale: z.boolean().describe('Вокруг записи тихо дольше, чем допускает стадия'),
	openBlockers: z.number().int().nonnegative(),
	lastActivityAt: z.iso.datetime()
});

export type ApiInteraction = z.output<typeof apiInteractionSchema>;

export function toApiInteraction(view: InteractionListItem): ApiInteraction {
	return {
		id: view.id,
		title: view.title,
		status: view.status,
		ownerUserId: view.ownerUserId,
		ownerName: view.ownerName,
		institutionName: view.institutionName,
		customerName: view.customerName,
		stageKey: view.stage?.key ?? null,
		stageName: view.stage?.name ?? null,
		stagePosition: view.stage?.position ?? null,
		stageCategory: view.stage?.category ?? null,
		dueAt: view.dueAt === null ? null : view.dueAt.toISOString(),
		isOverdue: view.isOverdue,
		isPaused: view.isPaused,
		isStale: view.isStale,
		openBlockers: view.openBlockers,
		lastActivityAt: view.lastActivityAt.toISOString()
	};
}

/**
 * Карточка взаимодействия для интегратора. Контактов людей здесь нет: их
 * отдаёт только интерфейс, где маскирование делает `toPersonView`.
 */
export const apiInteractionDetailSchema = apiInteractionSchema.extend({
	workspaceKey: z
		.string()
		.describe('Пространство: `b2b` — работа с учебными заведениями, `b2c` — обучение'),
	workspaceName: z.string(),
	processRevision: z
		.number()
		.int()
		.describe('Номер действующей редакции процесса: его требует команда перехода'),
	agreementPeriodStart: z.iso.date().nullable(),
	agreementPeriodEnd: z.iso.date().nullable(),
	academicPeriodStart: z.iso.date().nullable(),
	academicPeriodEnd: z.iso.date().nullable(),
	parties: z.array(
		z.object({
			organizationId: z.uuid(),
			organizationName: z.string(),
			partyRole: z.enum(PARTY_ROLES),
			isPrimary: z.boolean()
		})
	),
	programs: z.array(z.object({ programId: z.uuid(), code: z.string(), name: z.string() })),
	products: z.array(z.object({ productId: z.uuid(), code: z.string(), name: z.string() })),
	/**
	 * Договор контрагента и выбранные из него позиции; `null` — договор не
	 * выбран. Полный договор со всеми позициями отдаёт `GET /v1/contracts`.
	 */
	contract: z
		.object({
			id: z.uuid(),
			number: z.string(),
			status: z.enum(CONTRACT_STATUSES),
			signedOn: z.iso.date().nullable(),
			validUntil: z.iso.date().nullable(),
			items: z.array(
				z.object({
					id: z.uuid(),
					productId: z.uuid(),
					code: z.string(),
					name: z.string(),
					licenseSignedAt: z.iso.date().nullable(),
					licenseUntil: z.iso.date().nullable(),
					transferStatus: z.string().describe('Статус по передаче продукта вузу')
				})
			)
		})
		.nullable(),
	/** Стадии маршрута с состоянием каждой: пройдена, текущая, пропущена. */
	progress: z.array(
		z.object({
			key: z.string(),
			name: z.string(),
			position: z.number().int(),
			category: z.enum(STAGE_CATEGORIES),
			state: z.enum(STAGE_PROGRESS_STATES)
		})
	),
	externalSource: z.string().nullable(),
	externalId: z.string().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime()
});

export type ApiInteractionDetail = z.output<typeof apiInteractionDetailSchema>;

export function toApiInteractionDetail(
	view: InteractionView,
	status: InteractionStatusView,
	extra: { isStale: boolean; openBlockers: number }
): ApiInteractionDetail {
	const current = status.current;

	return {
		id: view.id,
		title: view.title,
		status: view.status,
		ownerUserId: view.ownerUserId,
		ownerName: view.ownerName,
		institutionName:
			view.parties.find((party) => party.partyRole === 'educational_institution')
				?.organizationName ?? null,
		customerName:
			view.parties.find((party) => party.partyRole === 'customer')?.organizationName ?? null,
		stageKey: current?.snapshot.key ?? null,
		stageName: current?.snapshot.name ?? null,
		stagePosition: current?.snapshot.position ?? null,
		stageCategory: current?.snapshot.category ?? null,
		dueAt: current?.dueAt.toISOString() ?? null,
		isOverdue: current?.isOverdue ?? false,
		isPaused: current?.isPaused ?? false,
		isStale: extra.isStale,
		openBlockers: extra.openBlockers,
		lastActivityAt: view.lastActivityAt.toISOString(),
		workspaceKey: view.workspaceKey,
		workspaceName: view.workspaceName,
		processRevision: status.revision,
		agreementPeriodStart: view.agreementPeriodStart,
		agreementPeriodEnd: view.agreementPeriodEnd,
		academicPeriodStart: view.academicPeriodStart,
		academicPeriodEnd: view.academicPeriodEnd,
		parties: view.parties.map((party) => ({
			organizationId: party.organizationId,
			organizationName: party.organizationName,
			partyRole: party.partyRole,
			isPrimary: party.isPrimary
		})),
		programs: view.programs.map((program) => ({
			programId: program.programId,
			code: program.code,
			name: program.name
		})),
		products: view.products.map((product) => ({
			productId: product.productId,
			code: product.code,
			name: product.name
		})),
		contract: view.contract,
		// Стадии процесса, а не путь дела: удалённая из процесса стадия в
		// ответе API не числится.
		progress: status.progress
			.filter((item) => !item.removed)
			.map((item) => ({
				key: item.key,
				name: item.name,
				position: item.position,
				category: item.category,
				state: item.state
			})),
		externalSource: view.externalSource,
		externalId: view.externalId,
		createdAt: view.createdAt.toISOString(),
		updatedAt: view.updatedAt.toISOString()
	};
}

/**
 * Переход по стадиям через API. Стадия, с которой отдана команда, обязательна:
 * сервер сверит её с открытой записью и откажет, если взаимодействие успели
 * сдвинуть, — иначе повторная попытка интеграции двигала бы процесс дальше.
 */
export const apiTransitionRequestSchema = z.object({
	kind: z.enum(STAGE_TRANSITION_KINDS, { error: 'Выберите вид перехода' }),
	fromStageId: id('Некорректный идентификатор стадии'),
	toStageId: id('Выберите стадию, на которую переходим'),
	/**
	 * Номер редакции процесса, по которой собрана команда (`processRevision` в
	 * карточке). Процесс группы могли изменить, пока интегратор готовил запрос:
	 * без номера команда выполнилась бы по правилам, которых уже нет.
	 */
	revision: revisionField,
	/**
	 * Обязательна для возврата и пропуска, а на шаге вперёд — если этого требует
	 * переход процесса.
	 */
	reason: optionalText(1000),
	resultText: optionalText(4000)
});

export type ApiTransitionRequest = z.output<typeof apiTransitionRequestSchema>;

/** Ответ на переход по стадиям: где взаимодействие оказалось. */
export const apiTransitionResultSchema = z.object({
	interactionId: z.uuid(),
	stageId: z.uuid(),
	stageKey: z.string().describe('Ключ стадии, на которой взаимодействие оказалось'),
	stageName: z.string(),
	stagePosition: z.number().int(),
	enteredAt: z.iso.datetime(),
	dueAt: z.iso.datetime()
});

export type ApiTransitionResult = z.output<typeof apiTransitionResultSchema>;

/**
 * Что предлагают выбрать в составе дела: действующие программы с их версиями
 * и действующие продукты. Версия программы — то, по какой её редакции идёт
 * работа; `null` в составе — «версия не закреплена».
 */
export type CompositionCatalog = {
	programs: {
		id: string;
		code: string;
		name: string;
		versions: { id: string; version: number; effectiveFrom: string }[];
	}[];
	products: { id: string; code: string; name: string }[];
};

/**
 * Организация школы для стороны «Оператор». Справочник может её не знать или
 * знать несколько: тогда предложить нечего, и причина говорится словами.
 */
export type CompositionOperator =
	{ state: 'configured'; id: string; name: string } | { state: 'unavailable'; reason: string };

/**
 * На каком основании обрабатываются данные физического лица, заведённого из
 * формы дела. Выбирает сотрудник: частный клиент либо дал согласие (заявка,
 * звонок, письмо), либо заключает договор-оферту — тот же выбор, что у заявки с
 * сайта и загрузки оплат. «Требование закона» к слушателю не относится.
 */
export const INDIVIDUAL_COUNTERPARTY_BASES = [
	'consent',
	'contract'
] as const satisfies readonly ConsentBasis[];

export type IndividualCounterpartyBasis = (typeof INDIVIDUAL_COUNTERPARTY_BASES)[number];

/**
 * Физическое лицо, заведённое из поля формы дела: ФИО, способ связи и
 * основание обработки. Почта обязательна — по ней, как и у заявки с сайта,
 * находится уже заведённый человек; основание обязательно — без него данные
 * человека лежали бы в системе ни на чём.
 */
export const individualCounterpartySchema = z.object({
	lastName: requiredText(100, 'Укажите фамилию'),
	firstName: requiredText(100, 'Укажите имя'),
	middleName: optionalText(100),
	email: z.email({ error: 'Электронная почта указана неверно' }),
	phone: optionalText(50).refine((value) => value === null || /^[\d\s+()-]{5,}$/.test(value), {
		error: 'Телефон может содержать только цифры, пробелы и знаки + ( ) -'
	}),
	basis: z.enum(INDIVIDUAL_COUNTERPARTY_BASES, {
		error: 'Выберите основание обработки персональных данных'
	})
});

export type IndividualCounterpartyInput = z.output<typeof individualCounterpartySchema>;
