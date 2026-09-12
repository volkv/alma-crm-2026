/**
 * Чтение документов и проверка того, кому их видно.
 *
 * Право `documents.read` отвечает на вопрос «можно ли вообще смотреть
 * документы», область доступа — на вопрос «этот конкретный можно?». Документ
 * привязан к взаимодействию, а взаимодействие — к организациям-сторонам:
 * значит, документ виден тому, в чью область попала хотя бы одна из сторон.
 */
import {
	and,
	asc,
	count,
	desc,
	eq,
	exists,
	ilike,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	sql,
	type SQL
} from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';
import { id as idSchema } from '$lib/contracts/common';
import type { PageResult } from '$lib/contracts/common';
import {
	DOCUMENT_FORMAT_MIME_TYPES,
	GENERATED_DOCUMENT_KIND,
	type DocumentListItem,
	type DocumentListQuery,
	type DocumentRevisionView,
	type DocumentSupersession,
	type DocumentView
} from '$lib/contracts/documents';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { documents, interactionParties, interactions, users } from '../db/schema';
import { NotFoundError } from '../errors';
import { requirePermission, scopeFilter } from '../rbac';
import { documentFileName } from './filename';
import { storedFileSize } from './storage';

const documentIdSchema = idSchema('Некорректный идентификатор документа');

/** Редакция, заменившая документ, входит в запрос под своим именем. */
const successor = alias(documents, 'successor');

export function toDocumentView(row: typeof documents.$inferSelect): DocumentView {
	return {
		id: row.id,
		interactionId: row.interactionId,
		supersedesId: row.supersedesId,
		kind: row.kind,
		title: row.title,
		mime: row.mime,
		sizeBytes: row.sizeBytes,
		sha256: row.sha256,
		uploadedBy: row.uploadedBy,
		createdAt: row.createdAt,
		agreedAt: row.agreedAt,
		approvedAt: row.approvedAt,
		inEffectAt: row.inEffectAt
	};
}

/**
 * Есть ли взаимодействие и попало ли оно в область доступа. Взаимодействие
 * видно, если хотя бы одна его сторона — организация из области.
 */
async function isInteractionAccessible(ctx: ActorContext, interactionId: string): Promise<boolean> {
	const db = getDb();

	const inScope =
		ctx.scope.kind === 'all'
			? // Полный доступ видит и взаимодействие, у которого сторон ещё нет;
				// подзапрос ниже такое взаимодействие отверг бы, потому что сверять
				// не с чем.
				sql`true`
			: exists(
					db
						.select({ one: sql`1` })
						.from(interactionParties)
						.where(
							and(
								eq(interactionParties.interactionId, interactions.id),
								scopeFilter(ctx, interactionParties.organizationId)
							)
						)
				);

	const [row] = await db
		.select({ id: interactions.id })
		.from(interactions)
		.where(and(eq(interactions.id, interactionId), inScope))
		.limit(1);

	return row !== undefined;
}

/**
 * Документ в области доступа вызывающего. Не найден и «есть, но не ваш» —
 * одна и та же ошибка: иначе перебором идентификаторов можно узнать, какие
 * документы существуют за пределами своей области.
 */
export async function assertDocumentAccessible(
	ctx: ActorContext,
	document: { interactionId: string | null }
): Promise<void> {
	if (document.interactionId === null) {
		// Документ вне взаимодействия — типовая форма оператора, а не имущество
		// организации; область доступа к таким записям не применяется, как и к
		// программам с продуктами в справочнике.
		return;
	}

	if (!(await isInteractionAccessible(ctx, document.interactionId))) {
		throw new NotFoundError('Документ не найден');
	}
}

/**
 * Взаимодействие, к которому разрешено привязывать документ. Проверяет и то,
 * что оно существует: иначе несуществующий идентификатор дошёл бы до внешнего
 * ключа и вернулся ошибкой базы вместо внятного отказа.
 */
export async function assertInteractionAccessible(
	ctx: ActorContext,
	interactionId: string
): Promise<void> {
	if (!(await isInteractionAccessible(ctx, interactionId))) {
		throw new NotFoundError('Взаимодействие не найдено');
	}
}

