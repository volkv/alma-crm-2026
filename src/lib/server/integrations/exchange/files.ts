/**
 * Выдача вложения обмена по ключу объекта.
 *
 * Файлы внутри сообщений не ездят никогда — только ссылка, и получатель
 * забирает файл сам, своим ключом доступа (`docs/exchange-contract.md`,
 * раздел 2). Хранилище наружу не публикуется, и временных ссылок самого
 * хранилища мы тоже не раздаём: они переживают отзыв ключа.
 *
 * Проверяется принадлежность: объект обязан относиться к взаимодействию,
 * связанному с **подключением того ключа, которым пришли**, — заявкой с сайта
 * этого экземпляра CMS либо учебной группой этого экземпляра LMS. Чужой ключ
 * объекта — `404`, а не `403`: перебором ключей нельзя узнать, что у нас лежит.
 *
 * Именно ключа, а не «любого настроенного подключения»: право `exchange.intake`
 * есть у каждого ключа обмена, и сверка с настройками означала бы, что сайт
 * забирает вложения учебных групп, а система обучения — документы заявок.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { ApiKeyExchangeSystem } from '$lib/contracts/api';
import { externalSourceOf } from '$lib/contracts/exchange';
import type { ActorContext } from '../../actor';
import { getDb } from '../../db';
import { documents, interactions, learningGroups } from '../../db/schema';
import { NotFoundError } from '../../errors';
import { requirePermission } from '../../rbac';

export type ExchangeFile = {
	documentId: string;
	interactionId: string;
	filePath: string;
	name: string;
	mime: string;
	sizeBytes: number;
	sha256: string;
};

/** Подключение обмена того ключа, которым пришли. */
export type ExchangeBinding = { system: ApiKeyExchangeSystem; instance: string };

/**
 * Запись документа по ключу объекта; `NotFoundError` — ключа нет либо объект не
 * относится к подключению этого ключа.
 *
 * Права отдельного у выдачи нет: `exchange.intake` есть у каждого ключа роли
 * `service`, а право без второго носителя ничего не разграничивает — доступ к
 * конкретному файлу решает проверка принадлежности.
 */
export async function readExchangeFile(
	ctx: ActorContext,
	storageKey: string,
	binding: ExchangeBinding
): Promise<ExchangeFile> {
	requirePermission(ctx, 'exchange.intake');

	const belongs =
		binding.system === 'cms'
			? eq(interactions.externalSource, externalSourceOf('cms', binding.instance))
			: // Взаимодействие связано с системой обучения не внешней ссылкой, а
				// заведённым потоком: заявку на группу отправляли из карточки.
				sql`exists (${getDb()
					.select({ one: sql`1` })
					.from(learningGroups)
					.where(
						and(
							eq(learningGroups.interactionId, interactions.id),
							eq(learningGroups.system, 'lms'),
							eq(learningGroups.instance, binding.instance)
						)
					)})`;

	const [row] = await getDb()
		.select({
			documentId: documents.id,
			interactionId: documents.interactionId,
			filePath: documents.filePath,
			name: documents.title,
			mime: documents.mime,
			sizeBytes: documents.sizeBytes,
			sha256: documents.sha256
		})
		.from(documents)
		.innerJoin(interactions, eq(interactions.id, documents.interactionId))
		.where(and(eq(documents.filePath, storageKey), isNotNull(documents.interactionId), belongs))
		.limit(1);

	if (row === undefined || row.interactionId === null) {
		throw new NotFoundError('Файла с таким ключом нет');
	}

	return { ...row, interactionId: row.interactionId };
}
