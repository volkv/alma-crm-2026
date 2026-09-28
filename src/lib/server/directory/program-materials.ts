/**
 * Материалы образовательной программы: файлы с её полным описанием.
 *
 * Краткое описание живёт колонкой `programs.description`, а подробное —
 * документами: программой курса, презентацией, учебным планом. Файл материала —
 * обычная строка `documents` без взаимодействия с видом
 * `PROGRAM_MATERIAL_DOCUMENT_KIND`, к программе его привязывает
 * `program_documents`. Хранилище, проверка содержимого и потолок размера — те
 * же, что у документов дела (`documents/storage.ts`, `documents/mime.ts`):
 * заводить второй путь к файлам значило бы заводить вторые правила.
 *
 * Права — права справочника программ, а не документов: каталог общий, область
 * доступа к нему не применяется (`listPrograms`), и материал программы видит
 * всякий, кто видит саму программу. Поэтому скачивание идёт своим маршрутом
 * карточки, а не общим `/documents/[id]/download`: тот пускает к документу без
 * взаимодействия только полный доступ.
 *
 * «Убрать из программы» снимает связь, а не удаляет файл. Документы поштучно в
 * системе не удаляются (`documents/storage.ts`, `discardBlob`): файл неизменяем,
 * на него ссылается журнал, а письмо, ушедшее вузу с этим вложением, должно и
 * дальше указывать на то, что было отправлено. Строка документа остаётся в
 * разделе «Документы» у полного доступа.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { id as idSchema } from '$lib/contracts/common';
import { PROGRAM_MATERIAL_MAX_FILES, type ProgramMaterialView } from '$lib/contracts/directory';
import {
	MAX_DOCUMENT_SIZE_BYTES,
	PROGRAM_MATERIAL_DOCUMENT_KIND,
	PROGRAM_MATERIAL_MIME_TYPES,
	uploadDocumentSchema,
	type UploadDocumentInput
} from '$lib/contracts/documents';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { documents, programDocuments, programs } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { documentFileName } from '../documents/filename';
import { extensionForMime } from '../documents/mime';
import {
	discardStaged,
	promoteBlob,
	stageBlob,
	storedFileSize,
	type StagedBlob
} from '../documents/storage';
import { NotFoundError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';

export type ProgramMaterial = {
	documentId: string;
	programId: string;
	title: string;
	/** Имя файла для вложения, с расширением по mime. */
	fileName: string;
	mime: string;
	sizeBytes: number;
	sha256: string;
	filePath: string;
};

/** Файл материала в том виде, в каком его отдал транспорт. */
export type ProgramMaterialFile = {
	/** Имя файла у человека: из него получается название материала. */
	name: string;
	/** Тип, заявленный клиентом; содержимое сверяется с ним в хранилище. */
	mime: string;
	bytes: Uint8Array;
};

/** Потолок названия — тот же, что у документа в контракте загрузки. */
const MAX_TITLE_LENGTH = 300;

const documentIdSchema = idSchema('Некорректный идентификатор документа');

/**
 * Идентификатор документа приходит из формы или адреса, то есть от кого
 * угодно. Непохожая на UUID строка — запрос несуществующего материала, а не
 * повод уронить запрос ошибкой разбора в базе.
 */
function assertMaterialId(documentId: string): void {
	if (!documentIdSchema.safeParse(documentId).success) {
		throw new NotFoundError('Материал не найден');
	}
}

const materialColumns = {
	documentId: documents.id,
	programId: programDocuments.programId,
	title: documents.title,
	mime: documents.mime,
	sizeBytes: documents.sizeBytes,
	sha256: documents.sha256,
	filePath: documents.filePath,
	linkedAt: programDocuments.createdAt
};

type MaterialRow = {
	documentId: string;
	programId: string;
	title: string;
	mime: string;
	sizeBytes: number;
	sha256: string;
	filePath: string;
	linkedAt: Date;
};

function toProgramMaterial(row: MaterialRow): ProgramMaterial {
	return {
		documentId: row.documentId,
		programId: row.programId,
		title: row.title,
		fileName: documentFileName(row.title, row.mime),
		mime: row.mime,
		sizeBytes: row.sizeBytes,
		sha256: row.sha256,
		filePath: row.filePath
	};
}

/**
 * Материалы программ одним запросом, в порядке загрузки внутри программы.
 *
 * Прав не проверяет: это чтение для серверного кода, который сам решил, что
 * программы вызывающему видны (карточка, письмо вузу с вложениями). Путь к
 * файлу и хеш — ровно то, что нужно такому коду, и ровно то, чего не должно
 * быть в ответе браузеру.
 */
