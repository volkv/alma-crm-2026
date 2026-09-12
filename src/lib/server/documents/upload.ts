/**
 * Загрузка файла документа.
 *
 * Что можно загружать, описано контрактом `uploadDocumentSchema` — тем же,
 * которым проверяется форма в браузере. Здесь он применяется ещё раз: контракт
 * на клиенте это удобство, а не защита.
 */
import { uploadDocumentSchema, type DocumentView } from '$lib/contracts/documents';
import type { AuditDetails } from '$lib/contracts/audit';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { documents } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { touchInteraction } from '../stages/commands';
import { assertInteractionAccessible, toDocumentView } from './read';
import { discardStaged, promoteBlob, stageBlob } from './storage';

export type UploadDocumentCommand = {
	/** Документ может жить вне взаимодействия — например, типовая форма. */
	interactionId?: string | null;
	/** Вид документа: соглашение, приказ, акт, отчёт. */
	kind: string;
	title: string;
	file: {
		/** Тип, заявленный клиентом; содержимое сверяется с ним в хранилище. */
		mime: string;
		bytes: Uint8Array;
	};
};

export async function uploadDocument(
	ctx: ActorContext,
	input: UploadDocumentCommand
): Promise<DocumentView> {
	requirePermission(ctx, 'documents.write');

	const parsed = uploadDocumentSchema.safeParse({
		interactionId: input.interactionId ?? null,
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

	const { interactionId, kind, title, mime } = parsed.data;

	if (interactionId !== null) {
		await assertInteractionAccessible(ctx, interactionId);
	}

	const staged = await stageBlob(input.file.bytes, mime);

	try {
		return await withTransaction(ctx, async (tx) => {
			await promoteBlob(staged);

			const [row] = await tx
				.insert(documents)
				.values({
					interactionId,
					kind,
					title,
					filePath: staged.relativePath,
					mime: staged.mime,
					sizeBytes: staged.sizeBytes,
					sha256: staged.sha256,
					uploadedBy: ctx.user?.id ?? null
				})
				.returning();

			const details: AuditDetails = {};

			if (interactionId !== null) {
				details.interactionId = interactionId;
				await touchInteraction(tx, interactionId);
			}

			await recordAuditEvent(
				ctx,
				{
					type: 'documents.uploaded',
					outcome: 'success',
					subject: { type: 'document', id: row.id },
					details
				},
				tx
			);

			return toDocumentView(row);
		});
	} catch (error) {
		await discardStaged([staged], error);
		throw error;
	}
}
