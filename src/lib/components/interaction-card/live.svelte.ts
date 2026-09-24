import { invalidate } from '$app/navigation';
import { resolve } from '$app/paths';
import {
	EDITING_REFRESH_MS,
	interactionCardDependency,
	TYPING_IDLE_MS,
	TYPING_REFRESH_MS,
	TYPING_TTL_MS,
	type LiveActivityKind,
	type LivePerson
} from '$lib/contracts/live';

/**
 * Сколько ждать, прежде чем перечитать карточку по событию. Переход по стадии
 * пишет комментарий, смену стадии и отметку документа подряд; перечитывать
 * карточку трижды за секунду незачем.
 */
const COALESCE_MS = 1_000;

/**
 * Паузы между попытками переподключиться после того, как браузер сам
 * сдался (ответ не 200: выкат, перезапуск, лимит). Растут и кончаются:
 * каждая попытка — запрос с сессией, и бесконечные попытки держали бы вход
 * открытым за человека, которого нет.
 */
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 180_000];

/**
 * Живая карточка на стороне браузера: один поток `EventSource` на вкладку.
 *
 * События не несут данных — только «что-то изменилось». Карточка
 * перечитывает себя своим обычным загрузчиком, с правами того, кто смотрит.
 * Если открыт диалог, перечитывание ждёт: вместо него поднимается полоса
 * «Карточка изменилась», и человек обновляет, когда закончит, — начатый
 * черновик не сносится чужой правкой.
 */
export class LiveCard {
	/** Состав: у кого доступ к делу и кто сейчас в карточке. */
	people = $state<LivePerson[]>([]);
	/** Поток открыт и события приходят. */
	connected = $state(false);
	/** Карточка устарела, а перечитать сразу было нельзя (открыт диалог). */
	stale = $state(false);
	/** Кто набирает комментарий — идентификаторы; себя здесь нет. */
	#typing = $state<string[]>([]);

