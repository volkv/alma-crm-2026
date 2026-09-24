/**
 * Кто сейчас в карточке.
 *
 * Запись заводится на **вкладку**, а не на учётную запись: демонстрационной
 * учёткой пользуются несколько экспертов разом, и запись на пользователя
 * схлопнула бы их в одного, а закрытие одной вкладки убрало бы всех.
 * Идентификатор вкладки придумывает сервер при открытии потока и наружу не
 * отдаёт; с учётной записью её связывает сам поток, который открыт по сессии.
 * Браузер не может ни назваться чужим именем, ни продлить чужую запись.
 *
 * Хранение — два ключа на дело: упорядоченное множество «вкладка → когда
 * истекает» и хеш «вкладка → пользователь». Срок у каждой вкладки свой, и
 * вкладка, чей процесс упал, не дождавшись закрытия, пропадает по нему сама —
 * при следующем чтении. Ключам дела целиком тоже поставлен срок: брошенное
 * дело не оставляет в Redis ничего.
 */
import { getRedis } from '../redis';

/** Срок записи вкладки. Поток продлевает её раз в {@link PRESENCE_REFRESH_MS}. */
const PRESENCE_TTL_MS = 40_000;

/** Как часто открытый поток подтверждает, что вкладка ещё здесь. */
export const PRESENCE_REFRESH_MS = 25_000;

/** Срок ключей дела: переживает самую свежую вкладку с запасом. */
const KEY_TTL_SECONDS = 60;

const expiriesKey = (interactionId: string): string => `live:presence:${interactionId}`;
const ownersKey = (interactionId: string): string => `live:presence:${interactionId}:tabs`;

export type PresentTab = { tabId: string; userId: string };

/** Вкладка в карточке: завести или продлить запись. */
export async function markPresent(
	interactionId: string,
	tabId: string,
	userId: string
): Promise<void> {
	await getRedis()
		.multi()
		.zadd(expiriesKey(interactionId), Date.now() + PRESENCE_TTL_MS, tabId)
		.hset(ownersKey(interactionId), tabId, userId)
		.expire(expiriesKey(interactionId), KEY_TTL_SECONDS)
		.expire(ownersKey(interactionId), KEY_TTL_SECONDS)
		.exec();
}

/** Вкладка ушла: поток закрылся. */
export async function markGone(interactionId: string, tabId: string): Promise<void> {
	await getRedis()
		.multi()
		.zrem(expiriesKey(interactionId), tabId)
		.hdel(ownersKey(interactionId), tabId)
		.exec();
}

/** Вкладки в карточке сейчас; просроченные попутно удаляются. */
export async function readPresence(interactionId: string): Promise<PresentTab[]> {
	const redis = getRedis();
	const now = Date.now();
	const expired = await redis.zrangebyscore(expiriesKey(interactionId), '-inf', now);

	if (expired.length > 0) {
		await redis
			.multi()
			.zrem(expiriesKey(interactionId), ...expired)
			.hdel(ownersKey(interactionId), ...expired)
			.exec();
	}

	const tabIds = await redis.zrangebyscore(expiriesKey(interactionId), now, '+inf');

	if (tabIds.length === 0) {
		return [];
	}

	const owners = await redis.hmget(ownersKey(interactionId), ...tabIds);
	const tabs: PresentTab[] = [];

	tabIds.forEach((tabId, index) => {
		const userId = owners[index];

		// Срок в множестве есть, а владельца нет — вкладку только что закрыли
		// между двумя чтениями. Её уже нет, и показывать её незачем.
		if (userId !== null && userId !== undefined) {
			tabs.push({ tabId, userId });
		}
	});

	return tabs;
}
