/**
 * Шина живых событий: Redis pub/sub между процессами и раздача внутри процесса.
 *
 * Канал один на всё приложение. Каждый процесс держит одно соединение-
 * подписчик (`createRedisSubscriber`) и раздаёт пришедшее тем открытым
 * карточкам, которые смотрят на это дело. Каналы по делу сэкономили бы трафик
 * при тысячах открытых карточек, но потребовали бы подписываться и
 * отписываться на каждое открытие; на масштабе отдела это лишняя подвижная
 * часть.
 *
 * Pub/sub не хранит истории: пока подписчик переподключается, события
 * теряются. Поэтому после восстановления связи каждый слушатель получает
 * `resync` — карточка перечитывает себя, а не ждёт пропущенного.
 */
import type { Redis } from 'ioredis';
import { liveEventSchema, type LiveEvent } from '$lib/contracts/live';
import { createRedisSubscriber, getRedis } from '../redis';

const CHANNEL = 'live:events';

/**
 * Что получает слушатель: событие шины или весть о возможном пропуске.
 */
export type LiveSignal = LiveEvent | { type: 'resync' };

export type LiveListener = (signal: LiveSignal) => void;

/**
 * Конверт в канале. `interactionId: null` — событие для всех открытых
 * карточек: так обезличивание, которое переписывает заголовки многих дел
 * разом, просит перечитаться всех, не перечисляя их.
 */
type Envelope = { interactionId: string | null; event: LiveEvent };

const listeners = new Map<string, Set<LiveListener>>();

let subscriber: Redis | undefined;
let subscribed: Promise<void> | undefined;

function deliver(interactionId: string, signal: LiveSignal): void {
	for (const listener of listeners.get(interactionId) ?? []) {
		listener(signal);
	}
}

function receive(raw: string): void {
	const parsed = parseEnvelope(raw);

	if (parsed === null) {
		console.error('[live] в канале событий непонятное сообщение, пропущено', raw.slice(0, 200));
		return;
	}

	if (parsed.interactionId === null) {
		for (const interactionId of listeners.keys()) {
			deliver(interactionId, parsed.event);
		}
	} else {
		deliver(parsed.interactionId, parsed.event);
	}
}

function parseEnvelope(raw: string): Envelope | null {
	let value: unknown;

	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}

	if (typeof value !== 'object' || value === null) {
		return null;
	}

	const { interactionId, event } = value as Record<string, unknown>;
	const parsedEvent = liveEventSchema.safeParse(event);

	if (!parsedEvent.success || (interactionId !== null && typeof interactionId !== 'string')) {
		return null;
	}

	return { interactionId, event: parsedEvent.data };
}

/**
 * Подписка процесса на канал: заводится с первым слушателем и живёт, пока жив
 * процесс. Повторное `ready` — это переподключение: ioredis сам возобновил
 * подписку, но всё, что было отправлено в разрыв, пропало.
 */
function ensureSubscribed(): Promise<void> {
	if (subscribed !== undefined) {
		return subscribed;
	}

	const connection = createRedisSubscriber();
	let readyBefore = false;

	connection.on('message', (_channel: string, raw: string) => receive(raw));
	connection.on('ready', () => {
		if (readyBefore) {
			for (const interactionId of listeners.keys()) {
				deliver(interactionId, { type: 'resync' });
			}
		}
		readyBefore = true;
	});
	connection.on('error', (failure: unknown) => {
		// Переподключается ioredis сам; строка в логе — чтобы разрыв был виден.
		console.error('[live] соединение-подписчик Redis:', failure);
	});

	subscriber = connection;
	subscribed = connection
		.connect()
		.then(() => connection.subscribe(CHANNEL))
		.then(() => undefined)
		.catch((failure: unknown) => {
			// Не удалось с первого раза — следующий слушатель попробует заново,
			// а этот получит отказ и закроет свой поток.
			subscriber = undefined;
			subscribed = undefined;
			connection.disconnect();
			throw failure;
		});

	return subscribed;
}

/**
 * Слушать события одного дела. Возвращает отписку; её обязан позвать тот,
 * кто подписался, иначе слушатель закрытого потока будет жить вечно.
 */
export async function listenInteraction(
	interactionId: string,
	listener: LiveListener
): Promise<() => void> {
	await ensureSubscribed();

	let set = listeners.get(interactionId);

	if (set === undefined) {
		set = new Set();
		listeners.set(interactionId, set);
	}

	set.add(listener);

	return () => {
		const current = listeners.get(interactionId);

		current?.delete(listener);

		if (current?.size === 0) {
			listeners.delete(interactionId);
		}
	};
}

/**
 * Сообщить открытым карточкам дела. Зовётся только после фиксации записи —
 * см. `publishAfterCommit` в `./publish.ts`.
 */
export async function publishLive(interactionId: string | null, event: LiveEvent): Promise<void> {
	const envelope: Envelope = { interactionId, event };

	await getRedis().publish(CHANNEL, JSON.stringify(envelope));
}

/** Закрывает подписку процесса. Нужна прогону тестов и скриптам, не приложению. */
export async function closeLiveBus(): Promise<void> {
	const connection = subscriber;

	subscriber = undefined;
	subscribed = undefined;
	listeners.clear();

	if (connection !== undefined) {
		await connection.quit();
	}
}
