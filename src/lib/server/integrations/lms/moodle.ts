/**
 * Клиент веб-сервиса Moodle (REST).
 *
 * Moodle отвечает на один и тот же адрес `webservice/rest/server.php`, а что
 * именно спрашивают — говорит параметр `wsfunction`. Ошибку он отдаёт с кодом
 * 200 и телом `{exception, errorcode, message}`, поэтому «ответ пришёл» и
 * «ответ получен» здесь разные вещи, и разбирать тело приходится всегда.
 *
 * Запрос идёт `POST`-ом, а параметры едут формой в теле. Moodle принимает и
 * строку запроса, и форму, но `wstoken` — это ключ ко всем данным площадки, а
 * строка запроса попадает в журнал доступа веб-сервера, в заголовок `Referer` и
 * в историю посредника. Тело туда не попадает.
 *
 * Типы ответов описаны ровно в тех полях, которые нужны выгрузке: Moodle
 * отдаёт их десятками, и объявлять всё подряд значило бы утверждать, что мы
 * на них полагаемся.
 */

import { outboundTargetIssue } from '../outbound';

/** Сколько ждём LMS: она ходит в свою базу, но не бесконечно. */
export const MOODLE_TIMEOUT_MS = 15_000;

/** Функции веб-сервиса, которыми пользуется выгрузка. */
export const MOODLE_FUNCTIONS = [
	'core_webservice_get_site_info',
	'core_course_get_courses',
	'core_enrol_get_enrolled_users',
	'gradereport_user_get_grade_items'
] as const;

export type MoodleFunction = (typeof MOODLE_FUNCTIONS)[number];

/**
 * Единственный текст отказа для сотрудника.
 *
 * Один на все случаи намеренно. Адрес системы обучения задаёт человек, и
 * раздел настроек, различающий «ответила 403», «ответила не в формате JSON» и
 * «недоступна», превращается в определитель внутренней сети: по тексту отказа
 * видно, что живёт за каждым адресом. Что именно случилось, остаётся в
 * журнале и в логе сервера, а сотруднику остаётся то, что он может поправить.
 */
export const LMS_REFUSAL =
	'Обмен с системой обучения не удался: проверьте адрес и токен веб-сервиса в настройках раздела';

/**
 * Отказ со стороны LMS: недоступна, ответила не тем или пожаловалась
 * `errorcode`. Отдельный класс, потому что сообщение сотруднику и причина для
 * журнала — разные вещи: сообщение одно на все отказы, а причина машинная.
 */
export class MoodleError extends Error {
	/** Машинный код отказа: уходит в лог сервера, но не на экран. */
	readonly code: string;
	/** Код ответа, если он был; `null` — до ответа дело не дошло. */
	readonly status: number | null;

	constructor(code: string, status: number | null = null) {
		super(LMS_REFUSAL);
		this.name = 'MoodleError';
		this.code = code;
		this.status = status;
	}
}

export type MoodleSiteInfo = {
	sitename: string;
	username: string;
	/** Версия Moodle строкой вида `2024042200`. */
	release: string;
	functions: { name: string }[];
};

export type MoodleCourse = {
	id: number;
	shortname: string;
	fullname: string;
	/** Внешний код курса; у нас в нём лежит код образовательной программы. */
	idnumber: string;
	startdate: number;
	enddate: number;
};

export type MoodleEnrolledUser = {
	id: number;
	fullname: string;
	/** Организация слушателя — по ней строка выгрузки относится к вузу. */
	institution: string;
	department: string;
	roles: { shortname: string }[];
};

export type MoodleGradeItem = {
	userid: number;
	gradeitems: {
		itemtype: string;
		graderaw: number | null;
		grademax: number | null;
		gradepass: number | null;
	}[];
};

export type MoodleClient = {
	siteInfo(): Promise<MoodleSiteInfo>;
	courses(): Promise<MoodleCourse[]>;
	enrolledUsers(courseId: number): Promise<MoodleEnrolledUser[]>;
	gradeItems(courseId: number): Promise<MoodleGradeItem[]>;
};

