/**
 * Вход в систему для нагрузочного сценария.
 *
 * Паролей у приложения нет: вход идёт через каталог учётных записей по коду
 * авторизации с PKCE (`docs/auth.md`). Браузерной формы каталога k6 не
 * отрисовывает, а `direct grants` у клиента `lct-crm` выключены намеренно —
 * пароль не должен ходить через приложение. Поэтому сценарий проходит тот же
 * путь, что и браузер, только руками:
 *
 *   1. `POST /login` — приложение заводит попытку входа в Redis и отвечает
 *      адресом каталога;
 *   2. `GET` этого адреса — каталог показывает форму входа; из неё берётся
 *      адрес отправки (он одноразовый и несёт код сессии каталога);
 *   3. `POST` формы с именем и паролем — каталог отвечает возвратом на
 *      `/login/callback` с кодом;
 *   4. `GET` возврата — приложение меняет код на токены и ставит куку сессии.
 *
 * Куки держит банка k6: она своя у каждого VU и живёт всё время прогона,
 * поэтому вход происходит один раз на VU и в измеряемые операции не входит.
 */
import http from 'k6/http';
import { fail, sleep } from 'k6';

const HTML = { Accept: 'text/html,application/xhtml+xml' };

/**
 * Банка кук этого VU.
 *
 * Своя, а не та, что k6 заводит сам: собственную он **очищает на каждом
 * проходе**, и сессия, открытая в первом проходе, во втором уже не
 * предъявлялась бы — прогон мерил бы страницу входа и считал бы её очень
 * быстрой. Модуль у каждого VU свой, поэтому и банка своя: чужую сессию VU не
 * получает.
 */
export const jar = new http.CookieJar();

/** Значение атрибута `action` первой формы страницы, без HTML-мнемоник. */
function formAction(body) {
	const match = /<form[^>]*\saction="([^"]+)"/.exec(body);

	if (match === null) {
		fail('форма входа каталога не найдена: каталог ответил не страницей входа');
	}

	return match[1]
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

/**
 * Сколько раз повторить вход, отвергнутый каталогом.
 *
 * Каталог защищается от частых входов: два входа одной записью подряд внутри
 * секунды он считает подбором и запирает запись на минуту
 * (`quickLoginCheckMilliSeconds` / `minimumQuickLoginWaitSeconds`). Прогон
 * входит двумя десятками записей с полусотни VU, и одной записью входят два-три
 * VU, поэтому VU расходятся по времени сами (`browse.js`), а на случай, когда
 * запись всё-таки заперта, остаётся повтор.
 * Сдвигать настройки каталога ради нагрузочного прогона нельзя: мерить надо
 * систему, какая она есть.
 */
const SIGN_IN_ATTEMPTS = 4;
const SIGN_IN_RETRY_SECONDS = 20;

/**
 * Вход под указанной записью (`{ login }` из фикстуры прогона). Доказательство
 * входа — закрытая страница `probePath`, открывшаяся без перенаправления; сессия
 * остаётся кукой в банке VU.
 */
export function signIn(baseUrl, account, password, probePath) {
	for (let attempt = 1; attempt <= SIGN_IN_ATTEMPTS; attempt += 1) {
		if (attemptSignIn(baseUrl, account, password, probePath)) {
			return;
		}

		sleep(SIGN_IN_RETRY_SECONDS);
	}

	fail(`каталог не пустил «${account.login}» за ${SIGN_IN_ATTEMPTS} попытки`);
}

/**
 * Доказательство входа — не вид страницы каталога, а закрытый раздел
 * приложения, который открылся без перенаправления. Без этой проверки прогон
 * без сессии выглядел бы очень быстрым: страница входа отдаётся мгновенно, и
 * все числа оказались бы про неё.
 */
function hasSession(baseUrl, probePath) {
	const probe = http.get(`${baseUrl}${probePath}`, {
		headers: HTML,
		redirects: 0,
		jar,
		tags: { step: 'signin' }
	});

	return probe.status === 200;
}

/**
 * Адрес, с которого «пришёл» этот VU, — как его допишет в `X-Forwarded-For`
 * обратный прокси. Лимит начала входа считается на адрес
 * (`auth/start-limit.ts`), а все VU идут с петли одной машины: без своего
 * адреса у каждого сотня VU исчерпала бы лимит одного человека, и прогон мерил
 * бы отказ входа. Стенд верит заголовку (`TRUST_PROXY` в `compose.load.yml`).
 */
function forwardedFor() {
	return `10.${(__VU >> 16) & 255}.${(__VU >> 8) & 255}.${__VU & 255}`;
}

/** Один заход. `false` — каталог снова показал форму входа. */
function attemptSignIn(baseUrl, account, password, probePath) {
	const started = http.post(`${baseUrl}/login`, null, {
		headers: {
			...HTML,
			Origin: baseUrl,
			'Content-Type': 'application/x-www-form-urlencoded',
			'X-Forwarded-For': forwardedFor()
		},
		redirects: 0,
		jar,
		tags: { step: 'signin' }
	});

	// Приложение отвечает на отправку формы конвертом SvelteKit: в нём и лежит
	// адрес каталога. Заголовок `location` в таком ответе не ставится — вид
	// ответа выбирает фреймворк, а не наш код.
	let directory;

	if (started.status === 303) {
		directory = started.headers.Location;
	} else if (started.status === 200) {
		directory = JSON.parse(started.body).location;
	} else {
		fail(`начало входа отклонено: ${started.status}`);
	}

	const form = http.get(directory, { headers: HTML, jar, tags: { step: 'signin' } });

	if (form.status !== 200) {
		fail(`каталог не показал форму входа: ${form.status}`);
	}

	const submitted = http.post(
		formAction(form.body),
		{ username: account.login, password, credentialId: '' },
		{ headers: HTML, jar, tags: { step: 'signin' } }
	);

	if (submitted.status !== 200) {
		fail(`каталог не принял учётные данные: ${submitted.status}`);
	}

	// Путь `/login-actions/authenticate` в конечном адресе означает, что каталог
	// показал форму входа заново: учётные данные не приняты или запись заперта.
	if (submitted.url.indexOf('/login-actions/') !== -1) {
		return false;
	}

	return hasSession(baseUrl, probePath);
}
