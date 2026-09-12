/**
 * Клиент веб-сервиса Moodle (REST).
 *
 * Moodle отвечает на один и тот же адрес `webservice/rest/server.php`, а что
 * именно спрашивают — говорит параметр `wsfunction`. Ошибку он отдаёт с кодом
 * 200 и телом `{exception, errorcode, message}`, поэтому «ответ пришёл» и
 * «ответ получен» здесь разные вещи, и разбирать тело приходится всегда.
 *
 * Запрос идёт `GET`-ом с параметрами в строке — так же, как показано в
 * документации самого Moodle. Причина не только в ней: мок живёт внутри этого
 * же приложения, а форменный `POST` без заголовка `Origin` отвергает хук
 * `csrf`, общий на весь продукт. Настоящий Moodle принимает оба способа.
 *
 * Типы ответов описаны ровно в тех полях, которые нужны выгрузке: Moodle
 * отдаёт их десятками, и объявлять всё подряд значило бы утверждать, что мы
 * на них полагаемся.
 */

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
 * Отказ со стороны LMS: недоступна, ответила не тем или пожаловалась
 * `errorcode`. Отдельный класс, потому что выгрузка обязана показать причину
 * сотруднику словами, а не «синхронизация не удалась».
 */
export class MoodleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MoodleError';
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
	const url = new URL(serviceUrl(baseUrl));
	url.searchParams.set('wstoken', token);
	url.searchParams.set('wsfunction', wsfunction);
	url.searchParams.set('moodlewsrestformat', 'json');

	for (const [name, value] of Object.entries(params)) {
		url.searchParams.set(name, value);
	}

	let response: Response;

	try {
		response = await fetch(url, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(MOODLE_TIMEOUT_MS)
		});
	} catch (error) {
		const reason =
			error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
				? `не ответила за ${MOODLE_TIMEOUT_MS / 1000} с`
				: `недоступна: ${error instanceof Error ? error.message : String(error)}`;

		throw new MoodleError(`Система обучения ${reason}`);
	}

	if (!response.ok) {
		throw new MoodleError(`Система обучения ответила ${response.status}`);
	}

	let body: unknown;

	try {
		body = await response.json();
	} catch {
		// Вместо JSON обычно приезжает страница входа или ошибка веб-сервера —
		// разбирать её нечем, а сказать об этом надо.
		throw new MoodleError('Система обучения ответила не в формате JSON');
	}

	if (isMoodleException(body)) {
		// Код отказа — в тексте, а не отдельным полем: читает его человек в
		// разделе интеграций, и `invalidtoken` рядом с фразой объясняет больше,
		// чем фраза одна.
		throw new MoodleError(`Система обучения отказала: ${body.message} (${body.errorcode})`);
	}

	return body;
}

function expectArray(body: unknown, wsfunction: MoodleFunction): unknown[] {
	if (!Array.isArray(body)) {
		throw new MoodleError(`Ответ ${wsfunction} — не список, как обещает контракт Moodle`);
	}

	return body;
}

export function createMoodleClient(options: { baseUrl: string; token: string }): MoodleClient {
	const { baseUrl, token } = options;

	return {
		async siteInfo() {
			const body = await call(baseUrl, token, 'core_webservice_get_site_info', {});

			if (typeof body !== 'object' || body === null || !('sitename' in body)) {
				throw new MoodleError('Ответ core_webservice_get_site_info не описывает площадку');
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
				throw new MoodleError('Ответ gradereport_user_get_grade_items не содержит usergrades');
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
