import { invalidate } from '$app/navigation';
import { interactionCardDependency, type LivePerson } from '$lib/contracts/live';

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

	#source: EventSource | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#retry: ReturnType<typeof setTimeout> | undefined;
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
		this.#source?.close();
		this.#source = null;
		this.connected = false;
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
