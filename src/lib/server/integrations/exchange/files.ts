/**
 * Выдача вложения обмена по ключу объекта.
 *
 * Файлы внутри сообщений не ездят никогда — только ссылка, и получатель
 * забирает файл сам, своим ключом доступа (`docs/exchange-contract.md`,
 * раздел 2). Хранилище наружу не публикуется, и временных ссылок самого
 * хранилища мы тоже не раздаём: они переживают отзыв ключа.
 *
 * Проверяется принадлежность: объект обязан относиться к взаимодействию,
 * связанному с **настроенным подключением обмена** — заявкой с сайта того же
 * экземпляра CMS либо учебной группой того же экземпляра LMS. Чужой ключ
 * объекта — `404`, а не `403`: перебором ключей нельзя узнать, что у нас лежит.
 */
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { externalSourceOf } from '$lib/contracts/exchange';
import type { ActorContext } from '../../actor';
import { getDb } from '../../db';
import { documents, interactions, learningGroups } from '../../db/schema';
import { NotFoundError } from '../../errors';
import { requirePermission } from '../../rbac';
import { getExchangeSettings } from '../settings';

export type ExchangeFile = {
	documentId: string;
	interactionId: string;
	filePath: string;
	name: string;
	mime: string;
	sizeBytes: number;
	sha256: string;
};

/**
 * Запись документа по ключу объекта; `NotFoundError` — ключа нет либо объект не
 * относится ни к одному подключению обмена.
 *
 * Права отдельного у выдачи нет: `exchange.intake` есть у каждого ключа роли
 * `service`, а право без второго носителя ничего не разграничивает — доступ к
 * конкретному файлу решает проверка принадлежности.
 */
export async function readExchangeFile(
	ctx: ActorContext,
	storageKey: string
): Promise<ExchangeFile> {
	requirePermission(ctx, 'exchange.intake');

	const settings = await getExchangeSettings();

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
		.where(
			and(
				eq(documents.filePath, storageKey),
				isNotNull(documents.interactionId),
				or(
					eq(interactions.externalSource, externalSourceOf('cms', settings.cms.instance)),
					// Взаимодействие связано с системой обучения не внешней ссылкой, а
					// заведённым потоком: заявку на группу отправляли из карточки.
					sql`exists (${getDb()
						.select({ one: sql`1` })
						.from(learningGroups)
						.where(
							and(
								eq(learningGroups.interactionId, interactions.id),
								eq(learningGroups.system, 'lms'),
								eq(learningGroups.instance, settings.lms.instance)
							)
						)})`
				)
			)
		)
		.limit(1);

	if (row === undefined || row.interactionId === null) {
		throw new NotFoundError('Файла с таким ключом нет');
	}

	return { ...row, interactionId: row.interactionId };
}