export async function listProgramMaterials(
	programIds: readonly string[]
): Promise<ProgramMaterial[]> {
	if (programIds.length === 0) {
		return [];
	}

	const rows = await getDb()
		.select(materialColumns)
		.from(programDocuments)
		.innerJoin(documents, eq(documents.id, programDocuments.documentId))
		.where(inArray(programDocuments.programId, [...programIds]))
		// Второй ключ — документ: у связей одной загрузки моменты различаются
		// (`clock_timestamp()` при записи), но строка с одинаковым моментом не
		// должна прыгать между прочтениями.
		.orderBy(asc(programDocuments.createdAt), asc(programDocuments.documentId));

	return rows.map(toProgramMaterial);
}

/** Материалы для карточки программы: без ключа хранилища и хеша. */
export async function listProgramMaterialViews(
	ctx: ActorContext,
	programId: string
): Promise<ProgramMaterialView[]> {
	requirePermission(ctx, 'programs.read');

	const rows = await getDb()
		.select(materialColumns)
		.from(programDocuments)
		.innerJoin(documents, eq(documents.id, programDocuments.documentId))
		.where(eq(programDocuments.programId, programId))
		.orderBy(asc(programDocuments.createdAt), asc(programDocuments.documentId));

	return rows.map((row) => ({
		documentId: row.documentId,
		title: row.title,
		fileName: documentFileName(row.title, row.mime),
		mime: row.mime,
		sizeBytes: row.sizeBytes,
		createdAt: row.linkedAt
	}));
}

/**
 * Название материала из имени файла: без расширения — его вернёт имя при
 * скачивании по типу, и «Программа.pdf.pdf» никому не нужна.
 */
function titleFromFileName(name: string, mime: string): string {
	const extension = extensionForMime(mime);
	const trimmed = name.trim();
	const base =
		extension !== null && trimmed.toLowerCase().endsWith(`.${extension}`)
			? trimmed.slice(0, -(extension.length + 1)).trim()
			: trimmed;

	return (base || 'Материал программы').slice(0, MAX_TITLE_LENGTH);
}

/** Проверка контрактом загрузки документа плюс свой, более узкий список типов. */
function parseMaterial(file: ProgramMaterialFile): UploadDocumentInput {
	if (!(PROGRAM_MATERIAL_MIME_TYPES as readonly string[]).includes(file.mime)) {
		throw new ValidationError('Материал программы — это PDF или DOCX', [
			`Файл «${file.name}» другого типа`
		]);
	}

	const parsed = uploadDocumentSchema.safeParse({
		interactionId: null,
		supersedesId: null,
		kind: PROGRAM_MATERIAL_DOCUMENT_KIND,
		title: titleFromFileName(file.name, file.mime),
		revisionNote: null,
		mime: file.mime,
		sizeBytes: file.bytes.byteLength
	});

	if (!parsed.success) {
		throw new ValidationError(
			`Файл «${file.name}» не прошёл проверку`,
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	return parsed.data;
}

async function assertProgramExists(programId: string): Promise<void> {
	const [row] = await getDb()
		.select({ id: programs.id })
		.from(programs)
		.where(eq(programs.id, programId))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Программа не найдена');
	}
}

/**
 * Прикладывает к программе один или несколько файлов.
 *
 * Протокол записи тот же, что у документа дела (`documents/upload.ts`): сначала
 * все файлы во временные объекты, затем одной транзакцией — перенос, строки
 * документов, связи и журнал. Загрузка из нескольких файлов проходит целиком
 * или не проходит вовсе: половина материалов на карточке после отказа выглядела
 * бы как полный набор.
 */
export async function addProgramMaterials(
	ctx: ActorContext,
	programId: string,
	files: readonly ProgramMaterialFile[]
): Promise<ProgramMaterial[]> {
	await requirePermission(ctx, 'programs.write', {
		type: 'programs.material_added',
		subject: { type: 'program', id: programId }
	});

	if (files.length === 0) {
		throw new ValidationError('Выберите файлы материалов', []);
	}

	if (files.length > PROGRAM_MATERIAL_MAX_FILES) {
		throw new ValidationError(`За раз — не больше ${PROGRAM_MATERIAL_MAX_FILES} файлов`, [
			`Выбрано файлов: ${files.length}`
		]);
	}

	// Всё, что проверяется без хранилища, проверяется до него: отказ по типу
	// третьего файла не должен оставлять за собой два записанных объекта.
	const parsed = files.map(parseMaterial);

	// Файлы одной загрузки едут одним запросом, а у запроса свой потолок
	// (`BODY_SIZE_LIMIT`, docs/deployment.md) — чуть выше потолка одного файла.
	// Сумма в этом зазоре дошла бы сюда, но следующая такая же упёрлась бы в 413
	// без объяснения; правило одно — вместе не больше одного файла.
	const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);

	if (totalBytes > MAX_DOCUMENT_SIZE_BYTES) {
		throw new ValidationError('Вместе файлы больше 25 МиБ', ['Загрузите их в несколько приёмов']);
	}

	await assertProgramExists(programId);

	const staged: StagedBlob[] = [];

	try {
		for (const [index, file] of files.entries()) {
			staged.push(await stageBlob(file.bytes, parsed[index].mime));
		}

		return await withTransaction(ctx, async (tx) => {
			const materials: ProgramMaterial[] = [];

			for (const [index, blob] of staged.entries()) {
				await promoteBlob(blob);

				const [document] = await tx
					.insert(documents)
					.values({
						interactionId: null,
						kind: PROGRAM_MATERIAL_DOCUMENT_KIND,
						title: parsed[index].title,
						filePath: blob.relativePath,
						mime: blob.mime,
						sizeBytes: blob.sizeBytes,
						sha256: blob.sha256,
						uploadedBy: ctx.user?.id ?? null
					})
					.returning();

				// `now()` одинаков на всю транзакцию, и файлы одной загрузки
				// получили бы один момент — порядок, в котором их выбрали, потерялся
				// бы. Момент по часам различает их, а списку его и хватает.
				const [link] = await tx
					.insert(programDocuments)
					.values({ programId, documentId: document.id, createdAt: sql`clock_timestamp()` })
					.returning();

				await recordAuditEvent(
					ctx,
					{
						type: 'programs.material_added',
						outcome: 'success',
						subject: { type: 'document', id: document.id },
						details: { programId }
					},
					tx
				);

				materials.push(
					toProgramMaterial({
						documentId: document.id,
						programId: link.programId,
						title: document.title,
						mime: document.mime,
						sizeBytes: document.sizeBytes,
						sha256: document.sha256,
						filePath: document.filePath,
						linkedAt: link.createdAt
					})
				);
			}

			return materials;
		});
	} catch (error) {
		// Файл без строки в базе — мусор, который никто не найдёт: компенсируем.
		await discardStaged(staged, error);
		throw error;
	}
}

