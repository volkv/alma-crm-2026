/**
 * Контракт публичного API.
 *
 * Здесь то, что видит интегратор: конверт ошибки, конверт страницы, ключи
 * доступа и представления записей в том виде, в каком они уезжают в JSON.
 * Внутренние представления (`OrganizationView` и прочие) отличаются от них
 * типами: в сервисах момент времени — это `Date`, а в JSON — строка ISO 8601.
 * Перевод делается здесь явно, иначе формат ответа менялся бы вместе с
 * внутренним типом, о котором интегратор ничего не знает.
 *
 * Серверных импортов в файле нет: те же схемы читает браузер и по ним же
 * собирается OpenAPI.
 */
import { z } from 'zod';
import { id, requiredText } from './common';
import {
	AFFILIATION_ROLE_KINDS,
	EDUCATION_LEVELS,
	LIFECYCLE_STATUSES,
	ORGANIZATION_KINDS,
	PROGRAM_LEVELS,
	type AffiliationView,
	type ContractView,
	type OrganizationView,
	type PersonListItem,
	type PersonView,
	type ProductDetail,
	type ProgramDetail
} from './directory';
import {
	DOCUMENT_KINDS,
	DOCUMENT_STATUS_FACTS,
	type DocumentListItem,
	type DocumentView
} from './documents';
import {
	EXCHANGE_DIRECTIONS,
	EXCHANGE_MESSAGE_STATES,
	LEARNING_PURPOSES,
	LEARNING_TRAINING_STATES,
	type ExchangeMessageView,
	type LearningGroupView
} from './exchange';
import {
	checklistItemSchema,
	CONTRACT_STATUSES,
	STAGE_CATEGORIES,
	STAGE_ENTER_NOTIFY_TARGETS,
	STAGE_OUTCOMES,
	STAGE_TRANSITION_KINDS,
	type CommentView,
	type InteractionChangeView,
	type InteractionStatusView,
	type ProcessRevisionView,
	type WorkflowDetail,
	type WorkspaceMembership,
	type WorkspaceSummary,
	type StageEntryView
} from './interactions';
import { REPORT_MODES, type ReportBucket, type ReportView } from './reports';

/**
 * Коды ошибок API. Первые четыре повторяют коды предметных ошибок
 * (`$lib/server/errors`), остальные описывают то, что случилось в транспорте и
 * до сервиса не дошло.
 */
