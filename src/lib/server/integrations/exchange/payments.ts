/**
 * Загрузка оплат с сайта: файл выгрузки → предпросмотр → применение.
 *
 * Сайт выгружает оплаченные заказы списком (JSON-массив или таблица с теми же
 * колонками), и администратор загружает его диалогом на экране «Внешние
 * системы». **Запись файла — подтверждённая оплата заказа**: сумм и дат в
 * выгрузке нет, и в систему попадает сам факт — номер заявки, курс и поток.
 *
 * Запись приходит к тем же записям, к которым пришла бы заявка с сайта:
 * физлицо узнаётся теми же ключами сравнения почты и телефона, дело — по той же
 * внешней ссылке `cms:<экземпляр>` и номеру заказа, ведёт его тот же сотрудник
 * (`applicant.ts`). Номер заказа непрозрачен — длина цифр в нём разная, дата
 * внутри бывает невалидной, — поэтому он хранится как есть и ни на что не
 * раскладывается.
 *
 * **Каждая запись — своя транзакция.** Ошибка одной записи (пустой элемент,
 * неизвестный курс, некому вести дело) не роняет файл: запись получает
 * ошибку словами, остальные применяются. Строка журнала обмена с ключом
 * `payment:<номер заказа>` и есть факт оплаты и защита от второго применения:
 * повтор применённой записи — «без изменений», упавшая пробуется заново.
 *
 * **Стадию загрузка не двигает** — её меняет только человек. Открыта стадия с
 * пунктом «Оплата получена» — пункт отмечается в той же транзакции; стадия ещё
 * впереди — отметку поставит вход на неё по сохранённому факту
 * (`stages/commands.ts`, `paymentEntryPatch`); стадия пройдена или дело
 * закрыто — факт сохраняется, отметки не меняются. Статус заявки на сайт при
 * этом не уходит: загрузка оплат — не приём заявки.
 */
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { EXCHANGE_EVENT_TYPES, externalSourceOf } from '$lib/contracts/exchange';
import type { InteractionView } from '$lib/contracts/interactions';
import {
	PAYMENT_CHECKLIST_KEY,
	PAYMENT_ROW_ACTIONS,
	PAYMENTS_MAX_ROWS,
	paymentRecordSchema,
	type PaymentFactView,
	type PaymentRecord,
	type PaymentRowAction,
	type PaymentRowView,
	type PaymentsView
} from '$lib/contracts/payments';
import { formatDate, formatIsoDay } from '$lib/format';
import type { ActorContext } from '../../actor';
import { recordAuditEvent } from '../../audit';
import { getDb } from '../../db';
import {
	exchangeMessages,
	interactionPrograms,
	interactions,
	organizations,
	programs,
	stageEntries
} from '../../db/schema';
import { withTransaction, type Tx } from '../../db/transaction';
import { queueApplicationNotice } from '../../inbox';
import { AppError, ConflictError, ValidationError } from '../../errors';
import { nextEdit } from '../../interactions/edit-version';
import { createInteractionIn } from '../../interactions/write';
import { publishAfterCommit } from '../../live/publish';
import { hashEmail, normalizeEmail, normalizePhone } from '../../people/pii';
import { withPiiTrace } from '../../people/pii-trace';
import { requirePermission } from '../../rbac';
import { suggestFieldMapping, type FieldSynonyms } from '../../spreadsheet/mapping';
import { decodeTextOrNull } from '../../spreadsheet/encoding';
import { markChecklistItemIn } from '../../stages/commands';
import {
	firstStage,
	requireActiveRevisionForWorkspace,
	resolveIntakeWorkspace
} from '../../stages/process';
import { readStatTable } from '../../stats/parse';
import { getExchangeSettings } from '../settings';
import {
	applicantPersonName,
	chooseIntakeOwner,
	ensureOwnAffiliation,
	ensureResponsible,
	findExisting,
	findIndividual,
	findOrCreateIndividual,
	isUniqueViolation,
	ownerActor,
	recordApplicationConsent
} from './applicant';
import { hashMessage } from './intake';

/* ------------------------------------------------------------ разбор файла */

const PAYMENT_FIELDS = [
	'orderId',
	'course',
	'lastName',
	'firstName',
	'middleName',
	'phone',
	'email',
	'streamNumber'
] as const;

type PaymentField = (typeof PAYMENT_FIELDS)[number];

/** Без этих колонок запись не собрать: их отсутствие — претензия к файлу. */
const REQUIRED_FIELDS: readonly PaymentField[] = [
	'orderId',
	'course',
	'lastName',
	'firstName',
	'email',
	'streamNumber'
];

/** Колонки выгрузки сайта и то, как их называют в таблицах. */
const SYNONYMS: FieldSynonyms<PaymentField> = {
	orderId: ['номер заявки', 'заявка', 'номер заказа', 'заказ', 'order id'],
	course: ['курс', 'программа', 'course'],
	lastName: ['фамилия', 'last name', 'surname'],
	firstName: ['имя', 'first name'],
	middleName: ['отчество', 'middle name', 'patronymic'],
	phone: ['телефон', 'тел', 'phone'],
	email: ['email', 'e mail', 'почта', 'электронная почта'],
	streamNumber: ['номер потока', 'поток', 'stream']
};

