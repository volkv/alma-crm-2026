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
 * После карточек тем же способом меряется экран отчёта за учебный год: списки
 * фильтров и действующая редакция процесса тоже лежат в Redis, и повторное
 * открытие раздела их не перечитывает. Здесь холод приходится ждать — у этих
 * записей поколение не зависит от данных отчёта, и обесценивает их только
 * запись в справочник, публикация редакции или срок жизни. Поэтому перед
 * холодным открытием сценарий молчит дольше самого долгого срока (`process.ts`,
 * 60 секунд), а пар берётся немного: `REPORT_PAIRS`.
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
const REPORT_PAIRS = Number(__ENV.REPORT_PAIRS || 3);

/** Период отчёта — учебный год: самая дорогая выборка системы. */
const PERIOD = 'from=2026-09-01&to=2027-08-31';

/**
 * Сколько молчать перед холодным открытием отчёта. Больше самого долгого срока
 * жизни записи кэша (редакция процесса — 60 секунд), иначе «холодное» открытие
 * читало бы то, что положило предыдущее.
 */
const REPORT_COLD_SECONDS = 65;

const fixture = JSON.parse(open(__ENV.FIXTURE));

const series = {
	usual: {
		cold: { total: new Trend('usual_cold_total', true), db: new Trend('usual_cold_db', true) },
		warm: { total: new Trend('usual_warm_total', true), db: new Trend('usual_warm_db', true) }
	},
	long: {
		cold: { total: new Trend('long_cold_total', true), db: new Trend('long_cold_db', true) },
		warm: { total: new Trend('long_warm_total', true), db: new Trend('long_warm_db', true) }
	},
	report: {
		cold: { total: new Trend('report_cold_total', true), db: new Trend('report_cold_db', true) },
		warm: { total: new Trend('report_warm_total', true), db: new Trend('report_warm_db', true) }
	}
};

export const options = {
	scenarios: {
		cache: {
			executor: 'shared-iterations',
			vus: 1,
			iterations: PAIRS + REPORT_PAIRS,
			maxDuration: '20m'
		}
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

function openReport() {
	return http.get(`${BASE_URL}/reports?mode=slice&${PERIOD}`, { jar, headers: HTML });
}

/** Пара «холодное открытие — повторное» по одному ответу каждая. */
function pair(kind, first, second) {
	series[kind].cold.total.add(first.timings.duration);
	series[kind].cold.db.add(timing(first, 'db'));
	series[kind].warm.total.add(second.timings.duration);
	series[kind].warm.db.add(timing(second, 'db'));
}

export default function () {
	if (!signedIn) {
		signIn(BASE_URL, ACCOUNTS[0], PASSWORD);
		signedIn = true;
	}

	// Пары карточек идут первыми, отчёт — после них: он ждёт истечения срока
	// жизни записей кэша и тем задаёт темп всему прогону.
	if (__ITER >= PAIRS) {
		sleep(REPORT_COLD_SECONDS);

		const cold = openReport();
		sleep(0.2);
		pair('report', cold, openReport());

		return;
	}

	for (const kind of ['usual', 'long']) {
		const pool = kind === 'long' ? fixture.longest : fixture.cards;
		const id = pool[(__ITER * 37) % pool.length];

		const first = openCard(id);

		// Пауза не ради кэша — он уже записан, — а чтобы два открытия не слились
		// в одно соединение и не мерили заодно разогрев сокета.
		sleep(0.2);

		pair(kind, first, openCard(id));
	}
}
