/**
 * Поток живой карточки: SSE одной открытой карточки взаимодействия.
 *
 * Что поток обещает:
 *
 * - **доступ проверяется заново**, а не один раз при подключении: перед каждой
 *   выдачей и раз в {@link RECHECK_MS} пользователь собирается из сессии так
 *   же, как на обычном запросе, и спрашивается условие видимости дела. Отозвали
 *   сессию, исключили из пространства, забрали вуз — поток говорит `bye` и
 *   закрывается, не выдав больше ни события, ни имени присутствующего;
 * - **сессию не продлевает**: проверка идёт через `peekSession`. Забытая
 *   вкладка — не работа человека, и вход по бездействию гаснет в свой срок;
 * - **транзакций не держит**: каждая проверка — отдельные короткие запросы;
 * - **данных дела не несёт**: только вид события и идентификатор, состав
 *   людей — имена сотрудников из справочника пользователей;
 * - **освобождает всё** при закрытии, с чьей бы стороны оно ни пришло:
 *   таймеры, подписку на шину, запись присутствия и место в лимитах.
 */
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { LiveMessage, LivePerson } from '$lib/contracts/live';
import { loadSessionUser, peekSession } from '../auth/session';
import { getDb } from '../db';
import { users } from '../db/schema';
import { listenInteraction, publishLive, type LiveSignal } from './bus';
import { markGone, markPresent, PRESENCE_REFRESH_MS, readPresence } from './presence';
import { forgetInteractionViewers, listInteractionViewers, userSeesInteraction } from './viewers';

/** Как часто поток перепроверяет доступ и состав без внешнего повода. */
const RECHECK_MS = 30_000;

/**
 * Сколько ждать, собирая события в пачку. Переход по стадии пишет несколько
 * событий подряд; проверять доступ и будить карточку на каждое незачем.
 */
const BATCH_MS = 150;

/** Потоков на сессию: вкладки одного браузера, с запасом на пару окон. */
export const STREAMS_PER_SESSION = 6;

/**
 * Потоков на процесс. Каждый — открытое соединение с Node и перепроверка раз
 * в полминуты; потолок держит от исчерпания дескрипторов и пула базы, если
 * кто-то откроет карточку в сотне вкладок.
 */
export const STREAMS_PER_PROCESS = 500;

const perSession = new Map<string, number>();
let total = 0;

export type StreamRequest = {
	sessionId: string;
	interactionId: string;
	workspaceKey: string;
	/** Разрыв со стороны клиента: закрыть поток и убрать за собой. */
	signal: AbortSignal;
};

export type StreamRefusal = { status: 404 | 429; message: string };

type Verdict = { ok: true; userId: string } | { ok: false; reason: 'session' | 'access' };

/**
 * Можно ли этой сессии смотреть это дело прямо сейчас. Сессия — без
 * продления, пользователь — заново из базы, доступ — тем же условием, что у
 * карточки, вместе с пространством из адреса.
 */
async function authorize(request: StreamRequest): Promise<Verdict> {
	const session = await peekSession(request.sessionId);

	if (session === null) {
		return { ok: false, reason: 'session' };
	}

	const user = await loadSessionUser(session.userId);

	if (user === null) {
		return { ok: false, reason: 'session' };
	}

	const visible = await userSeesInteraction(user, request.interactionId, request.workspaceKey);

	return visible ? { ok: true, userId: user.id } : { ok: false, reason: 'access' };
}