const FIELD_TITLES: Record<PaymentField, string> = {
	orderId: 'Номер заявки',
	course: 'Курс',
	lastName: 'Фамилия',
	firstName: 'Имя',
	middleName: 'Отчество',
	phone: 'Телефон',
	email: 'Email',
	streamNumber: 'Номер потока'
};

/** Запись файла до проверки: ячейки текстом и претензии разбора. */
type RawRow = {
	place: string;
	cells: Partial<Record<PaymentField, string>>;
	issues: string[];
};

type ParsedFile = { rows: RawRow[]; fileIssues: string[] };

/** Колонки файла, сопоставленные полям записи: поле → имя колонки. */
function columnsOf(headers: readonly string[]): Partial<Record<PaymentField, string>> {
	const columns: Partial<Record<PaymentField, string>> = {};

	for (const [header, field] of Object.entries(
		suggestFieldMapping(headers, PAYMENT_FIELDS, SYNONYMS)
	)) {
		columns[field] = header;
	}

	return columns;
}

/** Претензии к набору колонок: без обязательных запись не собрать. */
function missingColumns(columns: Partial<Record<PaymentField, string>>): string[] {
	const missing = REQUIRED_FIELDS.filter((field) => columns[field] === undefined);

	return missing.length === 0
		? []
		: [`Нет колонок: ${missing.map((field) => `«${FIELD_TITLES[field]}»`).join(', ')}`];
}

function tooManyRows(total: number): string[] {
	return total > PAYMENTS_MAX_ROWS
		? [
				`В файле ${total} записей — загружаются первые ${PAYMENTS_MAX_ROWS}. Выгрузку больше этого делят на несколько файлов.`
			]
		: [];
}

/** Текст JSON, если файл — JSON: массив или объект, а не таблица. */
function jsonText(bytes: Uint8Array): string | null {
	const decoded = decodeTextOrNull(bytes);

	if (decoded === null) {
		return null;
	}

	const start = decoded.text.trimStart()[0];

	return start === '[' || start === '{' ? decoded.text : null;
}

/**
 * JSON-выгрузка сайта. Разбирается здесь, а не общим разбором снимков: тот
 * отвергает файл целиком из-за одного пустого элемента, а выгрузка сайта
 * приходит и с `null` посреди списка — такой элемент получает свою претензию,
 * остальные загружаются.
 */
function readJsonPayments(fileName: string, text: string): ParsedFile {
	let parsed: unknown;

	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		throw new ValidationError(`Файл «${fileName}» не разбирается как JSON`, [
			'Проверьте файл: лишняя запятая в конце списка или одинарные кавычки — самое частое',
			String(cause instanceof Error ? cause.message : cause)
		]);
	}

	if (!Array.isArray(parsed)) {
		throw new ValidationError(`В файле «${fileName}» не список записей`, [
			'Выгрузка оплат — JSON-массив: [{"Номер заявки": …, "Курс": …}, …]'
		]);
	}

	const elements: unknown[] = parsed.slice(0, PAYMENTS_MAX_ROWS);
	const objects = elements.filter(
		(element): element is Record<string, unknown> =>
			element !== null && typeof element === 'object' && !Array.isArray(element)
	);
	const columns = columnsOf([...new Set(objects.flatMap((element) => Object.keys(element)))]);
	const missing = missingColumns(columns);
	const fileIssues = [...tooManyRows(parsed.length), ...missing];

	if (missing.length > 0) {
		return { rows: [], fileIssues };
	}

	const rows = elements.map((element, index): RawRow => {
		const place = `запись ${index + 1}`;

		if (element === null || typeof element !== 'object' || Array.isArray(element)) {
			return {
				place,
				cells: {},
				issues: [
					`Элемент — ${element === null ? 'null' : Array.isArray(element) ? 'массив' : typeof element}, а ждём объект с полями записи`
				]
			};
		}

		const record = element as Record<string, unknown>;
		const cells: Partial<Record<PaymentField, string>> = {};
		const issues: string[] = [];

		for (const field of PAYMENT_FIELDS) {
			const key = columns[field];
			const value = key === undefined ? undefined : record[key];

			if (value === null || value === undefined) {
				cells[field] = '';
			} else if (typeof value === 'string') {
				cells[field] = value.trim();
			} else if (typeof value === 'number' && Number.isFinite(value)) {
				cells[field] = String(value);
			} else {
				issues.push(`Поле «${key}» — не текст и не число`);
			}
		}

		return { place, cells, issues };
	});

	return { rows, fileIssues };
}

/** Таблица с теми же колонками: общий разбор таблиц и общее сопоставление колонок. */
function readTablePayments(fileName: string, bytes: Uint8Array): ParsedFile {
	const table = readStatTable(fileName, bytes, PAYMENTS_MAX_ROWS);
	const columns = columnsOf(table.headers);
	const missing = missingColumns(columns);
	const fileIssues = [...table.warnings, ...tooManyRows(table.totalRows), ...missing];

	if (missing.length > 0) {
		return { rows: [], fileIssues };
	}

	const rows = table.rows.map((row): RawRow => {
		const cells: Partial<Record<PaymentField, string>> = {};

		for (const field of PAYMENT_FIELDS) {
			const header = columns[field];
			cells[field] =
				header === undefined ? '' : (row.cells[table.headers.indexOf(header)] ?? '').trim();
		}

		return { place: `строка ${row.origin}`, cells, issues: [] };
	});

	return { rows, fileIssues };
}

