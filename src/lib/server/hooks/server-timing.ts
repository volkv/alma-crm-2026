/**
 * Сколько заняло обслуживание запроса — в заголовке `Server-Timing`.
 *
 * Без замера разговор об отклике интерфейса держится на ощущениях, а
 * профилировщик отвечает за одну машину и один прогон. Здесь же каждый ответ
 * несёт три числа: сколько запрос ждал базу (`db`), сколько осталось
 * приложению (`app`) и сколько вышло всего (`total`). Их читает и браузер
 * (вкладка «Сеть»), и нагрузочный сценарий (`scripts/load/`), и человек через
 * `curl -I`.
 *
 * Три числа и ни одного больше. Ни текстов запросов, ни их количества, ни
 * того, какой сервис сколько занял: заголовок уходит наружу, а перечень
 * внутренних шагов — это карта приложения, составленная для того, кому она не
 * предназначена.
 *
 * `db` — это **время ожидания базы**, а не сумма длительностей запросов.
 * Загрузчик страницы запускает свои чтения одной `Promise.all`, и сложенные
 * длительности легко перевалили бы за время всего запроса, после чего `app`
 * оказался бы нулём. Поэтому считается время, в течение которого у запроса был
 * хотя бы один незавершённый запрос к базе: такое `db` не больше `total`, и
 * разность между ними — действительно работа приложения.
 *
 * Счётчик живёт в области видимости запроса (`AsyncLocalStorage`), а не в
 * соединении с базой: соединение общее на процесс, и складывать время в него
 * значило бы смешивать одновременные запросы. Заполняет счётчик обёртка вокруг
 * клиента postgres (`$lib/server/db`), поэтому ни один читатель базы о замере
 * не знает и знать не должен.
 *
 * Чего в заголовке нет. Перенаправление, брошенное хуком (`guard`,
 * `rateLimit`), собирает SvelteKit вне цепочки — на таком ответе нет ни
 * `Server-Timing`, ни идентификатора запроса (см. `request-id.ts`). Потоковая
 * часть ответа, если загрузчик вернул незавершённое обещание, считается уже
 * после того, как заголовки ушли, и в `total` не попадает.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Handle } from '@sveltejs/kit';

/** Ожидание базы, накопленное за один запрос к приложению. */
type RequestTiming = {
	/** Сколько запросов к базе сейчас в полёте у этого запроса. */
	inFlight: number;
	/** Момент, когда началось текущее непрерывное ожидание базы. */
	waitingSince: number;
	milliseconds: number;
};

const storage = new AsyncLocalStorage<RequestTiming>();

/**
 * Отметить начало запроса к базе; возвращает «запрос завершился». Зовёт её
 * обёртка вокруг клиента postgres и только она.
 *
 * Вне обслуживания запроса к приложению — в сиде, в фоновом цикле интеграций,
 * в тесте сервиса — области нет, и вызов возвращает `null`: мерить некому, и
 * ни одного объекта на это не заводится.
 */
export function trackDatabaseQuery(): (() => void) | null {
	const timing = storage.getStore();

	if (timing === undefined) {
		return null;
	}

	if (timing.inFlight === 0) {
		timing.waitingSince = performance.now();
	}

	timing.inFlight += 1;

	let counted = false;

	return () => {
		// Обещание базы завершается один раз, но защита дешевле разбирательства
		// с отрицательным счётчиком, если однажды станет иначе.
		if (counted) {
			return;
		}

		counted = true;
		timing.inFlight -= 1;

		if (timing.inFlight === 0) {
			timing.milliseconds += performance.now() - timing.waitingSince;
		}
	};
}

/** Миллисекунды в том виде, в каком их принимает `Server-Timing`. */
function duration(milliseconds: number): string {
	// Отрицательного здесь быть не может, но округление вверх до нуля дешевле
	// объяснения, откуда в заголовке взялось «-0.0».
	return Math.max(0, milliseconds).toFixed(1);
}

export const serverTiming: Handle = ({ event, resolve }) => {
	const timing: RequestTiming = { inFlight: 0, waitingSince: 0, milliseconds: 0 };

	return storage.run(timing, async (): Promise<Response> => {
		const startedAt = performance.now();
		const response = await resolve(event);
		const total = performance.now() - startedAt;

		response.headers.set(
			'Server-Timing',
			`db;dur=${duration(timing.milliseconds)}, app;dur=${duration(total - timing.milliseconds)}, total;dur=${duration(total)}`
		);

		return response;
	});
};