export const API_ERROR_CODES = [
	'validation',
	'forbidden',
	'not_found',
	'conflict',
	'unauthorized',
	'rate_limited',
	'idempotency_mismatch',
	'internal'
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Тело любого неуспешного ответа. `requestId` тот же, что в заголовке
 * `x-request-id`: по нему обращение интегратора находится в журнале и в логе
 * одной строкой. Ни стека, ни текста SQL здесь не бывает.
 */
export const apiErrorSchema = z.object({
	error: z.object({
		code: z.enum(API_ERROR_CODES),
		message: z.string(),
		requestId: z.string(),
		/** Разбор по полям у ошибок проверки и подсказки у остальных. */
		details: z.record(z.string(), z.unknown()).optional()
	})
});

export type ApiErrorBody = z.output<typeof apiErrorSchema>;

/**
 * Страница результатов. Поля те же, что у внутреннего `PageResult`, и имена
 * параметров запроса те же, что у `pageQuerySchema` (`page`, `pageSize`):
 * второй словарь для одного и того же понятия — это способ однажды разойтись.
 */
export function apiPageSchema<TItem extends z.ZodType>(item: TItem) {
	return apiCollectionSchema(item).extend({
		page: z.number().int().min(1).describe('Номер выданной страницы, с единицы'),
		pageSize: z.number().int().min(1).describe('Размер страницы')
	});
}

/**
 * Набор целиком — то, что страницами не режется: короткий справочник или всё,
 * что относится к одной записи. Поля те же, что у страницы, минус номер и
 * размер: их отсутствие и есть обещание «это весь ответ».
 */
export function apiCollectionSchema<TItem extends z.ZodType>(item: TItem) {
	return z.object({
		items: z.array(item),
		total: z.number().int().nonnegative().describe('Сколько записей под фильтром всего')
	});
}

export const apiOrganizationSchema = z.object({
	id: z.uuid(),
	kind: z.enum(ORGANIZATION_KINDS).describe('Вуз, компания-заказчик или оператор'),
	educationLevel: z
		.enum(EDUCATION_LEVELS)
		.nullable()
		.describe('Уровень образования; заполнен только у учебных заведений'),
	legalName: z.string(),
	shortName: z.string(),
	inn: z.string().nullable(),
	kpp: z.string().nullable(),
	ogrn: z.string().nullable(),
	region: z.string().nullable(),
	website: z.string().nullable(),
	notes: z.string().nullable(),
	isActive: z.boolean(),
	externalSource: z.string().nullable().describe('Система, из которой приехала запись'),
	externalId: z.string().nullable().describe('Идентификатор записи в этой системе'),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime()
});

export type ApiOrganization = z.output<typeof apiOrganizationSchema>;

export function toApiOrganization(view: OrganizationView): ApiOrganization {
	return {
		...view,
		createdAt: view.createdAt.toISOString(),
		updatedAt: view.updatedAt.toISOString()
	};
}

/**
 * Справочник образовательных программ. Область доступа к нему не применяется:
 * программа — общий каталог оператора, а не имущество отдельного вуза.
 */
export const apiProgramSchema = z.object({
	id: z.uuid(),
	code: z.string().describe('Код программы в каталоге оператора'),
	name: z.string(),
	level: z.enum(PROGRAM_LEVELS),
	directionCode: z.string().nullable().describe('Код направления подготовки, например `09.03.01`'),
	priority: z
		.number()
		.int()
		.nullable()
		.describe('Ручной приоритет показа: 1 — самая важная программа, `null` — не назначен'),
	status: z.enum(LIFECYCLE_STATUSES)
});

export type ApiProgram = z.output<typeof apiProgramSchema>;

/** Программа вместе с историей версий: что менялось и с какого дня действует. */
export const apiProgramDetailSchema = apiProgramSchema.extend({
	versions: z
		.array(
			z.object({
				id: z.uuid(),
				version: z.number().int(),
				summary: z.string(),
				effectiveFrom: z.iso.date(),
				createdAt: z.iso.datetime()
			})
		)
		.describe('Версии программы, свежие сверху')
});

export type ApiProgramDetail = z.output<typeof apiProgramDetailSchema>;

export function toApiProgramDetail(detail: ProgramDetail): ApiProgramDetail {
	return {
		...detail.program,
		versions: detail.versions.map((version) => ({
			id: version.id,
			version: version.version,
			summary: version.summary,
			effectiveFrom: version.effectiveFrom,
			createdAt: version.createdAt.toISOString()
		}))
	};
}

/** Продукт оператора: то, что предлагают вузу. */
export const apiProductSchema = z.object({
	id: z.uuid(),
	code: z.string(),
	name: z.string(),
	vendorOrganizationId: z.uuid().nullable().describe('Вендор продукта — организация справочника'),
	description: z.string().nullable(),
	status: z.enum(LIFECYCLE_STATUSES)
});

export type ApiProduct = z.output<typeof apiProductSchema>;

/** Продукт вместе с названием вендора — так его показывает карточка. */
export const apiProductDetailSchema = apiProductSchema.extend({
	vendorName: z.string().nullable().describe('Краткое наименование вендора; `null` — не указан')
});

export type ApiProductDetail = z.output<typeof apiProductDetailSchema>;

export function toApiProductDetail(detail: ProductDetail): ApiProductDetail {
	return { ...detail.product, vendorName: detail.vendor?.label ?? null };
}

/**
 * Человек справочника. Контакты отдаются открыто только тогда, когда у
 * владельца ключа есть право `people.read_pii`; иначе они замаскированы, и
 * `contactsMasked` говорит, что «i***@vuz.ru» — это маска, а не адрес.
 */
export const apiPersonSchema = z.object({
	id: z.uuid(),
	lastName: z.string(),
	firstName: z.string(),
	middleName: z.string().nullable(),
	email: z.string().nullable(),
	phone: z.string().nullable(),
	notes: z.string().nullable(),
	contactsMasked: z
		.boolean()
		.describe('Почта и телефон замаскированы: у владельца ключа нет права видеть их'),
	retentionUntil: z.iso
		.date()
		.nullable()
		.describe('До какого дня хранятся данные; `null` — срок не назначен'),
	anonymizedAt: z.iso
		.datetime()
		.nullable()
		.describe('Когда данные обезличены; обезличивание необратимо')
});

export type ApiPerson = z.output<typeof apiPersonSchema>;

export function toApiPerson(view: PersonView): ApiPerson {
	return {
		...view,
		anonymizedAt: view.anonymizedAt === null ? null : view.anonymizedAt.toISOString()
	};
}

/** Строка списка людей: сам человек и организации, где у него есть роль. */
export const apiPersonListItemSchema = apiPersonSchema.extend({
	organizations: z
		.array(z.object({ id: z.uuid(), shortName: z.string() }))
		.describe('Организации в области доступа владельца ключа, где у человека есть роль'),
	retentionExpired: z.boolean().describe('Срок хранения назначен и прошёл')
});

export type ApiPersonListItem = z.output<typeof apiPersonListItemSchema>;

export function toApiPersonListItem(item: PersonListItem): ApiPersonListItem {
	return {
		...toApiPerson(item.person),
		organizations: item.organizations.map((option) => ({
			id: option.id,
			shortName: option.label
		})),
		retentionExpired: item.retentionExpired
	};
}

/**
 * Контакт организации — роль человека в ней: должность, период полномочий и
 * канал связи. Человек один, ролей у него может быть несколько.
 */
export const apiContactSchema = z.object({
	id: z.uuid().describe('Идентификатор роли'),
	person: apiPersonSchema,
	organizationId: z.uuid(),
	siteId: z.uuid().nullable().describe('Площадка организации; `null` — организация целиком'),
	position: z.string(),
	roleKind: z.enum(AFFILIATION_ROLE_KINDS),
	isPrimary: z.boolean().describe('Основной контакт организации по процессу'),
	validFrom: z.iso.date(),
	validTo: z.iso.date().nullable().describe('Конец полномочий; `null` — действуют'),
	channel: z.string().nullable().describe('Как договорились общаться')
});

export type ApiContact = z.output<typeof apiContactSchema>;

export function toApiContact(view: AffiliationView): ApiContact {
	return { ...view, person: toApiPerson(view.person) };
}

/**
 * Ответственный за вуз: пользователь, направление и период. Назначения не
 * удаляются, а закрываются, поэтому в списке есть и история.
 */
export const apiResponsibleSchema = z.object({
	id: z.uuid(),
	userId: z.uuid(),
	userFullName: z.string(),
	directionId: z
		.uuid()
		.nullable()
		.describe('ИТ-направление; `null` — ответственный за вуз целиком'),
	directionName: z.string().nullable(),
	validFrom: z.iso.datetime(),
	validTo: z.iso.datetime().nullable().describe('`null` — назначение действует'),
	assignedByFullName: z.string().nullable()
});

export type ApiResponsible = z.output<typeof apiResponsibleSchema>;

export function toApiResponsible(
	view: Omit<ApiResponsible, 'validFrom' | 'validTo'> & { validFrom: Date; validTo: Date | null }
): ApiResponsible {
	return {
		...view,
		validFrom: view.validFrom.toISOString(),
		validTo: view.validTo === null ? null : view.validTo.toISOString()
	};
}

/** Назначение ответственного за вуз. */
export const apiAssignResponsibleRequestSchema = z.object({
	userId: id('Некорректный идентификатор сотрудника'),
	directionId: id('Некорректный идентификатор направления')
		.nullable()
		.default(null)
		.describe('ИТ-направление; `null` — за вуз целиком'),
	transferInteractions: z
		.boolean()
		.default(false)
		.describe(
			'Передать новому ответственному незавершённые взаимодействия прежнего; требует права ' +
				'`interactions.reassign`'
		)
});

export type ApiAssignResponsibleRequest = z.output<typeof apiAssignResponsibleRequestSchema>;

/** ИТ-направление: разрез работы, по которому назначают ответственных. */
export const apiDirectionSchema = z.object({
	id: z.uuid(),
	name: z.string()
});

export type ApiDirection = z.output<typeof apiDirectionSchema>;

/**
 * Договор контрагента вместе со всеми своими позициями.
 *
 * Областью доступа список сужается, в отличие от каталогов: договор — это
 * обязательство с конкретным вузом, и видит его тот, кто видит сам вуз.
 * Взаимодействие выбирает из этих позиций своё подмножество и отдаёт его в
 * карточке (`GET /v1/interactions/{id}`).
 */
export const apiContractSchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid().describe('Контрагент, с которым заключён договор'),
	number: z.string(),
	signedOn: z.iso.date().nullable(),
	validUntil: z.iso.date().nullable(),
	status: z.enum(CONTRACT_STATUSES).describe('`draft` — черновик, `active` — действует, `closed`'),
	items: z.array(
		z.object({
			id: z.uuid(),
			productId: z.uuid(),
			productCode: z.string(),
			productName: z.string(),
			licenseSignedAt: z.iso.date().nullable(),
			licenseUntil: z.iso.date().nullable(),
			transferStatus: z
				.string()
				.describe('Статус по передаче продукта вузу; словарь свободный, значения из данных')
		})
	),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime()
});