function readPaymentsFile(fileName: string, bytes: Uint8Array): ParsedFile {
	const text = jsonText(bytes);

	return text === null ? readTablePayments(fileName, bytes) : readJsonPayments(fileName, text);
}

/* ------------------------------------------------------------ сверка записей */

/**
 * Название курса в сравнимом виде: пробелы по краям и внутри, регистр и
 * кавычки («ёлочки» и прямые) к делу не относятся — «ПАО «Ростелеком»» и
 * «пао "ростелеком"» это один курс.
 */
function normalizeCourse(name: string): string {
	return name
		.replaceAll(/[«»"“”„]/g, '')
		.replaceAll(/\s+/g, ' ')
		.trim()
		.toLocaleLowerCase('ru');
}

/** Запись после проверки полей и сверки курса со справочником программ. */
type CheckedRow = {
	place: string;
	record: PaymentRecord | null;
	programId: string | null;
	fullName: string;
	issues: string[];
};

/** Справочник программ по нормализованному названию; архивные не участвуют. */
async function programsByCourse(executor: Tx): Promise<Map<string, string[]>> {
	const rows = await executor
		.select({ id: programs.id, name: programs.name })
		.from(programs)
		.where(ne(programs.status, 'archived'));
	const byName = new Map<string, string[]>();

	for (const row of rows) {
		const key = normalizeCourse(row.name);
		byName.set(key, [...(byName.get(key) ?? []), row.id]);
	}

	return byName;
}

/**
 * Проверка записей: поля по схеме, курс по справочнику, номер заявки — один на
 * файл. Повтор номера — одна запись лишняя: загружается первая, у повтора
 * претензия с местом первой.
 */
async function checkRows(executor: Tx, parsed: ParsedFile): Promise<CheckedRow[]> {
	const byCourse = await programsByCourse(executor);
	const firstByOrder = new Map<string, string>();

	return parsed.rows.map((row): CheckedRow => {
		const issues = [...row.issues];
		const fullName = [row.cells.lastName, row.cells.firstName, row.cells.middleName]
			.filter((part) => part !== undefined && part !== '')
			.join(' ');

		if (issues.length > 0) {
			return { place: row.place, record: null, programId: null, fullName, issues };
		}

		const checked = paymentRecordSchema.safeParse(row.cells);

		if (!checked.success) {
			return {
				place: row.place,
				record: null,
				programId: null,
				fullName,
				issues: checked.error.issues.map((issue) => issue.message)
			};
		}

		const record = checked.data;
		const candidates = byCourse.get(normalizeCourse(record.course)) ?? [];
		let programId: string | null = null;

		if (candidates.length === 0) {
			issues.push(
				`Курс «${record.course}» не найден в справочнике программ: добавьте программу и загрузите файл ещё раз`
			);
		} else if (candidates.length > 1) {
			issues.push(
				`Курс «${record.course}» неоднозначен: в справочнике программ несколько программ с таким названием`
			);
		} else {
			programId = candidates[0];
		}

		const first = firstByOrder.get(record.orderId);

		if (first === undefined) {
			firstByOrder.set(record.orderId, row.place);
		} else {
			issues.push(`Номер заявки повторяет ${first}: загрузится только первая запись`);
		}

		return { place: row.place, record, programId, fullName, issues };
	});
}

/** Ключ события оплаты в журнале обмена: номер заказа как есть. */
function paymentEventId(orderId: string): string {
	return `payment:${orderId}`;
}

/**
 * Отпечаток записи: по нему повтор той же записи отличается от записи,
 * исправленной на сайте. Контакты — в сравнимом виде: регистр почты и вид
 * записи номера записи не меняют.
 */
function recordHash(record: PaymentRecord): string {
	return hashMessage({
		orderId: record.orderId,
		course: normalizeCourse(record.course),
		lastName: record.lastName,
		firstName: record.firstName,
		middleName: record.middleName,
		email: normalizeEmail(record.email),
		phone: record.phone === null ? null : normalizePhone(record.phone),
		streamNumber: record.streamNumber
	});
}

/**
 * Что от записи остаётся в журнале обмена: ключи, курс, поток и отпечаток
 * почты — тот же ключ сравнения, что в `people.email_hash`. ФИО и контакты
 * живут в `people`, где работают маскирование и обезличивание; вторая копия в
 * журнале этих правил не знала бы. Уничтожение данных человека стирает и эти
 * тела (`people/retention.ts`): по взаимодействию и по отпечатку почты.
 */
function journalPayload(
	instance: string,
	record: PaymentRecord,
	programId: string
): Record<string, unknown> {
	return {
		eventType: EXCHANGE_EVENT_TYPES.paymentConfirmed,
		eventId: paymentEventId(record.orderId),
		source: { system: 'cms', instance },
		data: {
			externalId: record.orderId,
			course: record.course,
			programId,
			streamNumber: record.streamNumber,
			contact: { emailHash: hashEmail(record.email) }
		}
	};
}

/* ------------------------------------------------------------ стадия оплаты */

type PaymentStage =
	| { kind: 'current'; stageName: string; marked: boolean }
	| { kind: 'ahead'; stageName: string; currentName: string }
	| { kind: 'passed'; stageName: string }
	| { kind: 'closed' }
	| { kind: 'none' };

/** Стадия действующей редакции, в чек-листе которой объявлена отметка об оплате. */
function paymentStageOf(
	revision: Awaited<ReturnType<typeof requireActiveRevisionForWorkspace>>
): { name: string; position: number } | null {
	const stage = revision.stages.find((candidate) =>
		candidate.checklist.some((item) => item.key === PAYMENT_CHECKLIST_KEY)
	);

	return stage === undefined ? null : { name: stage.name, position: stage.position };
}

/** Где дело относительно стадии с отметкой об оплате. */
async function readPaymentStage(tx: Tx, interactionId: string): Promise<PaymentStage> {
	const [interaction] = await tx
		.select({ status: interactions.status, workspaceId: interactions.workspaceId })
		.from(interactions)
		.where(eq(interactions.id, interactionId))
		.limit(1);

	if (interaction.status !== 'active') {
		return { kind: 'closed' };
	}

	const [entry] = await tx
		.select({ snapshot: stageEntries.stageSnapshot, checklistState: stageEntries.checklistState })
		.from(stageEntries)
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)))
		.limit(1);

	if (entry === undefined) {
		return { kind: 'none' };
	}

	if (entry.snapshot.checklist.some((item) => item.key === PAYMENT_CHECKLIST_KEY)) {
		return {
			kind: 'current',
			stageName: entry.snapshot.name,
			marked: entry.checklistState[PAYMENT_CHECKLIST_KEY] === true
		};
	}

	const stage = paymentStageOf(
		await requireActiveRevisionForWorkspace(tx, interaction.workspaceId)
	);

	if (stage === null) {
		return { kind: 'none' };
	}

	return entry.snapshot.position < stage.position
		? { kind: 'ahead', stageName: stage.name, currentName: entry.snapshot.name }
		: { kind: 'passed', stageName: stage.name };
}