/**
 * Убирает материал с карточки программы: снимает связь, файл и строка
 * документа остаются (почему — в шапке модуля).
 */
export async function removeProgramMaterial(
	ctx: ActorContext,
	programId: string,
	documentId: string
): Promise<void> {
	await requirePermission(ctx, 'programs.write', {
		type: 'programs.material_removed',
		subject: { type: 'program', id: programId }
	});

	assertMaterialId(documentId);

	await withTransaction(ctx, async (tx) => {
		const removed = await tx
			.delete(programDocuments)
			.where(
				and(eq(programDocuments.programId, programId), eq(programDocuments.documentId, documentId))
			)
			.returning({ documentId: programDocuments.documentId });

		if (removed.length === 0) {
			throw new NotFoundError('Материал не найден');
		}

		await recordAuditEvent(
			ctx,
			{
				type: 'programs.material_removed',
				outcome: 'success',
				subject: { type: 'document', id: documentId },
				details: { programId }
			},
			tx
		);
	});
}

/**
 * Готовит скачивание материала и записывает его в журнал. Документ отдаётся,
 * только пока он приложен к этой программе: право на справочник не открывает
 * по подставленному идентификатору любой документ без взаимодействия.
 */
export async function readProgramMaterialForDownload(
	ctx: ActorContext,
	programId: string,
	documentId: string
): Promise<ProgramMaterial> {
	requirePermission(ctx, 'programs.read');
	assertMaterialId(documentId);

	const [row] = await getDb()
		.select(materialColumns)
		.from(programDocuments)
		.innerJoin(documents, eq(documents.id, programDocuments.documentId))
		.where(
			and(eq(programDocuments.programId, programId), eq(programDocuments.documentId, documentId))
		)
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Материал не найден');
	}

	const sizeBytes = await storedFileSize(row.filePath);

	// Файл неизменяем: пропавший или разошедшийся по размеру объект означает,
	// что в хранилище лазили мимо приложения, и отдавать его как исходный нельзя.
	if (sizeBytes !== row.sizeBytes) {
		throw new Error(
			`Файл материала ${row.documentId} в хранилище (${sizeBytes ?? 'нет'}) не совпадает с записью (${row.sizeBytes})`
		);
	}

	await recordAuditEvent(ctx, {
		type: 'documents.downloaded',
		outcome: 'success',
		subject: { type: 'document', id: row.documentId },
		details: { programId }
	});

	return toProgramMaterial(row);
}