function encode(message: LiveMessage): string {
	return `event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
}

/** Состав карточки глазами одной вкладки: «вы» — по вкладке, не по учётной записи. */
async function buildRoster(interactionId: string, tabId: string): Promise<LivePerson[]> {
	const [viewers, tabs] = await Promise.all([
		listInteractionViewers(interactionId),
		readPresence(interactionId)
	]);

	const online = new Map<string, { count: number; you: boolean }>();

	for (const tab of tabs) {
		const entry = online.get(tab.userId) ?? { count: 0, you: false };

		entry.count += 1;
		entry.you ||= tab.tabId === tabId;
		online.set(tab.userId, entry);
	}

	const people: LivePerson[] = viewers.map((viewer) => ({
		userId: viewer.userId,
		name: viewer.fullName,
		relation: viewer.relation,
		online: online.get(viewer.userId)?.count ?? 0,
		you: online.get(viewer.userId)?.you ?? false
	}));

	// В карточке, но не в списке доступа: список помнится полминуты, а
	// человека могли включить в пространство только что. Каждая вкладка
	// проверила свой доступ сама, иначе её бы здесь не было.
	const listed = new Set(viewers.map((viewer) => viewer.userId));
	const unlisted = [...online.keys()].filter((userId) => !listed.has(userId));

	if (unlisted.length > 0) {
		const names = await getDb()
			.select({ id: users.id, fullName: users.fullName })
			.from(users)
			.where(inArray(users.id, unlisted));

		for (const row of names) {
			const entry = online.get(row.id);

			people.push({
				userId: row.id,
				name: row.fullName,
				relation: null,
				online: entry?.count ?? 0,
				you: entry?.you ?? false
			});
		}
	}

	return people;
}

/**
 * Открыть поток. Отказ — ответ без потока: 404, если дела не видно (как у
 * страницы: существование чужого дела не подтверждается), 429 — если исчерпан
 * лимит потоков.
 */
export async function openInteractionStream(
	request: StreamRequest
): Promise<Response | StreamRefusal> {
	const first = await authorize(request);

	if (!first.ok) {
		return { status: 404, message: 'Взаимодействие не найдено' };
	}

	const opened = perSession.get(request.sessionId) ?? 0;

	if (opened >= STREAMS_PER_SESSION || total >= STREAMS_PER_PROCESS) {
		return { status: 429, message: 'Слишком много открытых карточек' };
	}

	perSession.set(request.sessionId, opened + 1);
	total += 1;

	const tabId = randomUUID();
	const encoder = new TextEncoder();
	const pending: LiveSignal[] = [];
	const timers: ReturnType<typeof setTimeout>[] = [];

	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	let batchTimer: ReturnType<typeof setTimeout> | undefined;
	let unlisten: (() => void) | undefined;
	let lastRoster = '';
	// Проверки и выдачи идут строго друг за другом: таймер перепроверки и пачка
	// событий не должны писать в поток вперемешку.
	let chain: Promise<void> = Promise.resolve();

	const write = (text: string): void => {
		if (!closed) {
			controller.enqueue(encoder.encode(text));
		}
	};

	const release = (): void => {
		if (closed) {
			return;
		}

		closed = true;
		clearTimeout(batchTimer);
		timers.forEach((timer) => clearInterval(timer));
		unlisten?.();
		request.signal.removeEventListener('abort', release);

		const left = (perSession.get(request.sessionId) ?? 1) - 1;

		if (left <= 0) {
			perSession.delete(request.sessionId);
		} else {
			perSession.set(request.sessionId, left);
		}
		total -= 1;

		void markGone(request.interactionId, tabId)
			// Остальным зрителям — что вкладка ушла.
			.then(() => publishLive(request.interactionId, { type: 'presence' }))
			.catch((failure: unknown) =>
				console.error('[live] не удалось убрать присутствие закрытой вкладки', failure)
			);
	};

	const shut = (reason: 'session' | 'access'): void => {
		write(encode({ event: 'bye', data: { reason } }));

		if (!closed) {
			controller.close();
		}

		release();
	};

	const sendRoster = async (force: boolean): Promise<void> => {
		const people = await buildRoster(request.interactionId, tabId);
		const serialized = JSON.stringify(people);

		if (force || serialized !== lastRoster) {
			lastRoster = serialized;
			write(encode({ event: 'roster', data: { people } }));
		}
	};

	/** Поставить работу в очередь потока; сбой закрывает поток с записью в лог. */
	const run = (work: () => Promise<void>): void => {
		chain = chain
			.then(async () => {
				if (!closed) {
					await work();
				}
			})
			.catch((failure: unknown) => {
				console.error('[live] поток карточки закрыт из-за сбоя', failure);

				if (!closed) {
					controller.error(failure);
				}

				release();
			});
	};

	/** Проверить доступ; нет его — попрощаться. `true` — можно продолжать. */
	const stillAllowed = async (): Promise<boolean> => {
		const verdict = await authorize(request);

		if (!verdict.ok) {
			shut(verdict.reason);
			return false;
		}

		return true;
	};

	const flush = (): void => {
		batchTimer = undefined;

		run(async () => {
			const batch = pending.splice(0);

			if (batch.length === 0 || !(await stillAllowed())) {
				return;
			}

			let rosterDue = false;

			for (const signal of batch) {
				if (signal.type === 'presence') {
					rosterDue = true;
				} else if (signal.type === 'comment.added') {
					write(encode({ event: 'comment.added', data: { commentId: signal.commentId } }));
				} else if (signal.type === 'interaction.changed') {
					forgetInteractionViewers(request.interactionId);
					rosterDue = true;
					write(encode({ event: 'interaction.changed', data: {} }));
				} else {
					rosterDue = true;
					write(encode({ event: 'resync', data: {} }));
				}
			}

			if (rosterDue) {
				await sendRoster(false);
			}
		});
	};

	const stream = new ReadableStream<Uint8Array>({
		start(streamController) {
			controller = streamController;
		},
		cancel() {
			release();
		}
	});

	request.signal.addEventListener('abort', release);

	run(async () => {
		unlisten = await listenInteraction(request.interactionId, (signal) => {
			pending.push(signal);
			batchTimer ??= setTimeout(flush, BATCH_MS);
		});

		// Поток мог закрыться, пока шла подписка: тогда отписка уже не позвана.
		if (closed) {
			unlisten();
			return;
		}

		await markPresent(request.interactionId, tabId, first.userId);
		write(encode({ event: 'hello', data: {} }));
		await sendRoster(true);

		await publishLive(request.interactionId, { type: 'presence' });

		timers.push(
			// Пинг — комментарий SSE: браузер его не показывает, а прокси видит
			// трафик и не рвёт молчащее соединение по своему тайм-ауту (у nginx
			// стенда — 120 с). Им же продлевается запись присутствия.
			setInterval(
				() =>
					run(async () => {
						write(': ping\n\n');
						await markPresent(request.interactionId, tabId, first.userId);
					}),
				PRESENCE_REFRESH_MS
			),
			setInterval(
				() =>
					run(async () => {
						if (await stillAllowed()) {
							// Вкладка другого процесса могла пропасть по сроку без
							// прощания — состав перечитывается и без события.
							await sendRoster(false);
						}
					}),
				RECHECK_MS
			)
		);
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			// adapter-node ставит этот заголовок сам только при `Content-Type`,
			// равном `text/event-stream` без параметров; nginx без него копит
			// события в буфере и отдаёт их пачкой с опозданием.
			'X-Accel-Buffering': 'no',
			'Cache-Control': 'no-store'
		}
	});
}