/** Где окажется новое дело: на первой стадии пространства приёма физлиц. */
async function newInteractionStage(tx: Tx): Promise<PaymentStage> {
	const workspace = await resolveIntakeWorkspace(tx, 'individual');
	const revision = await requireActiveRevisionForWorkspace(tx, workspace.id);
	const first = firstStage(revision);
	const stage = paymentStageOf(revision);

	if (stage === null) {
		return { kind: 'none' };
	}

	return stage.position === first.position
		? { kind: 'current', stageName: first.name, marked: false }
		: { kind: 'ahead', stageName: stage.name, currentName: first.name };
}

/** Что станет с отметкой об оплате — словами. */
function stageNote(stage: PaymentStage, applied: boolean): string {
	switch (stage.kind) {
		case 'current':
			if (stage.marked) {
				return `Оплата уже отмечена на стадии «${stage.stageName}»`;
			}

			return applied
				? `Оплата отмечена на стадии «${stage.stageName}»`
				: `Оплата отметится сразу: дело на стадии «${stage.stageName}»`;
		case 'ahead':
			return `Дело на стадии «${stage.currentName}»: оплата отметится при переходе на стадию «${stage.stageName}», стадию загрузка не меняет`;
		case 'passed':
			return `Стадия «${stage.stageName}» уже пройдена: факт оплаты сохранён, отметки стадий не меняются`;
		case 'closed':
			return 'Дело закрыто: факт оплаты сохранён, отметки стадий не меняются';
		case 'none':
			return 'В процессе дела нет пункта «Оплата получена»: факт оплаты сохранён';
	}
}

/* ------------------------------------------------------------ дело и ответственный */

type ExistingInteraction = NonNullable<Awaited<ReturnType<typeof findExisting>>>;

/** К какому делу придёт оплата и кто его ведёт. */
type PaymentTarget = { ownerUserId: string } & (
	| {
			kind: 'new';
			workspace: Awaited<ReturnType<typeof resolveIntakeWorkspace>>;
			found: Awaited<ReturnType<typeof findIndividual>>;
	  }
	| { kind: 'existing'; existing: ExistingInteraction }
);

/**
 * Дело по номеру заказа — найденное или то, что заведётся, — и сотрудник,
 * который его поведёт. Один расчёт на предпросмотр и применение: предпросмотр,
 * обещающий «создать» запись, которую применение отвергнет «некому вести»,
 * обманывает администратора. Некому вести дело — `ValidationError` с причиной.
 */
