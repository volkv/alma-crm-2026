/**
 * Сценарий «пятьдесят одновременных пользователей» (требования N1 и N6).
 *
 * Один проход VU повторяет обычный рабочий круг сотрудника: открыть список
 * взаимодействий, открыть карточку, перевести запись на следующую стадию,
 * оставить комментарий, сменить фильтр отчёта. Между шагами — пауза: человек
 * читает то, что открыл, и без паузы сценарий мерил бы не пятьдесят
 * пользователей, а пятьдесят непрерывных потоков запросов.
 *
 * Входит нагрузочная команда — двадцать КАМов и три руководителя
 * (`scripts/seed/load.ts`); VU раздаются им по кругу, так что у одной записи
 * два-три VU. Всё, что VU открывает и переводит, взято из области доступа его
 * записи (`fixture.ts`): карточка чужого портфеля вернулась бы «не найдено», и
 * прогон мерил бы отказ.
 *
 * Переход — изменение состояния, поэтому каждому VU достаётся свой кусок
 * свежего пула записей, заведённого под этот прогон (`fixture.ts --pool`): одну
 * запись дважды не переводят, а пул рассчитан на весь прогон. Кончился пул —
 * это ошибка сценария, а не повод тихо заменить переход чем-то другим: её
 * считает `pool_exhausted`, и на ней стоит порог.
 *
 * Переход и комментарий отправляются так же, как их отправляет страница с
 * `use:enhance`, и засчитываются, только если сервер ответил `success`
 * (`actionSucceeded`): отказ формы приходит с HTTP 200, и по статусу его не
 * отличить. Число принятых сервером изменений `run.sh` потом сверяет с базой.
 *
 * Запуск — `scripts/load/run.sh`; параметры приезжают переменными окружения.
 */