/**
 * Условие «этот документ виден вызывающему» для выборок из `documents`.
 * Коррелирует со столбцом `documents.interaction_id`, поэтому годится только
 * там, где выборка идёт из этой таблицы.
 *
 * Правило то же, что у `assertDocumentAccessible`: документ без взаимодействия
 * — типовая форма оператора, а не имущество организации, и область доступа к
 * нему не применяется.
 */
function documentScopeFilter(ctx: ActorContext): SQL {
	if (ctx.scope.kind === 'all') {
		// Полный доступ видит и документ взаимодействия, у которого сторон ещё
		// нет; подзапрос ниже такой документ отверг бы — сверять не с чем.
		return sql`true`;
	}

	const partyInScope = exists(
		getDb()
			.select({ one: sql`1` })
			.from(interactionParties)
			.where(
				and(
					eq(interactionParties.interactionId, documents.interactionId),
					scopeFilter(ctx, interactionParties.organizationId)
				)
			)
	);

	// `or()` в drizzle объявлен как «SQL или undefined» — он выбрасывает пустые
	// ветки. Область доступа обязана быть условием, а не «может быть, условием»,
	// поэтому ветки соединяются шаблоном.
	return sql`(${isNull(documents.interactionId)} or ${partyInScope})`;
}

const DOCUMENT_SORT_COLUMNS = {
	title: documents.title,
	// Формат — это тип файла, названный словом; сортировка по типу ставит рядом
	// одинаковые форматы, а колонку «Формат» открывают именно за этим.
	format: documents.mime,
	sizeBytes: documents.sizeBytes,
	createdAt: documents.createdAt
} as const satisfies Record<DocumentListQuery['sortBy'], PgColumn>;

const FACT_COLUMNS = {
	agreed: documents.agreedAt,
	approved: documents.approvedAt,
	in_effect: documents.inEffectAt
} as const;

function factCondition(fact: NonNullable<DocumentListQuery['fact']>): SQL {
	if (fact === 'none') {
		return sql`(${isNull(documents.agreedAt)} and ${isNull(documents.approvedAt)} and ${isNull(
			documents.inEffectAt
		)})`;
	}

	return isNotNull(FACT_COLUMNS[fact]);
}

function ordered(column: PgColumn, direction: 'asc' | 'desc'): SQL {
	return direction === 'desc' ? desc(column) : asc(column);
}

function toDocumentListItem(
	row: typeof documents.$inferSelect,
	interactionTitle: string | null,
	authorName: string | null,
	supersededBy: { id: string | null; createdAt: Date | null }
): DocumentListItem {
	const generated = row.kind === GENERATED_DOCUMENT_KIND;

	return {
		id: row.id,
		title: row.title,
		kind: generated ? 'generated' : 'uploaded',
		uploadedKind: generated ? null : row.kind,
		mime: row.mime,
		sizeBytes: row.sizeBytes,
		createdAt: row.createdAt,
		agreedAt: row.agreedAt,
		approvedAt: row.approvedAt,
		inEffectAt: row.inEffectAt,
		interaction:
			row.interactionId === null || interactionTitle === null
				? null
				: { id: row.interactionId, title: interactionTitle },
		authorName,
		supersededBy:
			supersededBy.id === null || supersededBy.createdAt === null
				? null
				: { id: supersededBy.id, createdAt: supersededBy.createdAt }
	};
}

/**
 * Страница списка документов: одна выборка со страницей строк и счётчиком,
 * всё остальное — отбор в условии. Название взаимодействия и имя автора
 * приходят соединением: список показывает их текстом, а запрос за каждым
 * именем отдельно превратил бы страницу в N+1.
 */