async function resolvePaymentTarget(
	tx: Tx,
	source: string,
	record: PaymentRecord,
	configuredOwnerUserId: string | null
): Promise<PaymentTarget> {
	const existing = await findExisting(tx, source, record.orderId);

	if (existing !== null) {
		return {
			kind: 'existing',
			existing,
			ownerUserId: await chooseIntakeOwner(tx, {
				organizationId: existing.organizationId,
				workspace: { id: existing.workspaceId, name: existing.workspaceName },
				configuredOwnerUserId
			})
		};
	}

	// Нового дела ещё нет: оно заводится в пространстве, которое таблица
	// соответствий отдаёт физлицам, — так же, как у заявки с сайта.
	const workspace = await resolveIntakeWorkspace(tx, 'individual');
	const found = await findIndividual(tx, record.email, record.phone);

	return {
		kind: 'new',
		workspace,
		found,
		ownerUserId: await chooseIntakeOwner(tx, {
			organizationId: found?.id ?? null,
			workspace,
			configuredOwnerUserId
		})
	};
}

/** Предметный отказ словами для записи: сообщение и его подробности. */
function refusalIssues(error: AppError): string[] {
	return [error.message, ...(error instanceof ValidationError ? error.issues : [])];
}

/* ------------------------------------------------------------ предпросмотр */

/** Строка журнала обмена по этой оплате, если её уже загружали. */
async function readPaymentMessage(
	executor: Tx,
	instance: string,
	orderId: string
): Promise<{
	state: string;
	requestHash: string | null;
	lastError: string | null;
	createdAt: Date;
	interactionId: string | null;
} | null> {
	const [row] = await executor
		.select({
			state: exchangeMessages.state,
			requestHash: exchangeMessages.requestHash,
			lastError: exchangeMessages.lastError,
			createdAt: exchangeMessages.createdAt,
			interactionId: exchangeMessages.interactionId
		})
		.from(exchangeMessages)
		.where(
			and(
				eq(exchangeMessages.direction, 'inbound'),
				eq(exchangeMessages.system, 'cms'),
				eq(exchangeMessages.instance, instance),
				eq(exchangeMessages.eventId, paymentEventId(orderId))
			)
		)
		.limit(1);

	return row ?? null;
}

function rowView(
	row: CheckedRow,
	action: PaymentRowAction,
	notes: string[],
	issues: string[] = row.issues,
	interactionId: string | null = null
): PaymentRowView {
	return {
		interactionId,
		place: row.place,
		orderId: row.record?.orderId ?? null,
		fullName: row.record === null ? row.fullName : applicantPersonName(row.record),
		course: row.record?.course ?? null,
		streamNumber: row.record?.streamNumber ?? null,
		action,
		issues,
		notes
	};
}

function unchangedNote(
	message: { requestHash: string | null; createdAt: Date },
	record: PaymentRecord
): string[] {
	return [
		`Оплата уже загружена ${formatDate(message.createdAt)}`,
		...(message.requestHash === recordHash(record)
			? []
			: [
					'Данные записи отличаются от загруженных раньше: факт оплаты уже учтён, изменения не применяются'
				])
	];
}

/** Что станет с записью — тем же расчётом, что у применения, но без записи. */
async function previewRow(
	ctx: ActorContext,
	tx: Tx,
	options: ImportOptions,
	row: CheckedRow
): Promise<PaymentRowView> {
	if (row.record === null || row.issues.length > 0) {
		return rowView(row, 'error', []);
	}

	const record = row.record;
	const message = await readPaymentMessage(tx, options.instance, record.orderId);

	if (message?.state === 'processed') {
		return rowView(
			row,
			'unchanged',
			unchangedNote(message, record),
			row.issues,
			message.interactionId
		);
	}

	let target: PaymentTarget;

	try {
		target = await resolvePaymentTarget(tx, options.source, record, options.configuredOwnerUserId);
		await ownerActor(ctx, target.ownerUserId);
	} catch (error) {
		// Те же отказы, что у применения, и тем же текстом: запись, которую
		// некому вести, предпросмотр показывает ошибкой, а не «создать».
		if (!(error instanceof AppError)) {
			throw error;
		}

		return rowView(row, 'error', [], refusalIssues(error));
	}

	const notes: string[] =
		message?.state === 'failed'
			? [
					`Прошлая загрузка не удалась (${message.lastError ?? 'без причины'}): запись загрузится снова`
				]
			: [];

	if (target.kind === 'existing') {
		notes.push(stageNote(await readPaymentStage(tx, target.existing.id), false));

		return rowView(row, 'update', notes, row.issues, target.existing.id);
	}

	notes.push(
		target.found === null
			? 'Физлицо будет заведено в справочнике'
			: 'Физлицо уже есть в справочнике: второе не заводится'
	);
	notes.push(stageNote(await newInteractionStage(tx), false));

	return rowView(row, 'create', notes);
}

function toPaymentsView(
	rows: PaymentRowView[],
	fileIssues: string[],
	applied: boolean
): PaymentsView {
	const counts = Object.fromEntries(PAYMENT_ROW_ACTIONS.map((action) => [action, 0])) as Record<
		PaymentRowAction,
		number
	>;

	for (const row of rows) {
		counts[row.action] += 1;
	}

	return { rows, counts, fileIssues, applied };
}

