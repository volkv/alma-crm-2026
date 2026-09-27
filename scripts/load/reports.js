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
 *
 * Отчёт просят записи нагрузочной команды по кругу: первые три — руководители,
 * остальные — КАМы, каждый по своей области. Как и в `browse.js`, прогон идёт в
 * два окна: сначала все VU входят (руководитель — с одноразовым кодом,
 * `session.js`), и только потом начинается измеряемое окно, в котором
 * отчёт просят все десять сразу. Сколько VU вошло и сколько опоздало, считают
 * `signed_in` и `signed_in_late`, и на обоих стоит порог: прогон, в котором
 * руководители не вошли, десяти одновременных отчётов не мерил.
 */
import http from 'k6/http';
import exec from 'k6/execution';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { jar, signIn } from './session.js';
import { kinds, record, statusIs } from './metrics.js';

const BASE_URL = __ENV.BASE_URL;
const PASSWORD = __ENV.PASSWORD;
const VUS = Number(__ENV.REPORT_VUS || 10);
/** Окно входа и измеряемое окно, секунды. Считает их `run.sh`. */
const SIGN_IN_S = Number(__ENV.SIGN_IN_S);
const MEASURE_S = Number(__ENV.MEASURE_S);

if (!(SIGN_IN_S > 0 && MEASURE_S > 0)) {
	throw new Error('SIGN_IN_S и MEASURE_S задаёт run.sh');
}

/** Учебный год целиком: большой период, ради которого требование и написано. */
const PERIOD = 'from=2026-09-01&to=2027-08-31';

const fixture = JSON.parse(open(__ENV.FIXTURE));

export const options = {
	scenarios: {
		reports: {
			executor: 'constant-vus',
			vus: VUS,
			duration: `${SIGN_IN_S + MEASURE_S}s`,
			gracefulStop: '60s'
		}
	},
	// Порога в секунду здесь нет: ТЗ обещает секунду отклику интерфейса, а
	// выгрузка за год — это файл, который собирают и ждут. Что именно вышло,
	// написано числами в `docs/performance.md`.
	thresholds: {
		ssr_failed: ['rate<0.01'],
		api_failed: ['rate<0.01'],
		signed_in: [`count>=${VUS}`],
		signed_in_late: ['count<1']
	},
	summaryTrendStats: ['med', 'p(95)', 'max', 'avg', 'count']
};

const signedInCount = new Counter('signed_in');
const signedInLate = new Counter('signed_in_late');

let signedIn = false;

const HTML = { Accept: 'text/html,application/xhtml+xml' };

export default function () {
	if (!signedIn) {
		const account = fixture.accounts[(__VU - 1) % fixture.accounts.length];
		// Роль записи — меткой на всех точках VU: отчёт руководителя строится
		// по области в разы больше, и разбивка (`run.sh breakdown`) делит по ней.
		exec.vu.tags.role = account.realmRole;
		// VU расходятся по времени: каталог считает подбором два входа одной
		// записью внутри секунды и запирает её на минуту.
		sleep((__VU - 1) * 0.5);
		signIn(BASE_URL, account, PASSWORD, `/w/${fixture.workspace}/interactions`);
		signedIn = true;
		signedInCount.add(1);

		// Ждём начала измеряемого окна: отчёт просят все десять сразу.
		const wait = (exec.scenario.startTime + SIGN_IN_S * 1000 - Date.now()) / 1000;

		if (wait > 0) {
			sleep(wait);
		} else {
			signedInLate.add(1);
		}
	}

	const mode = __VU % 2 === 0 ? 'movement' : 'snapshot';

	// Отчёт живёт внутри пространства, и выгрузка лежит под его адресом.
	const reports = `${BASE_URL}/w/${fixture.workspace}/reports`;
	const screen = http.get(`${reports}?mode=${mode}&${PERIOD}`, {
		jar,
		headers: HTML,
		tags: { step: 'report-screen' }
	});
	record('reportFilter', 'ssr', screen, statusIs(200));

	const xlsx = http.get(`${reports}/export?format=xlsx&mode=${mode}&${PERIOD}`, {
		jar,
		headers: HTML,
		tags: { step: 'report-xlsx' }
	});
	record('reportXlsx', 'ssr', xlsx, statusIs(200));

	const pdf = http.get(`${reports}/export?format=pdf&mode=${mode}&${PERIOD}`, {
		jar,
		headers: HTML,
		tags: { step: 'report-pdf' }
	});
	record('reportPdf', 'ssr', pdf, statusIs(200));

	// Тот же отчёт без сборки файла: разница с XLSX и PDF — это цена формата.
	const asJson = http.get(`${reports}/export?format=json&mode=${mode}&${PERIOD}`, {
		jar,
		headers: { Accept: 'application/json' },
		tags: { step: 'report-json' }
	});
	kinds.api.duration.add(asJson.timings.duration);
	kinds.api.failed.add(asJson.status !== 200);
}