export type ApiContract = z.output<typeof apiContractSchema>;

export function toApiContract(view: ContractView): ApiContract {
	return {
		...view,
		createdAt: view.createdAt.toISOString(),
		updatedAt: view.updatedAt.toISOString()
	};
}

/**
 * Запись о пребывании взаимодействия на стадии. Стадия названа ключом и
 * именем из снимка, а не ссылкой на строку процесса: процесс могли изменить, а
 * пройденная стадия обязана остаться такой, какой её видел исполнитель.
 */
export const apiStageEntrySchema = z.object({
	id: z.uuid(),
	stageKey: z.string().describe('Ключ стадии из снимка на момент входа'),
	stageName: z.string(),
	stagePosition: z.number().int(),
	stageCategory: z.enum(STAGE_CATEGORIES),
	enteredAt: z.iso.datetime(),
	leftAt: z.iso.datetime().nullable().describe('Когда стадию покинули; `null` — стадия текущая'),
	outcome: z.enum(STAGE_OUTCOMES).nullable().describe('Чем кончилось пребывание на стадии'),
	outcomeReason: z.string().nullable(),
	responsibleUserId: z.uuid().nullable(),
	responsibleName: z.string().nullable(),
	resultText: z.string().nullable(),
	confirmedAt: z.iso.datetime().nullable(),
	dueAt: z.iso.datetime().describe('Срок стадии с учётом пауз'),
	activeSeconds: z.number().describe('Сколько секунд стадия шла без пауз'),
	pausedSeconds: z.number(),
	overdueSeconds: z.number(),
	isOverdue: z.boolean(),
	isPaused: z.boolean(),
	documentIds: z.array(z.uuid()).describe('Файлы, приложенные вместе с переходом')
});

export type ApiStageEntry = z.output<typeof apiStageEntrySchema>;

export function toApiStageEntry(view: StageEntryView): ApiStageEntry {
	return {
		id: view.id,
		stageKey: view.snapshot.key,
		stageName: view.snapshot.name,
		stagePosition: view.snapshot.position,
		stageCategory: view.snapshot.category,
		enteredAt: view.enteredAt.toISOString(),
		leftAt: view.leftAt === null ? null : view.leftAt.toISOString(),
		outcome: view.outcome,
		outcomeReason: view.outcomeReason,
		responsibleUserId: view.responsibleUserId,
		responsibleName: view.responsibleName,
		resultText: view.resultText,
		confirmedAt: view.confirmedAt === null ? null : view.confirmedAt.toISOString(),
		dueAt: view.dueAt.toISOString(),
		activeSeconds: view.activeSeconds,
		pausedSeconds: view.pausedSeconds,
		overdueSeconds: view.overdueSeconds,
		isOverdue: view.isOverdue,
		isPaused: view.isPaused,
		documentIds: view.documents.map((document) => document.id)
	};
}

/**
 * Изменение плана взаимодействия: сроки, стороны, программы, ответственный.
 * Значения приходят такими, какими их записали, — это снимок поля, а не текст
 * для показа.
 */
export const apiInteractionChangeSchema = z.object({
	id: z.uuid(),
	changedAt: z.iso.datetime(),
	authorId: z.uuid(),
	authorName: z.string(),
	field: z.string().describe('Что изменилось: `title`, `ownerUserId`, `parties` и прочее'),
	oldValue: z.unknown(),
	newValue: z.unknown(),
	reason: z.string().nullable()
});

export type ApiInteractionChange = z.output<typeof apiInteractionChangeSchema>;

export function toApiInteractionChange(view: InteractionChangeView): ApiInteractionChange {
	return {
		id: view.id,
		changedAt: view.changedAt.toISOString(),
		authorId: view.authorId,
		authorName: view.authorName,
		field: view.field,
		oldValue: view.oldValue,
		newValue: view.newValue,
		reason: view.reason
	};
}

/**
 * История взаимодействия целиком: где оно стояло и что в нём правили. Обе
 * ленты отдаются одним ответом, потому что вопрос «что здесь происходило»
 * один, а собирать его из двух запросов интегратору незачем.
 */
