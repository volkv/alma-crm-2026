/**
 * Взаимодействие с учебным заведением — центральная сущность процесса — и
 * команды, которыми его двигают по маршруту стадий.
 *
 * Маршрут описывает, какие стадии бывают и в каком порядке; взаимодействие
 * ссылается на конкретную опубликованную версию маршрута. Текущая стадия — это
 * открытая запись `stage_entries`, отдельного поля-кэша нет.
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
import type { PersonView } from './directory';

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
/** Куда ведёт переход: вперёд по маршруту, назад на доработку, мимо стадии. */
export const STAGE_TRANSITION_KINDS = ['forward', 'return', 'skip'] as const;
/** Состояние взаимодействия целиком. */
export const INTERACTION_STATUSES = ['active', 'completed', 'cancelled'] as const;
/** Кем организация участвует в конкретном взаимодействии. */
export const PARTY_ROLES = ['educational_institution', 'customer', 'operator'] as const;
/** Чем закончилось пребывание на стадии. */
export const STAGE_OUTCOMES = ['completed', 'returned', 'skipped'] as const;
/** Почему часы на стадии остановлены. */
export const PAUSE_REASONS = ['waiting_counterparty', 'waiting_internal', 'other'] as const;

export type StageCategory = (typeof STAGE_CATEGORIES)[number];
export type StageTransitionKind = (typeof STAGE_TRANSITION_KINDS)[number];
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];
export type PartyRole = (typeof PARTY_ROLES)[number];
export type StageOutcome = (typeof STAGE_OUTCOMES)[number];
export type PauseReason = (typeof PAUSE_REASONS)[number];

/** Пункт чек-листа стадии. `key` стабилен, по нему хранится отметка. */
export const checklistItemSchema = z.object({
	key: requiredText(100, 'У пункта чек-листа должен быть ключ'),
	label: requiredText(300, 'У пункта чек-листа должно быть название'),
	required: z.boolean().default(false)
});

export type ChecklistItem = z.output<typeof checklistItemSchema>;

/** Отметки по чек-листу: ключ пункта → выполнен или нет. */
export const checklistStateSchema = z.record(z.string(), z.boolean());

export type ChecklistState = z.output<typeof checklistStateSchema>;

/**
 * Слепок стадии на момент входа в неё. Хранится в записи о стадии, потому что
 * маршрут может быть переиздан новой версией, а сроки и чек-лист уже пройденной
 * стадии обязаны остаться такими, какими их видел исполнитель.
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
	checklist: z.array(checklistItemSchema)
});

export type StageSnapshot = z.output<typeof stageSnapshotSchema>;

/**
 * Чем подтверждён факт прохождения стадии: приложенным документом, отметкой
 * ответственного или записью во внешней системе обучения.
 */
export const stageConfirmationSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('file'), documentId: z.uuid() }),
	z.object({ kind: z.literal('mark'), byUserId: z.uuid(), at: z.iso.datetime({ offset: true }) }),
	z.object({
		kind: z.literal('lms_record'),
		source: z.string().min(1),
		recordId: z.string().min(1)
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
	/** Версия маршрута, по которой идёт это взаимодействие. */
	routeId: id('Выберите маршрут стадий'),
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
	});

export const updateInteractionSchema = createInteractionSchema.extend({
	id: id('Некорректный идентификатор взаимодействия'),
	/**
	 * Причина правки плана: попадает в предметную историю изменений, чтобы
	 * сдвиг сроков не выглядел как случайность.
	 */
	reason: optionalText(1000)
});

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

export const interactionListQuerySchema = z.object({
	status: z.enum(INTERACTION_STATUSES).nullable().default(null),
	ownerUserId: optionalId('Некорректный идентификатор ответственного'),
	organizationId: optionalId('Некорректный идентификатор организации'),
	/** Смысловая группа текущей стадии: «на каком участке процесса стоим». */
	stageCategory: z.enum(STAGE_CATEGORIES).nullable().default(null),
	/** Только просроченные: срок текущей стадии уже прошёл. */
	overdue: z
		.union([z.boolean(), z.enum(['true', 'false'])])
		.default(false)
		.transform((value) => value === true || value === 'true'),
	sort: z.enum(INTERACTION_SORTS).default('-lastActivityAt'),
	q: searchQuery,
	...pageQuerySchema.shape
});

