/**
 * Замер кэша повторного открытия (требование F13).
 *
 * Одна карточка открывается дважды подряд: первый раз — вхолодную, второй —
 * когда лента комментариев и история правок уже собраны и лежат в Redis. Оба
 * ответа несут `Server-Timing`, поэтому видно не только общее время, но и
 * сколько из него запрос ждал базу, — а именно это ожидание кэш и убирает.
 *
 * Карточки берутся двух родов, и в этом весь смысл замера: обычная — четыре
 * комментария и три правки плана, долгая — сорок и тридцать. Кэш пишется ради
 * второй, и по разнице между двумя рядами чисел видно, ради чего он.
 *
 * Поколение кэша карточки — момент последнего события по ней, поэтому первое
 * открытие каждой следующей карточки снова холодное, и пар получается столько,
 * сколько задано `PAIRS`. Ничего сбрасывать между парами не нужно.
 *
 * Один VU: замер про стоимость одного открытия, а не про поведение под
 * нагрузкой. Нагрузку меряют `browse.js` и `reports.js`.
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { ACCOUNTS, jar, signIn } from './session.js';

const BASE_URL = __ENV.BASE_URL;
const PASSWORD = __ENV.PASSWORD;
const PAIRS = Number(__ENV.PAIRS || 40);

const fixture = JSON.parse(open(__ENV.FIXTURE));

const series = {
	usual: {
		cold: { total: new Trend('usual_cold_total', true), db: new Trend('usual_cold_db', true) },
		warm: { total: new Trend('usual_warm_total', true), db: new Trend('usual_warm_db', true) }
	},
	long: {
		cold: { total: new Trend('long_cold_total', true), db: new Trend('long_cold_db', true) },
		warm: { total: new Trend('long_warm_total', true), db: new Trend('long_warm_db', true) }
	}
};

export const options = {
	scenarios: {
		cache: { executor: 'shared-iterations', vus: 1, iterations: PAIRS, maxDuration: '10m' }
	},
	summaryTrendStats: ['med', 'p(95)', 'max', 'avg', 'count']
};

let signedIn = false;

const HTML = { Accept: 'text/html,application/xhtml+xml' };

/** Значение показателя из `Server-Timing`, в миллисекундах. */
function timing(response, name) {
	const header = response.headers['Server-Timing'] || '';
	const match = new RegExp(`${name};dur=([0-9.]+)`).exec(header);

	return match === null ? 0 : Number(match[1]);
}

function openCard(id) {
	return http.get(`${BASE_URL}/interactions/${id}`, { jar, headers: HTML });
}

export default function () {
	if (!signedIn) {
		signIn(BASE_URL, ACCOUNTS[0], PASSWORD);
		signedIn = true;
	}

	for (const kind of ['usual', 'long']) {
		const pool = kind === 'long' ? fixture.longest : fixture.cards;
		const id = pool[(__ITER * 37) % pool.length];

		const first = openCard(id);
		series[kind].cold.total.add(first.timings.duration);
		series[kind].cold.db.add(timing(first, 'db'));

		// Пауза не ради кэша — он уже записан, — а чтобы два открытия не слились
		// в одно соединение и не мерили заодно разогрев сокета.
		sleep(0.2);

		const second = openCard(id);
		series[kind].warm.total.add(second.timings.duration);
		series[kind].warm.db.add(timing(second, 'db'));
	}
}