import http from 'k6/http';
import { fail, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { jar, signIn } from './session.js';
import {
	actionSucceeded,
	applied,
	kinds,
	N1_MS,
	record,
	serverTiming,
	statusIs
} from './metrics.js';

const BASE_URL = __ENV.BASE_URL;
const PASSWORD = __ENV.PASSWORD;
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '3m';

const fixture = JSON.parse(open(__ENV.FIXTURE));

if (fixture.run === null) {
	throw new Error('В фикстуре нет пула переходов: её собирают с --run и --pool (run.sh)');
}

/** Раздел взаимодействий пространства: с него начинается рабочий день. */
const INTERACTIONS = `${BASE_URL}/w/${fixture.workspace}/interactions`;

/** Сколько VU входят одной записью: по столько частей делится её пул. */
const VUS_PER_ACCOUNT = Math.ceil(VUS / fixture.accounts.length);

/** Период отчёта — учебный год: то, за что его действительно собирают. */
const PERIOD = 'from=2026-09-01&to=2027-08-31';

/**
 * Фильтры отчёта, которые перебирает сценарий: срез и движение, срез по
 * просроченным и по стадии, всё — в пространстве записи.
 */
const REPORT_FILTERS = [
	`mode=snapshot&${PERIOD}&workspace=${fixture.workspace}`,
	`mode=movement&${PERIOD}&workspace=${fixture.workspace}`,
	`mode=snapshot&${PERIOD}&workspace=${fixture.workspace}&overdue=true`,
	`mode=snapshot&${PERIOD}&workspace=${fixture.workspace}&stage=meeting`
];

const poolExhausted = new Counter('pool_exhausted');

/** Порог N1 — на каждой операции рабочего круга, девяносто пятая доля. */
const N1 = [`p(95)<${N1_MS}`];

export const options = {
	scenarios: {
		browse: {
			executor: 'constant-vus',
			vus: VUS,
			duration: DURATION,
			gracefulStop: '30s'
		}
	},
	// Секунда обещана человеку, который открыл экран, поэтому порог стоит на
	// девяносто пятой доле, а не на среднем; максимум и доля ответов дольше
	// секунды (`op_*_over_1s`) печатаются рядом.
	thresholds: {
		op_list: N1,
		op_card: N1,
		op_transition: N1,
		op_comment: N1,
		op_report_filter: N1,
		ssr_failed: ['rate<0.01'],
		action_failed: ['rate<0.01'],
		api_failed: ['rate<0.01'],
		pool_exhausted: ['count<1']
	},
	summaryTrendStats: ['med', 'p(95)', 'max', 'avg', 'count']
};

/**
 * Запись этого VU и его часть пула переходов. Считается в первом проходе, а не
 * при загрузке модуля: модуль k6 загружает ещё и без VU (`__VU` — ноль), чтобы
 * прочитать `options`.
 */
let account;
let slot;
let pool;

function claim() {
	account = fixture.accounts[(__VU - 1) % fixture.accounts.length];
	slot = Math.floor((__VU - 1) / fixture.accounts.length);

	const share = Math.floor(account.advance.length / VUS_PER_ACCOUNT);
	pool = account.advance.slice(slot * share, (slot + 1) * share);
}

/** Вошёл ли этот VU и сколько переходов уже сделал. */
let signedIn = false;
let transitionsDone = 0;

const HTML = { Accept: 'text/html,application/xhtml+xml' };

/** Заголовки отправки формы так, как их ставит `use:enhance`. */
const ACTION_HEADERS = {
	Accept: 'application/json',
	// Хук `csrf` отвергает форму, пришедшую с чужого адреса: браузер этот
	// заголовок ставит сам, k6 — нет.
	Origin: BASE_URL,
	'Content-Type': 'application/x-www-form-urlencoded',
	'x-sveltekit-action': 'true'
};

export default function () {
	if (!signedIn) {
		claim();
		// VU расходятся по времени: каталог считает подбором два входа одной
		// записью внутри секунды и запирает её на минуту. Полсекунды на VU — это
		// одиннадцать с половиной секунд между входами одной и той же записи.
		sleep((__VU - 1) * 0.5);
		signIn(BASE_URL, account, PASSWORD, `/w/${fixture.workspace}/interactions`);
		signedIn = true;
	}

	// Список: страница выборки сдвигается от прохода к проходу — читать одну и
	// ту же первую страницу значило бы мерить попадание в кэш страниц PostgreSQL.
	// Страниц по двадцать пять строк в портфеле КАМа шесть, берём первые пять.
	const page = 1 + (__ITER % 5);
	const list = http.get(`${INTERACTIONS}?view=table&page=${page}&sort=dueAt`, {
		jar,
		headers: HTML,
		redirects: 0,
		tags: { step: 'list' }
	});
	record('list', 'ssr', list, statusIs(200));
	sleep(1);

	const cardId = account.cards[(slot * 97 + __ITER * 13) % account.cards.length];
	const card = http.get(`${INTERACTIONS}/${cardId}`, {
		jar,
		headers: HTML,
		redirects: 0,
		tags: { step: 'card' }
	});
	record('card', 'ssr', card, statusIs(200));

	// Подсказка выбора организации: тот же сервер, но ответ — JSON, и упирается
	// он в другое, чем страница. В долю ошибок он идёт своей строкой.
	const lookup = http.get(
		`${INTERACTIONS}/lookup?kind=organizations&q=${encodeURIComponent('универ')}`,
		{ jar, headers: { Accept: 'application/json' }, redirects: 0, tags: { step: 'lookup' } }
	);
	serverTiming(lookup, 'lookup');
	kinds.api.duration.add(lookup.timings.duration);
	kinds.api.failed.add(lookup.status !== 200);
	sleep(1);

	// Переход по процессу — с причиной, как его и делают: чем закончилась
	// стадия, пишут в том же диалоге, которым её закрывают.
	if (transitionsDone < pool.length) {
		const target = pool[transitionsDone];
		transitionsDone += 1;

		const moved = http.post(
			`${INTERACTIONS}/${target.id}?/advance`,
			{
				fromStageId: target.fromStageId,
				toStageId: target.toStageId,
				revision: String(fixture.revision),
				reason: `Нагрузочный прогон [${fixture.run}]: стадия закрыта, идём дальше.`
			},
			{ headers: ACTION_HEADERS, jar, redirects: 0, tags: { step: 'transition' } }
		);

		if (record('transition', 'action', moved, actionSucceeded)) {
			applied.transition.add(1);
		}
	} else {
		poolExhausted.add(1);
	}

	sleep(1);

	const commented = http.post(
		`${INTERACTIONS}/${cardId}?/comment`,
		{ body: `Нагрузочный прогон [${fixture.run}]: отметка о работе по записи.` },
		{ headers: ACTION_HEADERS, jar, redirects: 0, tags: { step: 'comment' } }
	);

	if (record('comment', 'action', commented, actionSucceeded)) {
		applied.comment.add(1);
	}

	sleep(1);

	// Смена фильтра отчёта: тот же отчёт с другим разрезом — именно так с ним и
	// работают, а не открывают один раз.
	const filter = REPORT_FILTERS[(slot + __ITER) % REPORT_FILTERS.length];
	const report = http.get(`${BASE_URL}/reports?${filter}&page=1`, {
		jar,
		headers: HTML,
		redirects: 0,
		tags: { step: 'report-filter' }
	});
	record('reportFilter', 'ssr', report, statusIs(200));

	sleep(1);
}

export function setup() {
	if (fixture.accounts.some((entry) => entry.advance.length < VUS_PER_ACCOUNT)) {
		fail(`пул переходов меньше ${VUS_PER_ACCOUNT} записей на сотрудника: соберите фикстуру заново`);
	}
}