export async function listDocuments(
	ctx: ActorContext,
	query: DocumentListQuery
): Promise<PageResult<DocumentListItem>> {
	requirePermission(ctx, 'documents.read');

	const conditions: SQL[] = [documentScopeFilter(ctx)];

	if (query.interactionId !== null) {
		conditions.push(eq(documents.interactionId, query.interactionId));
	}

	if (query.kind !== null) {
		// Столбца «откуда файл» в схеме нет: генерация помечает свои записи
		// видом `generated`, поэтому всё остальное — загруженное человеком.
		conditions.push(
			query.kind === 'generated'
				? eq(documents.kind, GENERATED_DOCUMENT_KIND)
				: ne(documents.kind, GENERATED_DOCUMENT_KIND)
		);
	}

	if (query.format !== null) {
		conditions.push(eq(documents.mime, DOCUMENT_FORMAT_MIME_TYPES[query.format]));
	}

	if (query.fact !== null) {
		conditions.push(factCondition(query.fact));
	}

	// Действующая редакция — та, которую никто не заменил. Отбор идёт по базе, а
	// не прячет строки в разметке: иначе страница из двадцати пяти строк
	// показывала бы пять, а счётчик — двадцать пять.
	if (query.revisions === 'current') {
		conditions.push(isNull(successor.id));
	}

	if (query.q !== null) {
		const pattern = `%${query.q}%`;
		const search = or(ilike(documents.title, pattern), ilike(interactions.title, pattern));

		if (search !== undefined) {
			conditions.push(search);
		}
	}

	const where = and(...conditions);
	const db = getDb();

	const [rows, totals] = await Promise.all([
		db
			.select({
				document: documents,
				interactionTitle: interactions.title,
				authorName: users.fullName,
				supersededById: successor.id,
				supersededAt: successor.createdAt
			})
			.from(documents)
			.leftJoin(interactions, eq(interactions.id, documents.interactionId))
			.leftJoin(users, eq(users.id, documents.uploadedBy))
			.leftJoin(successor, eq(successor.supersedesId, documents.id))
			.where(where)
			// Второй ключ сортировки — первичный: DOCX и PDF одного соглашения
			// пишутся одной командой, и без него они меняются местами между
			// страницами.
			.orderBy(ordered(DOCUMENT_SORT_COLUMNS[query.sortBy], query.sortDirection), asc(documents.id))
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db
			.select({ value: count() })
			.from(documents)
			.leftJoin(interactions, eq(interactions.id, documents.interactionId))
			.leftJoin(successor, eq(successor.supersedesId, documents.id))
			.where(where)
	]);

	return {
		items: rows.map((row) =>
			toDocumentListItem(row.document, row.interactionTitle, row.authorName, {
				id: row.supersededById,
				createdAt: row.supersededAt
			})
		),
		total: totals[0]?.value ?? 0,
		page: query.page,
		pageSize: query.pageSize
	};
}

/**
 * Строка документа из базы или `NotFoundError`. Область доступа здесь не
 * проверяется: её проверяет тот, кто решает, что с документом делать.
 */
export async function selectDocumentRow(
	documentId: string
): Promise<typeof documents.$inferSelect> {
	// Идентификатор приходит из адреса, то есть от кого угодно. Непохожая на
	// UUID строка — это не «ошибка ввода», а запрос несуществующей записи.
	if (!documentIdSchema.safeParse(documentId).success) {
		throw new NotFoundError('Документ не найден');
	}

	const [row] = await getDb().select().from(documents).where(eq(documents.id, documentId)).limit(1);

	if (row === undefined) {
		throw new NotFoundError('Документ не найден');
	}

	return row;
}

/**
 * Редакция, заменившая этот документ, или `null` у действующей. Отдельный
 * запрос, потому что спрашивают об этом там, где документ уже прочитан.
 */
export async function supersedingDocumentId(documentId: string): Promise<string | null> {
	const [row] = await getDb()
		.select({ id: documents.id })
		.from(documents)
		.where(eq(documents.supersedesId, documentId))
		.limit(1);

	return row?.id ?? null;
}

/**
 * Цепочка редакций документа: от первой к действующей.
 *
 * Считается рекурсивным запросом в обе стороны — сначала вверх, до редакции,
 * которая никого не заменяла, потом вниз по заменившим. Иначе пришлось бы
 * ходить в базу по разу на редакцию, а карточка открывается ради всей истории
 * сразу.
 */
