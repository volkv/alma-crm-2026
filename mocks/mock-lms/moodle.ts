/**
 * Ответы в форме веб-сервиса Moodle 4.x — второй протокол системы обучения.
 *
 * Зачем он здесь рядом с контрактом обмена. Протокол LMS — настройка
 * (`exchange.lms.protocol`), и их два: `exchange-v1` этого стенда и `moodle`,
 * которым говорит настоящая площадка заказчика (`docs/exchange-contract.md`,
 * раздел 1). Клиент `moodle.ts` в продукте ходит за курсами, записанными
 * слушателями и оценками; без этих четырёх функций имитатор проверял бы
 * половину обмена и молчал бы о второй.
 *
 * Moodle отвечает на один адрес `webservice/rest/server.php`, а что именно
 * спрашивают, говорит параметр `wsfunction`. Отказ он отдаёт кодом 200 и телом
 * `{exception, errorcode, message}` — имитатор обязан вести себя так же, иначе
 * клиент проверялся бы против поведения, которого у Moodle нет.
 */
import {
	mockCourseDates,
	mockEnrolment,
	MOCK_COURSES,
	MOCK_GRADE_MAX,
	MOCK_GRADE_PASS
} from './moodle-data.ts';
import type { MockReply, MockRequest } from '../shared/http.ts';

/**
 * Учётные данные и токен имитатора. Они и написаны в документации: за ними нет
 * ни данных, ни прав — только выдуманная выгрузка. Настоящий токен настоящей
 * LMS приходит настройкой и в репозитории не лежит.
 */
export const MOCK_LMS_USERNAME = 'operator';
export const MOCK_LMS_PASSWORD = 'mock-lms';
export const MOCK_LMS_SERVICE = 'moodle_mobile_app';
export const MOCK_LMS_TOKEN = 'mock-lms-token';

function exception(errorcode: string, message: string): MockReply {
	// Отказ веб-сервиса едет с кодом 200 и телом-исключением; клиент разбирает
	// именно тело.
	return { status: 200, json: { exception: 'moodle_exception', errorcode, message } };
}

/**
 * Параметры запроса: Moodle принимает их и в строке, и в теле формы. Имитатор
 * принимает так же — и остаётся образом того, с чем интегрируются, а не нашей
 * выдумкой о нём.
 */
export function readParams(request: MockRequest): URLSearchParams {
	if (request.method !== 'POST') {
		return request.url.searchParams;
	}

	const body = new URLSearchParams(request.rawBody);

	for (const [name, value] of request.url.searchParams) {
		if (!body.has(name)) {
			body.set(name, value);
		}
	}

	return body;
}

/** `GET|POST /login/token.php`: выдача токена по логину и паролю. */
export function moodleToken(params: URLSearchParams): MockReply {
	const username = params.get('username') ?? '';
	const password = params.get('password') ?? '';
	const service = params.get('service') ?? '';

	if (username !== MOCK_LMS_USERNAME || password !== MOCK_LMS_PASSWORD) {
		return {
			status: 200,
			json: {
				error: 'Invalid login, please try again',
				errorcode: 'invalidlogin',
				stacktrace: null
			}
		};
	}

	if (service !== MOCK_LMS_SERVICE) {
		return {
			status: 200,
			json: {
				error: `Service ${service} is not available`,
				errorcode: 'servicenotavailable',
				stacktrace: null
			}
		};
	}

	return { status: 200, json: { token: MOCK_LMS_TOKEN, privatetoken: null } };
}

function siteInfo(): unknown {
	return {
		sitename: 'Учебный портал оператора (демонстрационный)',
		username: MOCK_LMS_USERNAME,
		firstname: 'Оператор',
		lastname: 'Обмена',
		userid: 2,
		release: '4.4 (Build: 20240422)',
		version: '2024042200',
		functions: [
			{ name: 'core_webservice_get_site_info', version: '2024042200' },
			{ name: 'core_course_get_courses', version: '2024042200' },
			{ name: 'core_enrol_get_enrolled_users', version: '2024042200' },
			{ name: 'gradereport_user_get_grade_items', version: '2024042200' }
		]
	};
}

function courses(now: Date): unknown {
	const dates = mockCourseDates(now);

	return MOCK_COURSES.map((course) => ({
		id: course.id,
		shortname: course.shortname,
		fullname: course.fullname,
		displayname: course.fullname,
		idnumber: course.idnumber,
		categoryid: 1,
		visible: 1,
		format: 'topics',
		...dates
	}));
}

function enrolledUsers(courseId: number): unknown {
	return mockEnrolment(courseId).map((user) => ({
		id: user.id,
		fullname: user.fullname,
		institution: user.institution,
		department: user.department,
		roles: [{ roleid: user.role === 'student' ? 5 : 3, shortname: user.role }]
	}));
}

function gradeItems(courseId: number): unknown {
	return {
		usergrades: mockEnrolment(courseId).map((user) => ({
			courseid: courseId,
			userid: user.id,
			userfullname: user.fullname,
			gradeitems: [
				{
					id: courseId * 10,
					itemname: null,
					itemtype: 'course',
					graderaw: user.grade,
					grademax: MOCK_GRADE_MAX,
					gradepass: MOCK_GRADE_PASS
				}
			]
		})),
		warnings: []
	};
}

/** `GET|POST /webservice/rest/server.php`: разбор `wsfunction`. */
export function moodleRest(params: URLSearchParams, now: Date): MockReply {
	if (params.get('wstoken') !== MOCK_LMS_TOKEN) {
		return exception('invalidtoken', 'Invalid token - token not found');
	}

	if (params.get('moodlewsrestformat') !== 'json') {
		return exception('invalidrecord', 'Only the json rest format is available');
	}

	const wsfunction = params.get('wsfunction');

	if (wsfunction === 'core_webservice_get_site_info') {
		return { status: 200, json: siteInfo() };
	}

	if (wsfunction === 'core_course_get_courses') {
		return { status: 200, json: courses(now) };
	}

	if (wsfunction === 'core_enrol_get_enrolled_users') {
		const courseId = Number(params.get('courseid'));

		if (!Number.isInteger(courseId)) {
			return exception('invalidparameter', 'Invalid parameter value detected: courseid');
		}

		return { status: 200, json: enrolledUsers(courseId) };
	}

	if (wsfunction === 'gradereport_user_get_grade_items') {
		const courseId = Number(params.get('courseid'));

		if (!Number.isInteger(courseId)) {
			return exception('invalidparameter', 'Invalid parameter value detected: courseid');
		}

		return { status: 200, json: gradeItems(courseId) };
	}

	return exception(
		'accessexception',
		`Access control exception: unknown web service function ${wsfunction ?? ''}`
	);
}