export const apiInteractionHistorySchema = z.object({
	interactionId: z.uuid(),
	processRevision: z.number().int().describe('Номер действующей редакции процесса'),
	current: apiStageEntrySchema
		.nullable()
		.describe('Открытая запись стадии; `null` — запись закрыта'),
	stages: z.array(apiStageEntrySchema).describe('Пройденные стадии, новые сверху'),
	changes: z.array(apiInteractionChangeSchema).describe('Изменения плана, новые сверху')
});

export type ApiInteractionHistory = z.output<typeof apiInteractionHistorySchema>;

export function toApiInteractionHistory(
	status: InteractionStatusView,
	changes: readonly InteractionChangeView[]
): ApiInteractionHistory {
	return {
		interactionId: status.interactionId,
		processRevision: status.revision,
		current: status.current === null ? null : toApiStageEntry(status.current),
		stages: status.history.map(toApiStageEntry),
		changes: changes.map(toApiInteractionChange)
	};
}

/** Комментарий сотрудника к взаимодействию. */
export const apiCommentSchema = z.object({
	id: z.uuid(),
	authorId: z.uuid(),
	authorName: z.string(),
	body: z.string(),
	createdAt: z.iso.datetime()
});

export type ApiComment = z.output<typeof apiCommentSchema>;

export function toApiComment(view: CommentView): ApiComment {
	return {
		id: view.id,
		authorId: view.authorId,
		authorName: view.authorName,
		body: view.body,
		createdAt: view.createdAt.toISOString()
	};
}

/**
 * Комментарий через API. Взаимодействие берётся из адреса, автор — владелец
 * ключа: указывать автора телом значило бы позволить машине писать от чужого
 * имени.
 */
export const apiCommentRequestSchema = z.object({
	body: requiredText(4000, 'Комментарий не может быть пустым')
});

export type ApiCommentRequest = z.output<typeof apiCommentRequestSchema>;

/**
 * Ответ на созданный комментарий. Кроме идентификатора отдавать нечего: тело и
 * автор известны вызывающему, а момент создания он и так увидит в ленте.
 */
export const apiCommentCreatedSchema = z.object({
	id: z.uuid().describe('Идентификатор созданного комментария')
});

export type ApiCommentCreated = z.output<typeof apiCommentCreatedSchema>;

/**
 * Метаданные документа. Содержимого файла здесь нет и не будет: API описывает
 * работу с вузами, а файлы соглашений скачивают люди из интерфейса, где каждое
 * скачивание попадает в журнал отдельной строкой.
 */
export const apiDocumentSchema = z.object({
	id: z.uuid(),
	title: z.string(),
	kind: z
		.enum(DOCUMENT_KINDS)
		.describe('`generated` — собран системой, `uploaded` — загружен человеком'),
	uploadedKind: z.string().nullable().describe('Вид, который назвал человек при загрузке'),
	mime: z.string(),
	sizeBytes: z.number().int().nonnegative(),
	createdAt: z.iso.datetime(),
	agreedAt: z.iso.datetime().nullable(),
	approvedAt: z.iso.datetime().nullable(),
	inEffectAt: z.iso.datetime().nullable(),
	interactionId: z.uuid().nullable(),
	authorName: z.string().nullable(),
	supersededById: z.uuid().nullable().describe('Редакция, заменившая этот файл'),
	supersededAt: z.iso.datetime().nullable()
});

export type ApiDocument = z.output<typeof apiDocumentSchema>;

export function toApiDocument(view: DocumentListItem): ApiDocument {
	return {
		id: view.id,
		title: view.title,
		kind: view.kind,
		uploadedKind: view.uploadedKind,
		mime: view.mime,
		sizeBytes: view.sizeBytes,
		createdAt: view.createdAt.toISOString(),
		agreedAt: view.agreedAt === null ? null : view.agreedAt.toISOString(),
		approvedAt: view.approvedAt === null ? null : view.approvedAt.toISOString(),
		inEffectAt: view.inEffectAt === null ? null : view.inEffectAt.toISOString(),
		interactionId: view.interaction === null ? null : view.interaction.id,
		authorName: view.authorName,
		supersededById: view.supersededBy === null ? null : view.supersededBy.id,
		supersededAt: view.supersededBy === null ? null : view.supersededBy.createdAt.toISOString()
	};
}

/**
 * Отметки документа после команды: три независимых факта и их даты. Ответ
 * описывает документ целиком, а не поставленную отметку, — по нему видно и то,
 * что на документе стояло раньше, и второй запрос за этим не нужен.
 */
export const apiDocumentMarksSchema = z.object({
	id: z.uuid(),
	title: z.string(),
	interactionId: z.uuid().nullable(),
	agreedAt: z.iso.datetime().nullable().describe('Согласован'),
	approvedAt: z.iso.datetime().nullable().describe('Утверждён'),
	inEffectAt: z.iso.datetime().nullable().describe('Введён в действие'),
	agreedNote: z.string().nullable().describe('Комментарий к отметке о согласовании'),
	approvedNote: z.string().nullable().describe('Комментарий к отметке об утверждении'),
	inEffectNote: z.string().nullable().describe('Комментарий к отметке о введении в действие')
});

export type ApiDocumentMarks = z.output<typeof apiDocumentMarksSchema>;

export function toApiDocumentMarks(view: DocumentView): ApiDocumentMarks {
	return {
		id: view.id,
		title: view.title,
		interactionId: view.interactionId,
		agreedAt: view.agreedAt === null ? null : view.agreedAt.toISOString(),
		approvedAt: view.approvedAt === null ? null : view.approvedAt.toISOString(),
		inEffectAt: view.inEffectAt === null ? null : view.inEffectAt.toISOString(),
		agreedNote: view.agreedNote,
		approvedNote: view.approvedNote,
		inEffectNote: view.inEffectNote
	};
}