export async function listDocumentRevisions(
	ctx: ActorContext,
	documentId: string
): Promise<DocumentRevisionView[]> {
	requirePermission(ctx, 'documents.read');

	const row = await selectDocumentRow(documentId);
	await assertDocumentAccessible(ctx, row);

	const db = getDb();

	const ids = await db.execute<{ id: string }>(sql`
		with recursive earlier as (
			select ${documents.id} as id, ${documents.supersedesId} as supersedes_id
			from ${documents}
			where ${documents.id} = ${row.id}
			union all
			select d.id, d.supersedes_id
			from ${documents} d
			join earlier on d.id = earlier.supersedes_id
		),
		first_revision as (
			select id from earlier where supersedes_id is null
		),
		line as (
			select id from first_revision
			union all
			select d.id
			from ${documents} d
			join line on d.supersedes_id = line.id
		)
		select id from line
	`);

	const chain = [...ids].map((item) => item.id);

	const rows = await db
		.select({
			document: documents,
			authorName: users.fullName,
			supersededById: successor.id
		})
		.from(documents)
		.leftJoin(users, eq(users.id, documents.uploadedBy))
		.leftJoin(successor, eq(successor.supersedesId, documents.id))
		.where(inArray(documents.id, chain))
		.orderBy(asc(documents.createdAt), asc(documents.id));

	return rows.map((item) => ({
		id: item.document.id,
		title: item.document.title,
		mime: item.document.mime,
		sizeBytes: item.document.sizeBytes,
		createdAt: item.document.createdAt,
		authorName: item.authorName,
		isCurrent: item.supersededById === null
	}));
}

/**
 * Замены среди документов взаимодействия. Панель документов карточки по
 * умолчанию показывает только действующие редакции, и чтобы объяснить, почему
 * остальные скрыты, ей нужно знать, чем именно их заменили.
 */
export async function listInteractionSupersessions(
	ctx: ActorContext,
	interactionId: string
): Promise<DocumentSupersession[]> {
	requirePermission(ctx, 'interactions.read');
	await assertInteractionAccessible(ctx, interactionId);

	const rows = await getDb()
		.select({
			documentId: documents.id,
			supersededById: successor.id,
			supersededAt: successor.createdAt
		})
		.from(documents)
		.innerJoin(successor, eq(successor.supersedesId, documents.id))
		.where(eq(documents.interactionId, interactionId));

	return rows;
}

/** Всё, что нужно, чтобы отдать файл: путь в хранилище, имя и размер. */
export type DocumentDownload = {
	document: DocumentView;
	/** Путь относительно каталога данных. */
	filePath: string;
	fileName: string;
	sizeBytes: number;
};

/**
 * Готовит скачивание и записывает его в журнал. Сам файл читает транспорт:
 * сервис не строит HTTP-ответ и не держит содержимое в памяти.
 */
export async function readDocumentForDownload(
	ctx: ActorContext,
	documentId: string
): Promise<DocumentDownload> {
	requirePermission(ctx, 'documents.read');

	const row = await selectDocumentRow(documentId);
	await assertDocumentAccessible(ctx, row);

	const sizeBytes = await storedFileSize(row.filePath);

	if (sizeBytes === null) {
		throw new Error(`Файл документа ${row.id} отсутствует в хранилище: ${row.filePath}`);
	}

	// Файл неизменяем; разошедшийся размер означает, что в хранилище кто-то
	// лазил мимо приложения, и отдавать такой файл как исходный нельзя.
	if (sizeBytes !== row.sizeBytes) {
		throw new Error(
			`Размер файла документа ${row.id} на диске (${sizeBytes}) не совпадает с записью (${row.sizeBytes})`
		);
	}

	await recordAuditEvent(ctx, {
		type: 'documents.downloaded',
		outcome: 'success',
		subject: { type: 'document', id: row.id },
		details: row.interactionId === null ? {} : { interactionId: row.interactionId }
	});

	return {
		document: toDocumentView(row),
		filePath: row.filePath,
		fileName: documentFileName(row.title, row.mime),
		sizeBytes
	};
}