/** Общая часть всех команд стадии: какое взаимодействие двигаем. */
const stageCommandFields = {
	interactionId: id('Некорректный идентификатор взаимодействия'),
	/**
	 * Стадия, с которой команда отдана. Сервер сверяет её с открытой записью и
	 * отказывает, если кто-то успел сдвинуть взаимодействие раньше.
	 */
	fromStageId: id('Некорректный идентификатор стадии')
};

export const advanceStageSchema = z.object({
	...stageCommandFields,
	toStageId: id('Выберите стадию, на которую переходим'),
	/** Результат стадии; обязателен, если стадия его требует. */
	resultText: optionalText(4000),
	checklistState: checklistStateSchema.default({})
});

export const returnStageSchema = z.object({
	...stageCommandFields,
	toStageId: id('Выберите стадию, на которую возвращаем'),
	reason: requiredText(1000, 'Опишите, почему взаимодействие возвращается назад')
});

export const skipStageSchema = z.object({
	...stageCommandFields,
	toStageId: id('Выберите стадию, на которую переходим'),
	reason: requiredText(1000, 'Опишите, почему стадия пропускается')
});

export const pauseStageSchema = z.object({
	...stageCommandFields,
	reason: z.enum(PAUSE_REASONS, { error: 'Выберите причину паузы' }),
	/** Кого ждём — участник взаимодействия, а не произвольная организация. */
	waitingPartyId: optionalId('Некорректный идентификатор участника'),
	nextAction: optionalText(1000),
	note: requiredText(1000, 'Опишите, чего ждём')
});

export const resumeStageSchema = z.object({
	...stageCommandFields,
	note: optionalText(1000)
});