/** Учебная группа взаимодействия вместе с последним результатом из LMS. */
export const apiLearningGroupSchema = z.object({
	id: z.uuid(),
	streamNumber: z.number().int().describe('Номер потока внутри взаимодействия'),
	system: z.string(),
	instance: z.string().describe('Экземпляр подключения, в который ушла заявка'),
	groupExternalId: z
		.string()
		.nullable()
		.describe('Идентификатор группы на стороне системы обучения'),
	requestedAt: z.iso.datetime(),
	plannedSeats: z.number().int().nullable(),
	startsOn: z.iso.date().nullable(),
	endsOn: z.iso.date().nullable(),
	lastResultAt: z.iso.datetime().nullable(),
	messageState: z
		.enum(EXCHANGE_MESSAGE_STATES)
		.nullable()
		.describe('Состояние заявки на группу в журнале обмена'),
	lastError: z.string().nullable(),
	enrolled: z.number().int().nullable(),
	completed: z.number().int().nullable(),
	expelled: z.number().int().nullable(),
	finishedOn: z.iso.date().nullable().describe('Дата окончания обучения из последнего результата'),
	program: z
		.object({ id: z.uuid(), code: z.string(), name: z.string() })
		.nullable()
		.describe('Программа, закреплённая за группой при заявке'),
	products: z
		.array(z.object({ id: z.uuid(), code: z.string(), name: z.string() }))
		.describe('Продукты группы — подмножество продуктов взаимодействия'),
	purpose: z.enum(LEARNING_PURPOSES).nullable().describe('Для кого обучение'),
	trainingState: z
		.enum(LEARNING_TRAINING_STATES)
		.describe(
			'`awaiting` — результатов нет, `in_progress` — данные получены, итога нет, `completed` — итоговый результат или отметка сотрудника'
		),
	completionMark: z
		.object({ at: z.iso.datetime(), byName: z.string().nullable(), comment: z.string() })
		.nullable()
		.describe('Отметка сотрудника «обучение завершено»'),
	countsForStage: z
		.boolean()
		.describe('Засчитывается ли группа стадии: её программа входит в программы взаимодействия')
});

export type ApiLearningGroup = z.output<typeof apiLearningGroupSchema>;

export function toApiLearningGroup(view: LearningGroupView): ApiLearningGroup {
	return {
		id: view.id,
		streamNumber: view.streamNumber,
		system: view.system,
		instance: view.instance,
		groupExternalId: view.groupExternalId,
		requestedAt: view.requestedAt.toISOString(),
		plannedSeats: view.plannedSeats,
		startsOn: view.startsOn,
		endsOn: view.endsOn,
		lastResultAt: view.lastResultAt === null ? null : view.lastResultAt.toISOString(),
		messageState: view.messageState,
		lastError: view.lastError,
		enrolled: view.enrolled,
		completed: view.completed,
		expelled: view.expelled,
		finishedOn: view.finishedOn,
		program: view.program,
		products: view.products,
		purpose: view.purpose,
		trainingState: view.trainingState,
		completionMark:
			view.completionMark === null
				? null
				: {
						at: view.completionMark.at.toISOString(),
						byName: view.completionMark.byName,
						comment: view.completionMark.comment
					},
		countsForStage: view.countsForStage
	};
}

/** Пространство: рабочее место направления и процесс, по которому оно идёт. */
export const apiWorkspaceSchema = z.object({
	id: z.uuid(),
	key: z
		.string()
		.describe('Ключ пространства: `b2b` — работа с учебными заведениями, `b2c` — обучение'),
	name: z.string(),
	description: z.string().nullable(),
	position: z.number().int(),
	stageCount: z.number().int().describe('Сколько стадий в действующей редакции'),
	activeInteractions: z.number().int(),
	hasDraft: z.boolean().describe('У пространства есть неопубликованный черновик процесса')
});

export type ApiWorkspace = z.output<typeof apiWorkspaceSchema>;

/** Стадия действующего процесса вместе с правилами, которые она требует. */
export const apiProcessStageSchema = z.object({
	id: z.uuid().describe('Идентификатор стадии; им же адресуется переход'),
	key: z.string().describe('Ключ стадии: он переживает изменение процесса, идентификатор — нет'),
	name: z.string(),
	position: z.number().int(),
	category: z.enum(STAGE_CATEGORIES),
	slaDays: z.number().int(),
	staleAfterDays: z.number().int().nullable(),
	requiresResult: z.boolean(),
	requiresConfirmation: z.boolean(),
	requiresLmsData: z.boolean().describe('Стадия подтверждается фактом из системы обучения'),
	requiresDocumentMark: z
		.enum(DOCUMENT_STATUS_FACTS)
		.nullable()
		.describe('Отметка по документу дела, которой подтверждается стадия; `null` — не требуется'),
	onEnterNotify: z
		.enum(STAGE_ENTER_NOTIFY_TARGETS)
		.nullable()
		.describe(
			'Кого система уведомляет, когда дело входит на стадию: ответственного или его руководителя; `null` — никого'
		),
	isFinal: z.boolean(),
	checklist: z.array(checklistItemSchema)
});

export type ApiProcessStage = z.output<typeof apiProcessStageSchema>;

/** Разрешённый переход действующего процесса. */
export const apiProcessTransitionSchema = z.object({
	fromStageId: z.uuid(),
	toStageId: z.uuid(),
	kind: z.enum(STAGE_TRANSITION_KINDS),
	requiredPermissionKey: z.string().describe('Право, без которого переход недоступен'),
	requiresReason: z.boolean()
});

export type ApiProcessTransition = z.output<typeof apiProcessTransitionSchema>;

/** Редакция процесса: стадии и разрешённые переходы между ними. */
export const apiProcessRevisionSchema = z.object({
	version: z.number().int(),
	name: z.string(),
	note: z.string().nullable(),
	publishedAt: z.iso.datetime().nullable().describe('`null` — черновик, ещё не применён'),
	stages: z.array(apiProcessStageSchema),
	transitions: z.array(apiProcessTransitionSchema)
});

