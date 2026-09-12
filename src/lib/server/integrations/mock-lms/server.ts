/**
 * Мок системы обучения: ответы в форме Moodle 4.x на синтетических данных.
 *
 * Зачем он в продукте. Интеграция с LMS — половина задачи, а показать её,
 * стоя перед жюри, не на чем: настоящий Moodle заказчика наружу не смотрит.
 * Поэтому в приложении живёт заглушка, которая говорит на языке веб-сервиса
 * Moodle, — и клиент, который ходит в неё, тот же самый, что пойдёт в
 * настоящую LMS: адрес берётся из настроек.
 *
 * Мок включается флагом окружения `MOCK_LMS`; без него маршрутов нет вовсе
 * (404). Он ничего не хранит и никого не пускает дальше себя: единственная
 * проверка — совпадение токена, и назначение у неё одно — показать, что
 * клиент действительно предъявляет токен.
 */
import {
	mockCourseDates,
	mockEnrolment,
	MOCK_COURSES,
	MOCK_GRADE_MAX,
	MOCK_GRADE_PASS
} from './data';

/**
 * Учётные данные и токен мока. Они и написаны в документации: за ними нет ни
 * данных, ни прав — только выдуманная выгрузка. Настоящий токен настоящей LMS
 * приходит настройкой и в репозитории не лежит.
 */
export const MOCK_LMS_USERNAME = 'operator';
export const MOCK_LMS_PASSWORD = 'mock-lms';
export const MOCK_LMS_SERVICE = 'moodle_mobile_app';
export const MOCK_LMS_TOKEN = 'mock-lms-token';

/** Ответ веб-сервиса: либо тело, либо отказ в форме Moodle. */
export type MockResponse = { status: number; body: unknown };

function exception(errorcode: string, message: string): MockResponse {
	// Moodle отдаёт отказ веб-сервиса с кодом 200 и телом-исключением; клиент
	// разбирает именно тело, и мок обязан вести себя так же.
	return { status: 200, body: { exception: 'moodle_exception', errorcode, message } };
}

/** `POST|GET /mock-lms/login/token.php`: выдача токена по логину и паролю. */
export function mockToken(params: URLSearchParams): MockResponse {
	const username = params.get('username') ?? '';
	const password = params.get('password') ?? '';
	const service = params.get('service') ?? '';

	if (username !== MOCK_LMS_USERNAME || password !== MOCK_LMS_PASSWORD) {
		return {
			status: 200,
			body: {
				error: 'Invalid login, please try again',
				errorcode: 'invalidlogin',
				stacktrace: null
			}
		};
	}

	if (service !== MOCK_LMS_SERVICE) {
		return {
			status: 200,
			body: {
				error: `Service ${service} is not available`,
				errorcode: 'servicenotavailable',
				stacktrace: null
			}
		};
	}

	return { status: 200, body: { token: MOCK_LMS_TOKEN, privatetoken: null } };
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

/** `GET|POST /mock-lms/webservice/rest/server.php`: разбор `wsfunction`. */
export function mockRest(params: URLSearchParams, now: Date): MockResponse {
	if (params.get('wstoken') !== MOCK_LMS_TOKEN) {
		return exception('invalidtoken', 'Invalid token - token not found');
	}

	if (params.get('moodlewsrestformat') !== 'json') {
		return exception('invalidrecord', 'Only the json rest format is available');
	}

	const wsfunction = params.get('wsfunction');

	if (wsfunction === 'core_webservice_get_site_info') {
		return { status: 200, body: siteInfo() };
	}

	if (wsfunction === 'core_course_get_courses') {
		return { status: 200, body: courses(now) };
	}

	if (wsfunction === 'core_enrol_get_enrolled_users') {
		const courseId = Number(params.get('courseid'));

		if (!Number.isInteger(courseId)) {
			return exception('invalidparameter', 'Invalid parameter value detected: courseid');
		}

		return { status: 200, body: enrolledUsers(courseId) };
	}

	if (wsfunction === 'gradereport_user_get_grade_items') {
		const courseId = Number(params.get('courseid'));

		if (!Number.isInteger(courseId)) {
			return exception('invalidparameter', 'Invalid parameter value detected: courseid');
		}

		return { status: 200, body: gradeItems(courseId) };
	}

	return exception(
		'accessexception',
		`Access control exception: unknown web service function ${wsfunction ?? ''}`
	);
}

/**
 * Параметры запроса: Moodle принимает их и в строке, и в теле формы. Мок
 * принимает так же — и остаётся мокапом того, с чем интегрируются, а не нашей
 * выдумкой о нём.
 */
export async function readParams(request: Request, url: URL): Promise<URLSearchParams> {
	if (request.method !== 'POST') {
		return url.searchParams;
	}

	const body = new URLSearchParams(await request.text());

	for (const [name, value] of url.searchParams) {
		if (!body.has(name)) {
			body.set(name, value);
		}
	}

	return body;
}