export const confirmStageSchema = z.object({
	...stageCommandFields,
	/**
	 * Отметку исполнителя (`mark`) сервер дополняет автором и временем сам:
	 * клиент не может назначить, кто и когда подтвердил.
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
	interactionId: id('Некорректный идентификатор взаимодействия'),
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
	body: requiredText(4000, 'Комментарий не может быть пустым')
});

/** Отметка по одному пункту чек-листа текущей стадии. */
export const setChecklistItemSchema = z.object({
	interactionId: id('Некорректный идентификатор взаимодействия'),
	key: requiredText(100, 'Укажите пункт чек-листа'),
	done: z.boolean()
});

/** Результат текущей стадии — текстом, без перехода. */
export const setStageResultSchema = z.object({
	interactionId: id('Некорректный идентификатор взаимодействия'),
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
 */
export const completeInteractionSchema = z
	.object({
		interactionId: id('Некорректный идентификатор взаимодействия'),
		/** Чем всё кончилось; попадает в историю как исход последней стадии. */
		summary: optionalText(4000),
		/** Закрыть не с последней стадии маршрута — отступление от процесса. */
		force: z.boolean().default(false)
	})
	.refine((value) => !value.force || (value.summary ?? '').trim() !== '', {
		error: 'Досрочное закрытие нужно объяснить: опишите итог',
		path: ['summary']
	});

/** Отмена взаимодействия: причина обязательна на любой стадии. */
export const cancelInteractionSchema = z.object({
	interactionId: id('Некорректный идентификатор взаимодействия'),
	reason: requiredText(1000, 'Опишите, почему взаимодействие отменяется')
});

/**
 * Конфигурация маршрута: стадии и переходы между ними.
 *
 * Стадии и переходы адресуются ключами, а не идентификаторами: конфигурацию
 * пишут руками (демонстрационный маршрут — константа в коде), а идентификаторы
 * появляются только в базе.
 */
export const stageDefinitionSchema = z.object({
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
	checklist: z.array(checklistItemSchema).default([])
});

export const stageTransitionDefinitionSchema = z.object({
	fromStageKey: requiredText(100, 'Укажите стадию, с которой возможен переход'),
	toStageKey: requiredText(100, 'Укажите стадию, на которую ведёт переход'),
	kind: z.enum(STAGE_TRANSITION_KINDS, { error: 'Выберите вид перехода' }),
	/** Право, без которого переход недоступен. */
	requiredPermissionKey: requiredText(100, 'Укажите право, которое требует переход'),
	requiresReason: z.boolean().default(false)
});

type RouteDefinition = {
	stages: { key: string }[];
	transitions: { fromStageKey: string; toStageKey: string }[];
};

function stageKeysAreDistinct(value: RouteDefinition): boolean {
	return new Set(value.stages.map((stage) => stage.key)).size === value.stages.length;
}

function transitionsReferenceStages(value: RouteDefinition): boolean {
	const keys = new Set(value.stages.map((stage) => stage.key));

	return value.transitions.every(
		(transition) => keys.has(transition.fromStageKey) && keys.has(transition.toStageKey)
	);
}

function transitionsAreDistinct(value: RouteDefinition): boolean {
	const pairs = value.transitions.map(
		(transition) => `${transition.fromStageKey}→${transition.toStageKey}`
	);

	return new Set(pairs).size === pairs.length;
}

function transitionsGoSomewhereElse(value: RouteDefinition): boolean {
	return value.transitions.every((transition) => transition.fromStageKey !== transition.toStageKey);
}

export const createRouteSchema = z
	.object({
		key: requiredText(100, 'Укажите ключ маршрута'),
		name: requiredText(300, 'Укажите название маршрута'),
		description: optionalText(1000),
		/** Маршрут, который предлагается для новых взаимодействий. */
		isDefault: z.boolean().default(false),
		stages: z
			.array(stageDefinitionSchema)
			.min(1, { error: 'В маршруте должна быть хотя бы одна стадия' }),
		transitions: z.array(stageTransitionDefinitionSchema).default([])
	})
	.refine(stageKeysAreDistinct, { error: 'Ключи стадий не повторяются', path: ['stages'] })
	.refine(transitionsReferenceStages, {
		error: 'Переход ссылается на стадию, которой нет в маршруте',
		path: ['transitions']
	})
	.refine(transitionsAreDistinct, {
		error: 'Между двумя стадиями возможен только один переход',
		path: ['transitions']
	})
	.refine(transitionsGoSomewhereElse, {
		error: 'Переход не может вести на ту же стадию',
		path: ['transitions']
	});

export const updateRouteSchema = createRouteSchema.extend({
	id: id('Некорректный идентификатор маршрута')
});

export type CreateInteractionInput = z.output<typeof createInteractionSchema>;
export type UpdateInteractionInput = z.output<typeof updateInteractionSchema>;
export type InteractionListQuery = z.output<typeof interactionListQuerySchema>;
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
export type CreateRouteInput = z.output<typeof createRouteSchema>;
export type UpdateRouteInput = z.output<typeof updateRouteSchema>;

/**
 * Представления, которые сервер отдаёт наружу. Строки таблиц Drizzle за
 * границу сервера не выходят: тип ответа описан здесь и не меняется от того,
 * что происходит со схемой базы.
 */
export type StageView = {
	id: string;
	routeId: string;
	position: number;
	key: string;
	name: string;
	category: StageCategory;
	slaDays: number;
	staleAfterDays: number | null;
	requiresResult: boolean;
	requiresConfirmation: boolean;
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

export type StageRouteView = {
	id: string;
	key: string;
	version: number;
	name: string;
	description: string | null;
	isDefault: boolean;
	publishedAt: Date | null;
	stages: StageView[];
	transitions: StageTransitionView[];
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
	checklistState: ChecklistState;
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
	authorName: string;
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
	sites: { id: string; name: string }[];
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

/** Взаимодействие целиком — то, из чего собирается карточка. */
export type InteractionView = {
	id: string;
	title: string;
	status: InteractionStatus;
	routeId: string;
	routeName: string;
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
	parties: InteractionPartyView[];
	programs: InteractionProgramView[];
	products: InteractionProductView[];
	documents: InteractionDocumentView[];
};

/** Документ взаимодействия в списке карточки: только то, что видно в строке. */
export type InteractionDocumentView = {
	id: string;
	kind: string;
	title: string;
	mime: string;
	sizeBytes: number;
	createdAt: Date;
	agreedAt: Date | null;
	approvedAt: Date | null;
	inEffectAt: Date | null;
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
	routeId: string;
	current: StageEntryView | null;
	history: StageEntryView[];
	progress: StageProgressItem[];
	blockers: BlockerView[];
	isStale: boolean;
	lastActivityAt: Date;
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
	customerName: z.string().nullable().describe('Заказчик подготовки, если он указан'),
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
	routeId: z.uuid(),
	routeName: z.string(),
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
		routeId: view.routeId,
		routeName: view.routeName,
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
		progress: status.progress.map((item) => ({
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
	/** Обязательна для возврата и пропуска. */
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