export type ApiProcessRevision = z.output<typeof apiProcessRevisionSchema>;

export function toApiProcessRevision(revision: ProcessRevisionView): ApiProcessRevision {
	return {
		version: revision.version,
		name: revision.name,
		note: revision.note,
		publishedAt: revision.publishedAt === null ? null : revision.publishedAt.toISOString(),
		stages: revision.stages.map((stage) => ({
			id: stage.id,
			key: stage.key,
			name: stage.name,
			position: stage.position,
			category: stage.category,
			slaDays: stage.slaDays,
			staleAfterDays: stage.staleAfterDays,
			requiresResult: stage.requiresResult,
			requiresConfirmation: stage.requiresConfirmation,
			requiresLmsData: stage.requiresLmsData,
			requiresDocumentMark: stage.requiresDocumentMark,
			onEnterNotify: stage.onEnterNotify,
			isFinal: stage.isFinal,
			checklist: stage.checklist
		})),
		transitions: revision.transitions.map((transition) => ({
			fromStageId: transition.fromStageId,
			toStageId: transition.toStageId,
			kind: transition.kind,
			requiredPermissionKey: transition.requiredPermissionKey,
			requiresReason: transition.requiresReason
		}))
	};
}

/**
 * Действующий процесс пространства. Черновик и его замечания сюда не входят:
 * интеграция работает по опубликованному маршруту, а незавершённая настройка —
 * дело сотрудника, а не внешней системы.
 */
export const apiProcessSchema = z.object({
	workspace: apiWorkspaceSchema,
	revision: apiProcessRevisionSchema
		.nullable()
		.describe('Действующая редакция; `null` — процесс пространства не заведён')
});

export type ApiProcess = z.output<typeof apiProcessSchema>;

export function toApiProcess(
	workspace: WorkspaceSummary,
	active: ProcessRevisionView | null
): ApiProcess {
	return { workspace, revision: active === null ? null : toApiProcessRevision(active) };
}

/** Состав пространства: кто в нём работает и за сколько незавершённых записей отвечает. */
export const apiWorkspaceMembersSchema = z.object({
	workspace: z.object({ id: z.uuid(), key: z.string(), name: z.string() }),
	members: z.array(
		z.object({
			userId: z.uuid(),
			fullName: z.string(),
			roleName: z.string(),
			isActive: z.boolean(),
			since: z.iso.datetime().describe('С какого момента сотрудник в пространстве'),
			ownedActive: z
				.number()
				.int()
				.describe('За сколько незавершённых взаимодействий пространства он отвечает')
		})
	)
});

export type ApiWorkspaceMembers = z.output<typeof apiWorkspaceMembersSchema>;

export function toApiWorkspaceMembers(membership: WorkspaceMembership): ApiWorkspaceMembers {
	return {
		workspace: { id: membership.id, key: membership.key, name: membership.name },
		members: membership.members.map((member) => ({
			...member,
			since: member.since.toISOString()
		}))
	};
}

/** Процесс — описание работы, которое назначают одному или нескольким пространствам. */
export const apiWorkflowSchema = z.object({
	id: z.uuid(),
	key: z.string().describe('Ключ процесса; им процесс адресуется в пути'),
	name: z.string(),
	description: z.string().nullable(),
	stageCount: z.number().int().describe('Сколько стадий в действующей редакции'),
	workspaces: z.number().int().describe('Скольким пространствам процесс назначен'),
	activeInteractions: z.number().int().describe('Незавершённых взаимодействий во всех них'),
	hasDraft: z.boolean().describe('Есть неопубликованный черновик')
});

export type ApiWorkflow = z.output<typeof apiWorkflowSchema>;

/**
 * Процесс целиком: действующая редакция, черновик и то, что мешает его
 * применить. Это взгляд настройщика, а не исполнителя: внешней системе, которая
 * двигает взаимодействия, нужен `GET /v1/workspaces/{key}`.
 */
export const apiWorkflowDetailSchema = z.object({
	workflow: apiWorkflowSchema,
	workspaces: z
		.array(z.object({ key: z.string(), name: z.string() }))
		.describe('Пространства, чью работу изменит публикация'),
	active: apiProcessRevisionSchema
		.nullable()
		.describe('Действующая редакция; `null` — не заведена'),
	draft: apiProcessRevisionSchema.nullable().describe('Черновик; `null` — изменений нет'),
	issues: z.array(z.string()).describe('Что мешает применить черновик; пусто — публиковать можно')
});

export type ApiWorkflowDetail = z.output<typeof apiWorkflowDetailSchema>;

export function toApiWorkflowDetail(detail: WorkflowDetail): ApiWorkflowDetail {
	return {
		workflow: detail.workflow,
		workspaces: detail.workspaces,
		active: detail.active === null ? null : toApiProcessRevision(detail.active),
		draft: detail.draft === null ? null : toApiProcessRevision(detail.draft),
		issues: detail.issues
	};
}

/** Итог публикации черновика: фактические числа из транзакции. */
export const apiPublicationSchema = z.object({
	workflowId: z.uuid(),
	workflowKey: z.string(),
	version: z.number().int().describe('Номер ставшей действующей редакции'),
	reboundCount: z.number().int().describe('Записей, перепривязанных к стадии с тем же ключом'),
	migratedCount: z
		.number()
		.int()
		.describe('Взаимодействий, переехавших на другую стадию по правилу переноса'),
	archivedKeyCount: z.number().int().describe('Ключей стадий, снятых публикацией')
});

export type ApiPublication = z.output<typeof apiPublicationSchema>;

