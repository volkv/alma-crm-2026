/**
 * Загрузка файла документа и новых его редакций.
 *
 * Что можно загружать, описано контрактом `uploadDocumentSchema` — тем же,
 * которым проверяется форма в браузере. Здесь он применяется ещё раз: контракт
 * на клиенте это удобство, а не защита.
 *
 * Новая редакция приезжает этим же путём: файл неизменяем, поэтому исправленное
 * соглашение — это новая запись со ссылкой на ту, которую она заменила, а не
 * правка старой. Вид, название и взаимодействие редакция берёт у заменяемой:
 * иначе «редакцией» можно было бы назвать любой другой файл, и цепочка
 * перестала бы быть цепочкой одного документа.
 */
import {
	uploadDocumentSchema,
	type DocumentView,
	type UploadDocumentInput
} from '$lib/contracts/documents';
import { eq } from 'drizzle-orm';
import type { AuditDetails } from '$lib/contracts/audit';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { documentContractItems, documents } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { publishAfterCommit } from '../live/publish';
import { ConflictError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { touchInteraction } from '../stages/commands';
import {
	assertDocumentAccessible,
	assertInteractionAccessible,
	selectDocumentRow,
	supersedingDocumentId,
	toDocumentView
} from './read';
import { discardStaged, promoteBlob, stageBlob } from './storage';

/** Файл в том виде, в каком его отдал транспорт. */
export type UploadedFile = {
	/** Тип, заявленный клиентом; содержимое сверяется с ним в хранилище. */
	mime: string;
	bytes: Uint8Array;
};

export type UploadDocumentCommand = {
	/** Документ может жить вне взаимодействия — например, типовая форма. */
	interactionId?: string | null;
	/** Вид документа: соглашение, приказ, акт, отчёт. */
	kind: string;
	title: string;
	file: UploadedFile;
};

export type UploadDocumentRevisionCommand = {
	/** Редакция, которую заменяет этот файл. */
	supersedesId: string;
	file: UploadedFile;
};

export async function uploadDocument(
	ctx: ActorContext,
	input: UploadDocumentCommand
): Promise<DocumentView> {
	requirePermission(ctx, 'documents.write');

	const parsed = parseUpload({
		interactionId: input.interactionId ?? null,
		supersedesId: null,
		kind: input.kind,
		title: input.title,
		file: input.file
	});

	if (parsed.interactionId !== null) {
		await assertInteractionAccessible(ctx, parsed.interactionId);
	}

	return writeDocument(ctx, parsed, input.file);
}

/**
 * Новая редакция существующего документа. Заменяемая редакция должна быть
 * видна вызывающему и ещё никем не заменена: у документа не бывает двух
 * «следующих» редакций, иначе на вопрос «какая действует» ответа нет.
 */
export async function uploadDocumentRevision(
	ctx: ActorContext,
	input: UploadDocumentRevisionCommand
): Promise<DocumentView> {
	requirePermission(ctx, 'documents.write');

	const superseded = await selectDocumentRow(input.supersedesId);

	await assertDocumentAccessible(ctx, superseded);

	// Ту же проверку делает частичный уникальный индекс, но код `23505` человеку
	// ничего не объясняет, а две вкладки с одной и той же кнопкой «Загрузить
	// новую редакцию» — обычное дело.
	if ((await supersedingDocumentId(superseded.id)) !== null) {
		throw new ConflictError('У этой редакции уже есть следующая');
	}

	const parsed = parseUpload({
		interactionId: superseded.interactionId,
		supersedesId: superseded.id,
		kind: superseded.kind,
		title: superseded.title,
		file: input.file
	});

	return writeDocument(ctx, parsed, input.file);
}

/** Проверка контрактом: та же схема, что и у формы в браузере. */
function parseUpload(input: {
	interactionId: string | null;
	supersedesId: string | null;
	kind: string;
	title: string;
	file: UploadedFile;
}): UploadDocumentInput {
	const parsed = uploadDocumentSchema.safeParse({
		interactionId: input.interactionId,
		supersedesId: input.supersedesId,
		kind: input.kind,
		title: input.title,
		mime: input.file.mime,
		sizeBytes: input.file.bytes.byteLength
	});

	if (!parsed.success) {
		throw new ValidationError(
			'Файл не прошёл проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	return parsed.data;
}

/** Протокол записи из `storage.ts`: сначала файл, потом строка, потом журнал. */
async function writeDocument(
	ctx: ActorContext,
	fields: UploadDocumentInput,
	file: UploadedFile
): Promise<DocumentView> {
	const staged = await stageBlob(file.bytes, fields.mime);

	try {
		return await withTransaction(ctx, async (tx) => {
			await promoteBlob(staged);

			const [row] = await tx
				.insert(documents)
				.values({
					interactionId: fields.interactionId,
					supersedesId: fields.supersedesId,
					kind: fields.kind,
					title: fields.title,
					filePath: staged.relativePath,
					mime: staged.mime,
					sizeBytes: staged.sizeBytes,
					sha256: staged.sha256,
					uploadedBy: ctx.user?.id ?? null
				})
				.returning();

			const details: AuditDetails = {};

			if (fields.interactionId !== null) {
				details.interactionId = fields.interactionId;
				await touchInteraction(tx, fields.interactionId);
				publishAfterCommit(tx, fields.interactionId, { type: 'interaction.changed' });
			}

			if (fields.supersedesId !== null) {
				details.documentId = row.id;
				details.supersededDocumentId = fields.supersedesId;

				// Новая редакция акта — тот же акт: позиции, которые он передаёт,
				// переходят на неё, иначе отметка на подписанном скане ничего бы
				// не передала.
				const inherited = await tx
					.select({ contractItemId: documentContractItems.contractItemId })
					.from(documentContractItems)
					.where(eq(documentContractItems.documentId, fields.supersedesId));

				if (inherited.length > 0) {
					await tx
						.insert(documentContractItems)
						.values(inherited.map((link) => ({ documentId: row.id, ...link })));
				}
			}

			await recordAuditEvent(
				ctx,
				{
					type: fields.supersedesId === null ? 'documents.uploaded' : 'documents.version_uploaded',
					outcome: 'success',
					subject: { type: 'document', id: row.id },
					details
				},
				tx
			);

			return toDocumentView(row);
		});
	} catch (error) {
		// Файл без строки в базе — мусор, который никто не найдёт: компенсируем.
		await discardStaged([staged], error);
		throw error;
	}
}
