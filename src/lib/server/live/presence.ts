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
 *
 * Рядом — занятость: кто набирает комментарий и у кого открыта форма правки.
 * Она заводится не на вкладку, а на **сессию**: сигнал шлёт обычный запрос
 * браузера, а вкладку знает только её поток. Сессия и отделяет «себя» от
 * коллеги под той же демонстрационной учёткой. В Redis ложится не сам
 * идентификатор сессии, а его отпечаток (`sessionMark`), — по записи
 * занятости войти чужой сессией нельзя. Устройство то же: срок на запись,
 * владелец в хеше, срок ключам дела.
 */
import { createHash } from 'node:crypto';
import {
	EDITING_TTL_MS,
	LIVE_ACTIVITIES,
	TYPING_TTL_MS,
	type LiveActivityKind
} from '$lib/contracts/live';
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

const ACTIVITY_TTL_MS: Record<LiveActivityKind, number> = {
	typing: TYPING_TTL_MS,
	editing: EDITING_TTL_MS
};

const activityKey = (interactionId: string, kind: LiveActivityKind): string =>
	`live:activity:${interactionId}:${kind}`;
const activityOwnersKey = (interactionId: string, kind: LiveActivityKind): string =>
	`live:activity:${interactionId}:${kind}:owners`;

/** Отпечаток сессии: различает сессии, но в сессию не пускает. */
export function sessionMark(sessionId: string): string {
	return createHash('sha256').update(sessionId).digest('base64url').slice(0, 22);
}

/** Ответ первой команды транзакции; сбой транзакции или команды — исключение. */
function firstResult(results: [Error | null, unknown][] | null): unknown {
	if (results === null) {
		throw new Error('Транзакция Redis прервана');
	}

	const [failure, value] = results[0];

	if (failure !== null) {
		throw failure;
	}

	return value;
}

export type Activity = { kind: LiveActivityKind; session: string; userId: string };

/**
 * Сессия занята делом: завести или продлить запись. Возвращает, сколько
 * миллисекунд назад запись продлевалась в прошлый раз (`null` — её не было), —
 * по этому числу вызывающий решает, будить ли зрителей.
 */
export async function markActive(
	interactionId: string,
	kind: LiveActivityKind,
	session: string,
	userId: string
): Promise<number | null> {
	const ttl = ACTIVITY_TTL_MS[kind];
	const now = Date.now();
	const previous = firstResult(
		await getRedis()
			.multi()
			.zscore(activityKey(interactionId, kind), session)
			.zadd(activityKey(interactionId, kind), now + ttl, session)
			.hset(activityOwnersKey(interactionId, kind), session, userId)
			.expire(activityKey(interactionId, kind), KEY_TTL_SECONDS)
			.expire(activityOwnersKey(interactionId, kind), KEY_TTL_SECONDS)
			.exec()
	);

	if (typeof previous !== 'string') {
		return null;
	}

	const expiry = Number(previous);

	return expiry <= now ? null : now - (expiry - ttl);
}

/** Сессия закончила: отправила комментарий, закрыла форму, ушла. `true` — запись была. */
export async function markIdle(
	interactionId: string,
	kind: LiveActivityKind,
	session: string
): Promise<boolean> {
	const removed = firstResult(
		await getRedis()
			.multi()
			.zrem(activityKey(interactionId, kind), session)
			.hdel(activityOwnersKey(interactionId, kind), session)
			.exec()
	);

	return typeof removed === 'number' && removed > 0;
}

/** Занятость дела сейчас; просроченные записи попутно удаляются. */
export async function readActivity(interactionId: string): Promise<Activity[]> {
	const redis = getRedis();
	const now = Date.now();
	const found: Activity[] = [];

	for (const kind of LIVE_ACTIVITIES) {
		const key = activityKey(interactionId, kind);
		const expired = await redis.zrangebyscore(key, '-inf', now);

		if (expired.length > 0) {
			await redis
				.multi()
				.zrem(key, ...expired)
				.hdel(activityOwnersKey(interactionId, kind), ...expired)
				.exec();
		}

		const sessions = await redis.zrangebyscore(key, now, '+inf');

		if (sessions.length === 0) {
			continue;
		}

		const owners = await redis.hmget(activityOwnersKey(interactionId, kind), ...sessions);

		sessions.forEach((session, index) => {
			const userId = owners[index];

			if (userId !== null && userId !== undefined) {
				found.push({ kind, session, userId });
			}
		});
	}

	return found;
}
