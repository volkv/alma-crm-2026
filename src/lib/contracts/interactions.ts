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

export const interactionListQuerySchema = z.object({
	status: z.enum(INTERACTION_STATUSES).nullable().default(null),
	ownerUserId: optionalId('Некорректный идентификатор ответственного'),
	organizationId: optionalId('Некорректный идентификатор организации'),
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