/** Настройки обмена, от которых зависит итог записи: экземпляр сайта и ответственный. */
type ImportOptions = { instance: string; source: string; configuredOwnerUserId: string | null };

async function importOptions(): Promise<ImportOptions> {
	const settings = await getExchangeSettings();

	return {
		instance: settings.cms.instance,
		source: externalSourceOf('cms', settings.cms.instance),
		configuredOwnerUserId: settings.cms.defaultOwnerUserId
	};
}

/**
 * Предпросмотр загрузки: что станет с каждой записью. Ничего не пишет — чтение
 * идёт одной транзакцией, чтобы все записи сверялись с одним состоянием базы.
 *
 * ФИО в ответе — ровно те, что администратор сам принёс в файле: это не
 * раскрытие данных справочника.
 */
export async function previewPayments(
	ctx: ActorContext,
	file: { name: string; bytes: Uint8Array }
): Promise<PaymentsView> {
	requirePermission(ctx, 'integrations.manage');

	const parsed = readPaymentsFile(file.name, file.bytes);
	const options = await importOptions();

	return getDb().transaction(async (tx) => {
		const checked = await checkRows(tx, parsed);
		const rows: PaymentRowView[] = [];

		for (const row of checked) {
			rows.push(await previewRow(ctx, tx, options, row));
		}

		return toPaymentsView(rows, parsed.fileIssues, false);
	});
}

/* ------------------------------------------------------------ применение */

type ValidRow = CheckedRow & { record: PaymentRecord; programId: string };

type Applied =
	| {
			result: 'unchanged';
			message: { requestHash: string | null; createdAt: Date; interactionId: string | null };
	  }
	| {
			result: 'created' | 'updated';
			stage: PaymentStage;
			personFound: boolean;
			interactionId: string;
	  };

/** Дело по оплате: найдено по номеру заказа или заведено. */
async function applyInTransaction(
	ctx: ActorContext,
	tx: Tx,
	options: ImportOptions & {
		row: ValidRow;
		requestHash: string;
		payload: Record<string, unknown>;
	}
): Promise<Applied> {
	const { record, programId } = options.row;

	const [message] = await tx
		.insert(exchangeMessages)
		.values({
			direction: 'inbound',
			system: 'cms',
			instance: options.instance,
			eventType: EXCHANGE_EVENT_TYPES.paymentConfirmed,
			eventId: paymentEventId(record.orderId),
			externalId: record.orderId,
			state: 'processed',
			payload: options.payload,
			requestHash: options.requestHash
		})
		// Та же схема, что у приёма заявки: строка упавшей попытки занимает место
		// в ключе, но повтором быть не перестаёт — её переписывают, а закрытую нет.
		.onConflictDoUpdate({
			target: [
				exchangeMessages.direction,
				exchangeMessages.system,
				exchangeMessages.instance,
				exchangeMessages.eventId
			],
			set: {
				eventType: EXCHANGE_EVENT_TYPES.paymentConfirmed,
				externalId: record.orderId,
				state: 'processed',
				payload: options.payload,
				requestHash: options.requestHash,
				lastError: null,
				responseBody: null,
				closedAt: null
			},
			setWhere: eq(exchangeMessages.state, 'failed')
		})
		.returning({ id: exchangeMessages.id });

	if (message === undefined) {
		// Конфликт с закрытой строкой: эту оплату уже применили.
		const applied = await readPaymentMessage(tx, options.instance, record.orderId);

		if (applied === null) {
			throw new ConflictError(
				'Эту оплату прямо сейчас загружает другой запрос: повторите загрузку'
			);
		}

		return { result: 'unchanged', message: applied };
	}

	const person = {
		lastName: record.lastName,
		firstName: record.firstName,
		middleName: record.middleName,
		email: record.email,
		phone: record.phone
	};
	const target = await resolvePaymentTarget(
		tx,
		options.source,
		record,
		options.configuredOwnerUserId
	);
	const ownerUserId = target.ownerUserId;
	const owner = await ownerActor(ctx, ownerUserId);

	let interactionId: string;
	let organizationId: string;
	let personId: string | null;

	if (target.kind === 'new') {
		const individual = await findOrCreateIndividual(owner, tx, person);

		organizationId = individual.organizationId;
		personId = individual.personId;

		// Назначение — до создания взаимодействия: область считается по
		// действующим назначениям, и без него сотрудник не увидел бы ни
		// контрагента, ни дело.
		await ensureResponsible(owner, tx, organizationId, ownerUserId);

		const affiliationId =
			personId === null
				? null
				: await ensureOwnAffiliation(owner, tx, {
						organizationId,
						personId,
						position: 'Слушатель (оплата с сайта)',
						isPrimary: true
					});

		interactionId = await createInteractionIn(
			owner,
			tx,
			target.workspace.key,
			{
				title: `Оплата с сайта: ${applicantPersonName(person)} — ${record.course}`.slice(0, 300),
				agreementPeriodStart: null,
				agreementPeriodEnd: null,
				academicPeriodStart: null,
				academicPeriodEnd: null,
				ownerUserId,
				parties: [
					{
						organizationId,
						partyRole: 'customer',
						isPrimary: true,
						contactAffiliationId: affiliationId,
						siteIds: []
					}
				],
				programs: [{ programId, programVersionId: null }],
				productIds: [],
				externalSource: options.source,
				externalId: record.orderId
			},
			{ via: 'site' }
		);

		// Дело завела загрузка, а ведёт его другой сотрудник: он узнаёт о нём
		// колокольчиком и письмом. Себе, загрузившему, сообщать незачем.
		if (ctx.user?.id !== ownerUserId) {
			await queueApplicationNotice(tx, { interactionId, userId: ownerUserId });
		}
	} else {
		interactionId = target.existing.id;
		organizationId = target.existing.organizationId;

		const [counterparty] = await tx
			.select({ personId: organizations.personId })
			.from(organizations)
			.where(eq(organizations.id, organizationId))
			.limit(1);

		personId = counterparty?.personId ?? null;

		// Строка дела блокируется до чтения стадии: переход коллеги, отданный
		// одновременно, иначе увёл бы дело со стадии между чтением и отметкой.
		await tx
			.select({ id: interactions.id })
			.from(interactions)
			.where(eq(interactions.id, interactionId))
			.for('update');

		const added = await tx
			.insert(interactionPrograms)
			.values({ interactionId, programId, programVersionId: null })
			.onConflictDoNothing()
			.returning({ programId: interactionPrograms.programId });

		// Программа добавилась — это правка защищённых полей, как у дополненной
		// заявки: открытая у сотрудника форма плана получит отказ, а не вернёт
		// прежний состав.
		if (added.length > 0) {
			await tx
				.update(interactions)
				.set({
					...nextEdit(interactions.editVersion, { via: 'site' }),
					lastActivityAt: sql`clock_timestamp()`,
					updatedAt: sql`now()`
				})
				.where(eq(interactions.id, interactionId));
		}
	}

	if (personId !== null) {
		// Оплата — это заключённый договор-оферта: основание обработки данных
		// слушателя, отдельное от согласия из заявки.
		await recordApplicationConsent(owner, tx, personId, {
			basis: 'contract',
			textVersion: 'payment-import',
			givenAt: formatIsoDay()
		});
	}

	const stage = await readPaymentStage(tx, interactionId);

	if (stage.kind === 'current' && !stage.marked) {
		await markChecklistItemIn(owner, tx, interactionId, PAYMENT_CHECKLIST_KEY);
	}

	const result = target.kind === 'new' ? 'created' : 'updated';

	await tx
		.update(exchangeMessages)
		.set({
			interactionId,
			responseBody: { result, interactionId, organizationId, stage: stage.kind },
			closedAt: sql`now()`
		})
		.where(eq(exchangeMessages.id, message.id));

	publishAfterCommit(tx, interactionId, { type: 'interaction.changed' });

	await recordAuditEvent(
		ctx,
		{
			type: 'exchange.message_received',
			outcome: 'success',
			subject: { type: 'interaction', id: interactionId },
			details: { exchangeMessageId: message.id, interactionId }
		},
		tx
	);

	return {
		result,
		stage,
		personFound: target.kind === 'existing' || target.found !== null,
		interactionId
	};
}

