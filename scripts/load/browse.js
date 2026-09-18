/**
 * Сценарий «пятьдесят одновременных пользователей» (требование N6).
 *
 * Один проход VU повторяет обычный рабочий круг сотрудника: открыть список
 * взаимодействий, открыть карточку, перевести её на следующую стадию с
 * комментарием, сменить фильтр отчёта. Между шагами — пауза: человек читает то,
 * что открыл, и без паузы сценарий мерил бы не пятьдесят пользователей, а
 * пятьдесят непрерывных потоков запросов.
 *
 * Работают три роли сразу — КАМ, руководитель и администратор, — потому что
 * область доступа считается подзапросом на каждой выборке: у администратора он
 * вырождается в «всё», у КАМа перебирает три сотни действующих назначений, и
 * мерить только вторую или только первую значило бы мерить половину системы.
 *
 * Переход по процессу каждому VU достаётся своим куском списка карточек:
 * стадия — состояние, второй переход по той же карточке пошёл бы уже с другой
 * стадии и с другими правилами. Когда кусок кончается, шаг остаётся
 * комментарием — тоже отправка формы, тоже транзакция, но состояние не двигает.
 *
 * Запуск — `scripts/load/run.sh`; параметры приезжают переменными окружения.
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { ACCOUNTS, jar, signIn } from './session.js';
import { kinds, record } from './metrics.js';

const BASE_URL = __ENV.BASE_URL;
const PASSWORD = __ENV.PASSWORD;
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '3m';

const fixture = JSON.parse(open(__ENV.FIXTURE));

/** Сколько переходов достаётся одному VU: карточки делятся поровну. */
const TRANSITIONS_PER_VU = Math.floor(fixture.advance.length / VUS);

/** Период отчёта — учебный год: то, за что его действительно собирают. */
const PERIOD = 'from=2026-09-01&to=2027-08-31';

export const options = {
	scenarios: {
		browse: {
			executor: 'constant-vus',
			vus: VUS,
			duration: DURATION,
			gracefulStop: '30s'
		}
	},
	// Порог требования N1 — на операциях, названных в ТЗ. Он не «средний по
	// прогону»: секунда обещана человеку, который открыл экран, поэтому смотрим
	// на девяносто пятую долю, а не на среднее.
	thresholds: {
		op_list: ['p(95)<1000'],
		op_card: ['p(95)<1000'],
		op_transition: ['p(95)<1000'],
		op_report_filter: ['p(95)<1000'],
		ssr_failed: ['rate<0.01'],
		action_failed: ['rate<0.01'],
		api_failed: ['rate<0.01']
	},
	summaryTrendStats: ['med', 'p(95)', 'max', 'avg', 'count']
};

/** Вошёл ли этот VU и сколько переходов уже сделал. */
let signedIn = false;
let transitionsDone = 0;

const HTML = { Accept: 'text/html,application/xhtml+xml' };
const JSON_HEADERS = { Accept: 'application/json' };

function formHeaders() {
	return {
		...HTML,
		// Хук `csrf` отвергает форму, пришедшую с чужого адреса: браузер этот
		// заголовок ставит сам, k6 — нет.
		Origin: BASE_URL,
		'Content-Type': 'application/x-www-form-urlencoded'
	};
}

export default function () {
	if (!signedIn) {
		// VU расходятся по времени: каталог считает подбором два входа одной
		// записью внутри секунды и запирает её на минуту. Полсекунды на VU — это
		// полторы секунды между входами одной и той же записи.
		sleep((__VU - 1) * 0.5);
		signIn(BASE_URL, ACCOUNTS[(__VU - 1) % ACCOUNTS.length], PASSWORD);
		signedIn = true;
	}

	// Список: страница, с которой начинается рабочий день. Страница выборки
	// сдвигается от прохода к проходу — читать одну и ту же первую страницу
	// значило бы мерить попадание в кэш страниц PostgreSQL.
	const page = 1 + (__ITER % 10);
	const list = http.get(`${BASE_URL}/interactions?page=${page}&sortBy=dueAt&direction=asc`, {
		jar,
		headers: HTML,
		tags: { step: 'list' }
	});
	record('list', 'ssr', list);
	sleep(1);

	const cardId = fixture.cards[((__VU - 1) * 97 + __ITER * 13) % fixture.cards.length];
	const card = http.get(`${BASE_URL}/interactions/${cardId}`, {
		jar,
		headers: HTML,
		tags: { step: 'card' }
	});
	record('card', 'ssr', card);
	sleep(1);

	// Подсказка выбора организации: тот же сервер, но ответ — JSON, и упирается
	// он в другое, чем страница. В долю ошибок он идёт своей строкой.
	const lookup = http.get(
		`${BASE_URL}/interactions/lookup?kind=organizations&q=${encodeURIComponent('универ')}`,
		{
			jar,
			headers: JSON_HEADERS,
			tags: { step: 'lookup' }
		}
	);
	kinds.api.duration.add(lookup.timings.duration);
	kinds.api.failed.add(lookup.status !== 200);

	// Переход по процессу — с комментарием, как его и делают: чем закончилась
	// стадия, пишут в том же диалоге, которым её закрывают.
	if (transitionsDone < TRANSITIONS_PER_VU) {
		const target = fixture.advance[(__VU - 1) * TRANSITIONS_PER_VU + transitionsDone];
		transitionsDone += 1;

		const moved = http.post(
			`${BASE_URL}/interactions/${target.id}?/advance`,
			{
				fromStageId: target.fromStageId,
				toStageId: target.toStageId,
				revision: String(fixture.revision),
				reason: 'Нагрузочный прогон: стадия закрыта, идём дальше.'
			},
			{ headers: formHeaders(), jar, redirects: 0, tags: { step: 'transition' } }
		);

		record('transition', 'action', moved);
	} else {
		const commented = http.post(
			`${BASE_URL}/interactions/${cardId}?/comment`,
			{ body: 'Нагрузочный прогон: отметка о работе по записи.' },
			{ headers: formHeaders(), jar, redirects: 0, tags: { step: 'comment' } }
		);

		record('transition', 'action', commented);
	}

	sleep(1);

	// Смена фильтра отчёта: тот же отчёт с другим разрезом — именно так с ним и
	// работают, а не открывают один раз.
	const mode = __ITER % 2 === 0 ? 'slice' : 'movement';
	const report = http.get(`${BASE_URL}/reports?mode=${mode}&${PERIOD}&page=1`, {
		jar,
		headers: HTML,
		tags: { step: 'report-filter' }
	});
	record('reportFilter', 'ssr', report);

	sleep(1);
}
