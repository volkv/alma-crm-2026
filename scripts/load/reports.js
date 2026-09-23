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
 * Период у всех трёх форматов один — тот самый большой, который назван в
 * требовании. Раньше у PDF был свой, поменьше: выгрузка отказывалась собирать
 * больше двух тысяч строк, а в годовом срезе портфеля их три тысячи. Теперь PDF
 * собирается всегда и всегда сводкой — условия, итоги, воронка, динамика и
 * первые 500 строк с пометкой, сколько их всего, — поэтому мерить его на
 * укороченном периоде больше незачем.
 *
 * Паузы между запросами нет намеренно: десять одновременных выгрузок — это не
 * поведение человека, а худший случай, ради которого требование и написано.
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { jar, signIn } from './session.js';
import { kinds, record, statusIs } from './metrics.js';

const BASE_URL = __ENV.BASE_URL;
const PASSWORD = __ENV.PASSWORD;
const VUS = Number(__ENV.REPORT_VUS || 10);
const DURATION = __ENV.REPORT_DURATION || '2m';

/** Учебный год целиком: большой период, ради которого требование и написано. */
const PERIOD = 'from=2026-09-01&to=2027-08-31';

const fixture = JSON.parse(open(__ENV.FIXTURE));

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
		// записью внутри секунды и запирает её на минуту. Отчёт просят записи
		// нагрузочной команды — руководители и КАМы, каждый по своей области.
		sleep((__VU - 1) * 0.5);
		signIn(
			BASE_URL,
			fixture.accounts[(__VU - 1) % fixture.accounts.length],
			PASSWORD,
			`/w/${fixture.workspace}/interactions`
		);
		signedIn = true;
	}

	const mode = __VU % 2 === 0 ? 'movement' : 'snapshot';

	const screen = http.get(`${BASE_URL}/reports?mode=${mode}&${PERIOD}`, {
		jar,
		headers: HTML,
		tags: { step: 'report-screen' }
	});
	record('reportFilter', 'ssr', screen, statusIs(200));

	const xlsx = http.get(`${BASE_URL}/reports/export?format=xlsx&mode=${mode}&${PERIOD}`, {
		jar,
		headers: HTML,
		tags: { step: 'report-xlsx' }
	});
	record('reportXlsx', 'ssr', xlsx, statusIs(200));

	const pdf = http.get(`${BASE_URL}/reports/export?format=pdf&mode=${mode}&${PERIOD}`, {
		jar,
		headers: HTML,
		tags: { step: 'report-pdf' }
	});
	record('reportPdf', 'ssr', pdf, statusIs(200));

	// Тот же отчёт без сборки файла: разница с XLSX и PDF — это цена формата.
	const asJson = http.get(`${BASE_URL}/reports/export?format=json&mode=${mode}&${PERIOD}`, {
		jar,
		headers: { Accept: 'application/json' },
		tags: { step: 'report-json' }
	});
	kinds.api.duration.add(asJson.timings.duration);
	kinds.api.failed.add(asJson.status !== 200);
}