/**
 * Отказ записи не должен уносить её след: транзакция откатывается целиком,
 * вместе со строкой журнала, и запись, которую загружали и не смогли
 * применить, исчезла бы бесследно. След пишется после отката, своей
 * транзакцией, с причиной словами; строка прежнего отказа переписывается
 * новой причиной, применённая — не трогается.
 */
async function recordRefusal(
	instance: string,
	row: ValidRow,
	requestHash: string,
	payload: Record<string, unknown>,
	reason: string
): Promise<void> {
	await getDb()
		.insert(exchangeMessages)
		.values({
			direction: 'inbound',
			system: 'cms',
			instance,
			eventType: EXCHANGE_EVENT_TYPES.paymentConfirmed,
			eventId: paymentEventId(row.record.orderId),
			externalId: row.record.orderId,
			state: 'failed',
			payload,
			requestHash,
			lastError: reason,
			closedAt: sql`now()`
		})
		.onConflictDoUpdate({
			target: [
				exchangeMessages.direction,
				exchangeMessages.system,
				exchangeMessages.instance,
				exchangeMessages.eventId
			],
			set: { payload, requestHash, lastError: reason, closedAt: sql`now()` },
			setWhere: eq(exchangeMessages.state, 'failed')
		});
}

async function applyRow(
	ctx: ActorContext,
	options: ImportOptions,
	row: ValidRow
): Promise<PaymentRowView> {
	const requestHash = recordHash(row.record);
	const payload = journalPayload(options.instance, row.record, row.programId);

	// Одна область следа просмотра на запись: контакты, раскрытые при заведении
	// человека, — одно событие. Область снаружи транзакции потому, что след
	// пишется другим соединением.
	const apply = () =>
		withPiiTrace(ctx, () =>
			withTransaction(ctx, (tx) =>
				applyInTransaction(ctx, tx, { ...options, row, requestHash, payload })
			)
		);

	const run = async (): Promise<Applied> => {
		try {
			return await apply();
		} catch (error) {
			if (!isUniqueViolation(error)) {
				throw error;
			}

			// Пока шла наша транзакция, соседняя завела то же дело или того же
			// человека. Наша откатилась целиком — повтор найдёт заведённое.
			try {
				return await apply();
			} catch (retried) {
				if (!isUniqueViolation(retried)) {
					throw retried;
				}

				throw new ConflictError(
					'Эту оплату прямо сейчас загружает другой запрос: повторите загрузку'
				);
			}
		}
	};

	try {
		const applied = await run();

		if (applied.result === 'unchanged') {
			return rowView(
				row,
				'unchanged',
				unchangedNote(applied.message, row.record),
				row.issues,
				applied.message.interactionId
			);
		}

		return rowView(
			row,
			applied.result === 'created' ? 'create' : 'update',
			[
				...(applied.result === 'created'
					? [
							applied.personFound
								? 'Физлицо найдено в справочнике'
								: 'Физлицо заведено в справочнике'
						]
					: []),
				stageNote(applied.stage, true)
			],
			row.issues,
			applied.interactionId
		);
	} catch (error) {
		// Предметный отказ объясним словами — его читает администратор. Всё
		// остальное — наша поломка: её разбирают по логу, а не по журналу обмена.
		if (!(error instanceof AppError)) {
			throw error;
		}

		await recordRefusal(options.instance, row, requestHash, payload, error.message);

		return rowView(row, 'error', [], refusalIssues(error));
	}
}