/** Сообщение журнала обмена: что ушло и пришло, в каком оно состоянии. */
export const apiExchangeMessageSchema = z.object({
	id: z.uuid(),
	direction: z.enum(EXCHANGE_DIRECTIONS).describe('`inbound` — нам, `outbound` — от нас'),
	system: z.string().describe('Система подключения: `cms` или `lms`'),
	instance: z.string(),
	eventType: z.string(),
	eventId: z.string().describe('Идентификатор события отправителя: по нему узнают повтор'),
	externalId: z.string().nullable().describe('Ключ объекта на стороне внешней системы'),
	interactionId: z.uuid().nullable(),
	interactionTitle: z.string().nullable(),
	state: z.enum(EXCHANGE_MESSAGE_STATES),
	attempt: z.number().int(),
	nextAttemptAt: z.iso.datetime().nullable(),
	responseStatus: z.number().int().nullable(),
	lastError: z.string().nullable(),
	createdAt: z.iso.datetime(),
	closedAt: z.iso.datetime().nullable()
});

export type ApiExchangeMessage = z.output<typeof apiExchangeMessageSchema>;

export function toApiExchangeMessage(view: ExchangeMessageView): ApiExchangeMessage {
	return {
		id: view.id,
		direction: view.direction,
		system: view.system,
		instance: view.instance,
		eventType: view.eventType,
		eventId: view.eventId,
		externalId: view.externalId,
		interactionId: view.interactionId,
		interactionTitle: view.interactionTitle,
		state: view.state,
		attempt: view.attempt,
		nextAttemptAt: view.nextAttemptAt === null ? null : view.nextAttemptAt.toISOString(),
		responseStatus: view.responseStatus,
		lastError: view.lastError,
		createdAt: view.createdAt.toISOString(),
		closedAt: view.closedAt === null ? null : view.closedAt.toISOString()
	};
}

/** Значение ячейки отчёта. Пустая ячейка — не ноль: ноль означает записанный ноль. */
export const apiReportCellSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('text'), value: z.string().nullable() }),
	z.object({ kind: z.literal('number'), value: z.number().nullable() }),
	z.object({ kind: z.literal('date'), value: z.iso.date().nullable() }),
	z.object({ kind: z.literal('datetime'), value: z.iso.datetime().nullable() }),
	z.object({ kind: z.literal('list'), values: z.array(z.string()) }),
	z.object({ kind: z.literal('link'), value: z.string().nullable(), url: z.url().nullable() })
]);

const apiReportBucketSchema = z.object({
	key: z.string(),
	label: z.string(),
	value: z.number(),
	filter: z
		.object({ param: z.string(), value: z.string() })
		.nullable()
		.describe('Чем сузить тот же отчёт до этого столбика'),
	retired: z.boolean().optional().describe('Стадии нет в действующем процессе: имя взято из снимка')
});

/** Документ-подтверждение строки: ключи связи, без персональных данных. */
const apiReportDocumentSchema = z.object({
	id: z.uuid(),
	kind: z.string().describe('Вид документа: соглашение, приказ, акт, отчёт'),
	storageKey: z.string().describe('Ключ объекта в хранилище документов'),
	sha256: z.string().describe('Хеш содержимого: по нему видно, что файл не подменили')
});

/** Учебная группа взаимодействия и её последний подтверждённый результат. */
const apiReportLearningGroupSchema = z.object({
	id: z.uuid(),
	externalId: z.string().nullable().describe('Идентификатор группы в системе обучения'),
	resultId: z.uuid().nullable().describe('Последний результат группы; null — результата ещё нет')
});

/**
 * Отчёт в том же виде, в каком его показывает экран и отдают выгрузки: одна
 * сборка на все четыре формата, поэтому числа интегратора и числа сотрудника
 * сойтись обязаны.
 */
export const apiReportSchema = z.object({
	meta: z.object({
		schemaVersion: z
			.number()
			.int()
			.describe('Версия схемы отчёта; растёт при изменении состава полей'),
		reportId: z
			.uuid()
			.describe(
				'Идентификатор сборки: новый у каждой, тот же стоит в шапке каждой выгрузки и в журнале'
			),
		generatedAt: z.iso
			.datetime()
			.describe('Момент снимка базы, из которого прочитаны и итоги, и строки'),
		asOf: z.iso.datetime().describe('Момент среза `T`, на который посчитан отчёт'),
		mode: z.enum(REPORT_MODES),
		period: z.object({ start: z.iso.date(), end: z.iso.date() }),
		filters: z.array(z.object({ label: z.string(), value: z.string() })),
		scope: z.string().describe('Область доступа владельца ключа словами'),
		semantics: z.string().describe('Что именно посчитано — теми же словами, что в шапке выгрузки'),
		columns: z.array(
			z.object({
				key: z.string(),
				label: z.string(),
				kind: z.enum(['text', 'number', 'date', 'datetime', 'list', 'link']),
				sort: z.enum(['historical', 'current']),
				note: z.string()
			})
		)
	}),
	rows: z.array(
		z.object({
			rowKey: z.string().describe('Устойчивое имя строки внутри выборки'),
			interactionId: z.uuid(),
			stageEntryId: z.uuid().nullable(),
			cells: z.array(apiReportCellSchema).describe('Ячейки в порядке `meta.columns`'),
			documents: z
				.array(apiReportDocumentSchema)
				.describe(
					'Ключи связи с документами взаимодействия: по ним число из отчёта проверяется ' +
						'самим файлом. Персональных данных в них нет — ни названия, ни того, кто загрузил'
				),
			learningGroups: z
				.array(apiReportLearningGroupSchema)
				.describe('Ключи связи с учебными группами и их последними подтверждёнными результатами')
		})
	),
	totals: z.object({
		rowCount: z.number().int(),
		interactionCount: z.number().int(),
		paused: z.number().int(),
		overdue: z.number().int()
	}),
	charts: z.object({
		funnel: z
			.object({
				workspaces: z
					.array(
						z.object({
							workspaceId: z.uuid(),
							workspaceKey: z.string(),
							workspaceName: z.string(),
							stages: z.array(apiReportBucketSchema)
						})
					)
					.describe(
						'По воронке на пространство: у B2B и B2C свои стадии, и одинаковые ключи в ' +
							'них законны — в одном списке две разные стадии слились бы в одну строку'
					),
				closed: z.array(apiReportBucketSchema),
				note: z.string()
			})
			.nullable(),
		movement: z
			.object({
				step: z.enum(['week', 'month']),
				buckets: z.array(
					z.object({
						key: z.string(),
						label: z.string(),
						from: z.iso.date(),
						to: z.iso.date()
					})
				),
				series: z.array(
					z.object({ key: z.string(), label: z.string(), values: z.array(z.number()) })
				),
				migrated: z
					.number()
					.int()
					.describe('Переносы при изменении процесса: переходом не считаются'),
				note: z.string()
			})
			.nullable(),
		breakdowns: z.array(
			z.object({
				key: z.string(),
				label: z.string(),
				points: z.array(apiReportBucketSchema),
				doubleCounted: z
					.number()
					.int()
					.describe('Сколько записей учтено больше чем в одной строке разреза')
			})
		)
	})
});