	/**
	 * Имена тех, кто набирает комментарий, — из состава: событие несёт только
	 * идентификаторы. Кого в составе нет, того и не называем.
	 */
	readonly typers = $derived(
		this.#typing.flatMap((userId) => {
			const person = this.people.find((candidate) => candidate.userId === userId);

			return person === undefined ? [] : [person.name];
		})
	);

	#source: EventSource | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#typingTimer: ReturnType<typeof setTimeout> | undefined;
	#attempt = 0;
	#stopped = false;

	readonly #url: string;
	readonly #interactionId: string;
	/** Открыт ли сейчас диалог карточки. */
	readonly #busy: () => boolean;

	constructor(url: string, interactionId: string, busy: () => boolean) {
		this.#url = url;
		this.#interactionId = interactionId;
		this.#busy = busy;
	}

	start(): void {
		this.#stopped = false;
		this.#open();
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
		clearTimeout(this.#retry);
		clearTimeout(this.#typingTimer);
		this.#source?.close();
		this.#source = null;
		this.connected = false;
		this.#typing = [];
	}

	/** Перечитать карточку сейчас — по кнопке полосы «изменилась». */
	async refresh(): Promise<void> {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.stale = false;
		await invalidate(interactionCardDependency(this.#interactionId));
	}

	#open(): void {
		const source = new EventSource(this.#url);
		let resumed = false;

		this.#source = source;

		source.addEventListener('hello', () => {
			this.connected = true;

			// Переподключение: пока потока не было, события могли пройти мимо.
			if (this.#attempt > 0 || resumed) {
				this.#changed();
			}
			this.#attempt = 0;
			resumed = true;
		});
		source.addEventListener('roster', (message) => {
			this.people = (JSON.parse(message.data) as { people: LivePerson[] }).people;
		});

		source.addEventListener('typing', (message) => {
			this.#typing = (JSON.parse(message.data) as { userIds: string[] }).userIds;

			// Подтверждения перестали приходить — набирающий ушёл, не
			// попрощавшись (закрыл ноутбук, пропала связь): гасим сами.
			clearTimeout(this.#typingTimer);
			this.#typingTimer = setTimeout(() => (this.#typing = []), TYPING_TTL_MS);
		});

		for (const name of ['comment.added', 'interaction.changed', 'resync']) {
			source.addEventListener(name, () => this.#changed());
		}

		source.addEventListener('bye', () => {
			// Сессии или доступа больше нет. Перечитывание само покажет, что
			// дальше: страницу входа или «не найдено».
			this.stop();
			void invalidate(interactionCardDependency(this.#interactionId));
		});
		source.addEventListener('error', () => {
			this.connected = false;

			// `CONNECTING` — браузер переподключается сам. `CLOSED` — сдался:
			// дальше попытки по расписанию.
			if (source.readyState === EventSource.CLOSED && !this.#stopped) {
				this.#scheduleRetry();
			}
		});
	}

	#scheduleRetry(): void {
		this.#source?.close();
		this.#source = null;

		const delay = RETRY_DELAYS_MS[this.#attempt];

		if (delay === undefined) {
			return;
		}

		this.#attempt += 1;
		this.#retry = setTimeout(() => {
			if (!this.#stopped) {
				this.#open();
			}
		}, delay);
	}

	#changed(): void {
		if (this.#busy()) {
			this.stale = true;
			return;
		}

		this.#timer ??= setTimeout(() => {
			this.#timer = undefined;

			if (this.#busy()) {
				this.stale = true;
				return;
			}

			void invalidate(interactionCardDependency(this.#interactionId));
		}, COALESCE_MS);
	}
}

/**
 * Адрес потока и сигналов карточки — из параметров её страницы: поле
 * комментария и диалоги правки знают дело по адресу, а не по пропсам.
 */
export function cardLiveUrl(params: Partial<Record<string, string>>): string {
	const { workspace, id } = params;

	if (workspace === undefined || id === undefined) {
		throw new Error('Живая карточка есть только на странице взаимодействия');
	}

	return resolve('/(app)/w/[workspace]/interactions/[id=uuid]/live', { workspace, id });
}

/**
 * Сигнал занятости со стороны того, кто работает: «набираю комментарий» или
 * «открыл форму правки». Один объект на поле или форму; `stop` обязателен
 * при отправке, закрытии и уходе со страницы — иначе коллеги увидят
 * занятость до конца её срока.
 *
 * Сигнал — обычный запрос с сессией на адрес потока карточки; сервер сам
 * проверяет доступ к делу и подставляет имя из справочника.
 */
export class LiveActivity {
	#active = false;
	#sentAt = 0;
	#idle: ReturnType<typeof setTimeout> | undefined;
	#heartbeat: ReturnType<typeof setInterval> | undefined;

	readonly #url: string;
	readonly #kind: LiveActivityKind;

	constructor(url: string, kind: LiveActivityKind) {
		this.#url = url;
		this.#kind = kind;
	}

	/**
	 * Человек набрал символ. Сигнал — не чаще раза в {@link TYPING_REFRESH_MS};
	 * тишина {@link TYPING_IDLE_MS} гасит его сразу, не дожидаясь срока.
	 */
	typed(): void {
		clearTimeout(this.#idle);
		this.#idle = setTimeout(() => this.stop(), TYPING_IDLE_MS);

		if (!this.#active || Date.now() - this.#sentAt >= TYPING_REFRESH_MS) {
			this.#send(true);
		}
	}

	/** Форма открыта: сигнал сейчас и подтверждение, пока её не закроют. */
	hold(): void {
		if (this.#heartbeat !== undefined) {
			return;
		}

		this.#send(true);
		this.#heartbeat = setInterval(() => this.#send(true), EDITING_REFRESH_MS);
	}

	/** Закончил: отправил, закрыл, ушёл. Без начатого — ничего не шлёт. */
	stop(): void {
		clearTimeout(this.#idle);
		clearInterval(this.#heartbeat);
		this.#idle = undefined;
		this.#heartbeat = undefined;

		if (this.#active) {
			this.#send(false);
		}
	}

	#send(active: boolean): void {
		this.#active = active;
		this.#sentAt = Date.now();

		// `keepalive` — сигнал «закончил» при уходе со страницы должен дойти,
		// даже если вкладку уже закрывают.
		void fetch(this.#url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind: this.#kind, active }),
			keepalive: true
		}).then(
			(response) => {
				if (!response.ok) {
					console.error(`[live] сигнал «${this.#kind}» отклонён: ${response.status}`);
				}
			},
			(failure: unknown) => console.error(`[live] сигнал «${this.#kind}» не отправлен`, failure)
		);
	}
}
