/**
 * Сценарий «десять одновременных отчётов» (требование N7).
 *
 * Десять человек одновременно просят отчёт за большой период — учебный год
 * целиком — и забирают его файлом. Форматов два, и они упираются в разное:
 * XLSX собирается в самом приложении, PDF уезжает в Gotenberg и возвращается
 * оттуда, поэтому смешивать их в одном числе бессмысленно. Рядом меряется JSON
 * — та же выборка без сборки файла: по разнице видно, сколько стоит формат, а
 * сколько сам отчёт.
 *
 * У PDF свой период, и это не упрощение замера, а свойство продукта: выгрузка
 * в PDF отказывается собирать больше двух тысяч строк и говорит об этом
 * словами. Годовой срез портфеля из трёх тысяч взаимодействий в этот потолок не
 * помещается вовсе, поэтому PDF меряется на самом большом периоде, который он
 * принимает, — квартальном движении. Сам отказ измерять незачем: он мгновенный
 * и к нагрузке отношения не имеет.
 *
 * Паузы между запросами нет намеренно: десять одновременных выгрузок — это не
 * поведение человека, а худший случай, ради которого требование и написано.
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { ACCOUNTS, jar, signIn } from './session.js';
import { kinds, record } from './metrics.js';

const BASE_URL = __ENV.BASE_URL;
const PASSWORD = __ENV.PASSWORD;
const VUS = Number(__ENV.REPORT_VUS || 10);
const DURATION = __ENV.REPORT_DURATION || '2m';

/** Учебный год целиком: большой период, ради которого требование и написано. */
const PERIOD = 'from=2026-09-01&to=2027-08-31';

/** Квартал: столько движения помещается в потолок строк выгрузки PDF. */
const PDF_PERIOD = 'from=2027-01-01&to=2027-03-31';

export const options = {
	scenarios: {
		reports: {
			executor: 'constant-vus',
			vus: VUS,
			duration: DURATION,
			gracefulStop: '60s'
		}
	},
	// Порога в секунду здесь нет: ТЗ обещает секунду отклику интерфейса, а
	// выгрузка за год — это файл, который собирают и ждут. Что именно вышло,
	// написано числами в `docs/performance.md`.
	thresholds: {
		ssr_failed: ['rate<0.01'],
		api_failed: ['rate<0.01']
	},
	summaryTrendStats: ['med', 'p(95)', 'max', 'avg', 'count']
};

let signedIn = false;

const HTML = { Accept: 'text/html,application/xhtml+xml' };

export default function () {
	if (!signedIn) {
		// VU расходятся по времени: каталог считает подбором два входа одной
		// записью внутри секунды и запирает её на минуту. Полсекунды на VU — это
		// полторы секунды между входами одной и той же записи.
		sleep((__VU - 1) * 0.5);
		signIn(BASE_URL, ACCOUNTS[(__VU - 1) % ACCOUNTS.length], PASSWORD);
		signedIn = true;
	}

	const mode = __VU % 2 === 0 ? 'movement' : 'slice';

	const screen = http.get(`${BASE_URL}/reports?mode=${mode}&${PERIOD}`, {
		jar,
		headers: HTML,
		tags: { step: 'report-screen' }
	});
	record('reportFilter', 'ssr', screen);

	const xlsx = http.get(`${BASE_URL}/reports/export?format=xlsx&mode=${mode}&${PERIOD}`, {
		jar,
		headers: HTML,
		tags: { step: 'report-xlsx' }
	});
	record('reportXlsx', 'ssr', xlsx);

	const pdf = http.get(`${BASE_URL}/reports/export?format=pdf&mode=movement&${PDF_PERIOD}`, {
		jar,
		headers: HTML,
		tags: { step: 'report-pdf' }
	});
	record('reportPdf', 'ssr', pdf);

	// Тот же отчёт без сборки файла: разница с XLSX и PDF — это цена формата.
	const asJson = http.get(`${BASE_URL}/reports/export?format=json&mode=${mode}&${PERIOD}`, {
		jar,
		headers: { Accept: 'application/json' },
		tags: { step: 'report-json' }
	});
	kinds.api.duration.add(asJson.timings.duration);
	kinds.api.failed.add(asJson.status !== 200);
}