export type ApiReport = z.output<typeof apiReportSchema>;

export function toApiReport(view: ReportView): ApiReport {
	const bucket = (point: ReportBucket) => ({
		key: point.key,
		label: point.label,
		value: point.value,
		filter: point.filter === null ? null : { param: point.filter.param, value: point.filter.value },
		...(point.retired === undefined ? {} : { retired: point.retired })
	});

	return {
		meta: {
			schemaVersion: view.meta.schemaVersion,
			reportId: view.meta.reportId,
			generatedAt: view.meta.generatedAt,
			asOf: view.meta.asOf,
			mode: view.meta.mode,
			period: { start: view.meta.period.start, end: view.meta.period.end },
			filters: view.meta.filters.map((filter) => ({ label: filter.label, value: filter.value })),
			scope: view.meta.scope,
			semantics: view.meta.semantics,
			columns: view.meta.columns.map((column) => ({
				key: column.key,
				label: column.label,
				kind: column.kind,
				sort: column.sort,
				note: column.note
			}))
		},
		rows: view.rows.map((row) => ({
			rowKey: row.rowKey,
			interactionId: row.interactionId,
			stageEntryId: row.stageEntryId,
			cells: row.cells.map((cell) =>
				cell.kind === 'list' ? { ...cell, values: [...cell.values] } : cell
			),
			documents: row.documents.map((document) => ({ ...document })),
			learningGroups: row.learningGroups.map((group) => ({ ...group }))
		})),
		totals: {
			rowCount: view.totals.rowCount,
			interactionCount: view.totals.interactionCount,
			paused: view.totals.paused,
			overdue: view.totals.overdue
		},
		charts: {
			funnel:
				view.charts.funnel === null
					? null
					: {
							workspaces: view.charts.funnel.workspaces.map((funnel) => ({
								workspaceId: funnel.workspaceId,
								workspaceKey: funnel.workspaceKey,
								workspaceName: funnel.workspaceName,
								stages: funnel.stages.map(bucket)
							})),
							closed: view.charts.funnel.closed.map(bucket),
							note: view.charts.funnel.note
						},
			movement:
				view.charts.movement === null
					? null
					: {
							step: view.charts.movement.step,
							buckets: view.charts.movement.buckets.map((item) => ({
								key: item.key,
								label: item.label,
								from: item.from,
								to: item.to
							})),
							series: view.charts.movement.series.map((line) => ({
								key: line.key,
								label: line.label,
								values: [...line.values]
							})),
							migrated: view.charts.movement.migrated,
							note: view.charts.movement.note
						},
			breakdowns: view.charts.breakdowns.map((breakdown) => ({
				key: breakdown.key,
				label: breakdown.label,
				points: breakdown.points.map(bucket),
				doubleCounted: breakdown.doubleCounted
			}))
		}
	};
}

/**
 * Системы обмена, от имени которых бывает выпущен ключ. `crm` в этот список не
 * входит: ключ выпускают внешней системе, а не себе.
 */
export const API_KEY_EXCHANGE_SYSTEMS = ['cms', 'lms'] as const;

export type ApiKeyExchangeSystem = (typeof API_KEY_EXCHANGE_SYSTEMS)[number];

export const API_KEY_EXCHANGE_SYSTEM_LABELS: Record<ApiKeyExchangeSystem, string> = {
	cms: 'Сайт (CMS): заявки и статусы',
	lms: 'Система обучения (LMS): результаты групп'
};

/**
 * Ключ доступа выпускается на пользователя и действует его правами: у машины
 * не может быть прав больше, чем у человека, от имени которого она ходит.
 *
 * У ключа машинного субъекта есть вторая половина — подключение обмена, от
 * имени которого он работает. Права роли `service` одинаковы у всех таких
 * ключей, и без этого поля ключ сайта подавал бы результаты учебных групп, а
 * ключ системы обучения — заявки. У ключа на человека поле пустое: маршруты
 * обмена ему закрыты границей машинного субъекта.
 */
export const createApiKeySchema = z.object({
	name: requiredText(200, 'Укажите название ключа'),
	ownerUserId: id('Выберите владельца ключа'),
	exchangeSystem: z.enum(API_KEY_EXCHANGE_SYSTEMS).nullable().default(null)
});

export type CreateApiKeyInput = z.output<typeof createApiKeySchema>;

/** Ключ в списке. Самого ключа здесь нет и быть не может: в базе только хеш. */
export type ApiKeyView = {
	id: string;
	name: string;
	ownerUserId: string;
	/** Подключение обмена ключа; `null` — ключ выпущен на человека. */
	exchangeSystem: ApiKeyExchangeSystem | null;
	exchangeInstance: string | null;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
	createdAt: Date;
};

/**
 * Только что выпущенный ключ. `key` возвращается один раз — при создании; после
 * этого восстановить его неоткуда, и потерянный ключ можно только отозвать и
 * выпустить заново.
 */
export type CreatedApiKey = ApiKeyView & { key: string };