/** Адрес веб-сервиса: хвост добавляется к адресу площадки, а не наоборот. */
function serviceUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/webservice/rest/server.php`;
}

/** Код отказа веб-сервиса в том виде, в каком его можно писать в лог. */
function safeErrorCode(value: unknown): string {
	return String(value)
		.replace(/[^a-z0-9_-]/gi, '')
		.slice(0, 60);
}

function isMoodleException(body: unknown): body is { errorcode: string; message: string } {
	return (
		typeof body === 'object' &&
		body !== null &&
		'exception' in body &&
		'message' in body &&
		typeof (body as { message: unknown }).message === 'string'
	);
}

async function call(
	baseUrl: string,
	token: string,
	wsfunction: MoodleFunction,
	params: Record<string, string>
): Promise<unknown> {
	// Адрес проверяется перед каждым заходом, а не только при сохранении: имя,
	// указывавшее наружу в день настройки, к моменту выгрузки указывает куда
	// угодно (перепривязка DNS), и вместе с запросом туда уехал бы токен.
	const refusal = await outboundTargetIssue(baseUrl);

	if (refusal !== null) {
		throw new MoodleError('blocked_target');
	}

	const url = new URL(serviceUrl(baseUrl));
	const form = new URLSearchParams({
		wstoken: token,
		wsfunction,
		moodlewsrestformat: 'json',
		...params
	});

	let response: Response;

	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
			},
			body: form,
			// За перенаправлением не идём: адрес площадки проверен, а `Location`
			// ведёт куда угодно — и унёс бы туда токен веб-сервиса, то есть ключ к
			// чужим данным.
			redirect: 'manual',
			signal: AbortSignal.timeout(MOODLE_TIMEOUT_MS)
		});
	} catch (error) {
		throw new MoodleError(
			error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
				? 'timeout'
				: 'unreachable'
		);
	}

	if (response.status >= 300 && response.status < 400) {
		throw new MoodleError('redirect', response.status);
	}

	if (!response.ok) {
		throw new MoodleError('http_status', response.status);
	}

	let body: unknown;

	try {
		body = await response.json();
	} catch {
		// Вместо JSON обычно приезжает страница входа или ошибка веб-сервера —
		// разбирать её нечем.
		throw new MoodleError('not_json', response.status);
	}

	if (isMoodleException(body)) {
		// Код отказа веб-сервиса (`invalidtoken` и подобные) — машинный: он
		// объясняет причину тому, кто читает лог сервера, а на экран не выходит.
		throw new MoodleError(`ws:${safeErrorCode(body.errorcode)}`, response.status);
	}

	return body;
}

function expectArray(body: unknown, wsfunction: MoodleFunction): unknown[] {
	if (!Array.isArray(body)) {
		throw new MoodleError(`shape:${wsfunction}`);
	}

	return body;
}

export function createMoodleClient(options: { baseUrl: string; token: string }): MoodleClient {
	const { baseUrl, token } = options;

	return {
		async siteInfo() {
			const body = await call(baseUrl, token, 'core_webservice_get_site_info', {});

			if (typeof body !== 'object' || body === null || !('sitename' in body)) {
				throw new MoodleError('shape:core_webservice_get_site_info');
			}

			return body as MoodleSiteInfo;
		},

		async courses() {
			const body = await call(baseUrl, token, 'core_course_get_courses', {});

			return expectArray(body, 'core_course_get_courses') as MoodleCourse[];
		},

		async enrolledUsers(courseId) {
			const body = await call(baseUrl, token, 'core_enrol_get_enrolled_users', {
				courseid: String(courseId)
			});

			return expectArray(body, 'core_enrol_get_enrolled_users') as MoodleEnrolledUser[];
		},

		async gradeItems(courseId) {
			const body = await call(baseUrl, token, 'gradereport_user_get_grade_items', {
				courseid: String(courseId)
			});

			if (typeof body !== 'object' || body === null || !('usergrades' in body)) {
				throw new MoodleError('shape:gradereport_user_get_grade_items');
			}

			return expectArray(
				(body as { usergrades: unknown }).usergrades,
				'gradereport_user_get_grade_items'
			) as MoodleGradeItem[];
		}
	};
}

/**
 * Завершил ли слушатель курс.
 *
 * Считается по итоговой оценке за курс (`itemtype: 'course'`): есть оценка и
 * она не ниже проходной. Там, где проходной балл не задан, за него берётся
 * шестьдесят процентов от максимума — это умолчание самого Moodle для
 * настройки «оценка для зачёта».
 */
export function hasCompleted(user: MoodleGradeItem): boolean {
	const total = user.gradeitems.find((item) => item.itemtype === 'course');

	if (total === undefined || total.graderaw === null) {
		return false;
	}

	const pass =
		total.gradepass !== null && total.gradepass > 0
			? total.gradepass
			: total.grademax === null
				? null
				: total.grademax * 0.6;

	return pass === null ? false : total.graderaw >= pass;
}

/** Слушатель, а не преподаватель: в выгрузку идут те, кто учится. */
export function isStudent(user: MoodleEnrolledUser): boolean {
	return user.roles.some((role) => role.shortname === 'student');
}
