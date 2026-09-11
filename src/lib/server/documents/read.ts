/**
 * Чтение документов и проверка того, кому их видно.
 *
 * Право `documents.read` отвечает на вопрос «можно ли вообще смотреть
 * документы», область доступа — на вопрос «этот конкретный можно?». Документ
 * привязан к взаимодействию, а взаимодействие — к организациям-сторонам:
 * значит, документ виден тому, в чью область попала хотя бы одна из сторон.
 */
import { and, eq, exists, sql } from 'drizzle-orm';
import { id as idSchema } from '$lib/contracts/common';
import type { DocumentView } from '$lib/contracts/documents';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { documents, interactionParties, interactions } from '../db/schema';
import { NotFoundError } from '../errors';
import { requirePermission, scopeFilter } from '../rbac';
import { documentFileName } from './filename';
import { storedFileSize } from './storage';

const documentIdSchema = idSchema('Некорректный идентификатор документа');

export function toDocumentView(row: typeof documents.$inferSelect): DocumentView {
	return {
		id: row.id,
		interactionId: row.interactionId,
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