/**
 * Загрузка оплат: каждая запись своей транзакцией, по порядку файла. Записи с
 * претензиями не применяются — остальные применяются, и итог показывает, чем
 * кончилась каждая.
 */
export async function importPayments(
	ctx: ActorContext,
	file: { name: string; bytes: Uint8Array }
): Promise<PaymentsView> {
	requirePermission(ctx, 'integrations.manage');

	const parsed = readPaymentsFile(file.name, file.bytes);

	if (parsed.rows.length === 0) {
		throw new ValidationError(
			'Оплаты не загружены',
			parsed.fileIssues.length > 0 ? parsed.fileIssues : ['В файле нет ни одной записи']
		);
	}

	const options = await importOptions();
	const checked = await getDb().transaction((tx) => checkRows(tx, parsed));
	const rows: PaymentRowView[] = [];

	for (const row of checked) {
		rows.push(
			row.record === null || row.programId === null || row.issues.length > 0
				? rowView(row, 'error', [])
				: await applyRow(ctx, options, row as ValidRow)
		);
	}

	return toPaymentsView(rows, parsed.fileIssues, true);
}

/**
 * Есть ли у дела факт оплаты с сайта. Его спрашивает вход на стадию: пункт
 * «Оплата получена» новой записи отмечается по сохранённому факту.
 */
export async function hasPaymentFact(executor: Tx, interactionId: string): Promise<boolean> {
	const [row] = await executor
		.select({ id: exchangeMessages.id })
		.from(exchangeMessages)
		.where(
			and(
				eq(exchangeMessages.interactionId, interactionId),
				eq(exchangeMessages.direction, 'inbound'),
				eq(exchangeMessages.eventType, EXCHANGE_EVENT_TYPES.paymentConfirmed),
				eq(exchangeMessages.state, 'processed')
			)
		)
		.limit(1);

	return row !== undefined;
}

/**
 * Факт оплаты с сайта для карточки дела; `null` — оплату не загружали.
 *
 * Принимает уже прочитанное взаимодействие, а не идентификатор: область
 * доступа проверил тот, кто его прочитал (`getInteraction`), и строка журнала
 * отдаётся только по делу, которое вызывающему видно. Поток берётся из тела
 * строки — после уничтожения данных человека тело стёрто, и потока нет.
 */
export async function readPaymentFact(
	interaction: InteractionView
): Promise<PaymentFactView | null> {
	const [row] = await getDb()
		.select({
			orderId: exchangeMessages.externalId,
			streamNumber: sql<
				number | null
			>`(${exchangeMessages.payload} #>> '{data,streamNumber}')::int`,
			loadedAt: exchangeMessages.createdAt
		})
		.from(exchangeMessages)
		.where(
			and(
				eq(exchangeMessages.interactionId, interaction.id),
				eq(exchangeMessages.direction, 'inbound'),
				eq(exchangeMessages.eventType, EXCHANGE_EVENT_TYPES.paymentConfirmed),
				eq(exchangeMessages.state, 'processed')
			)
		)
		.orderBy(desc(exchangeMessages.createdAt))
		.limit(1);

	if (row === undefined || row.orderId === null) {
		return null;
	}

	// Стадия, на которой оплата отметится, — из действующей редакции, как у
	// загрузки (`readPaymentStage`): пока дело до неё не дошло, карточка
	// называет её рядом с фактом, а не пишет «не отмечена».
	const stage = paymentStageOf(
		await requireActiveRevisionForWorkspace(getDb(), interaction.workspaceId)
	);

	return {
		orderId: row.orderId,
		streamNumber: row.streamNumber,
		loadedAt: row.loadedAt,
		stageName: stage?.name ?? null
	};
}
