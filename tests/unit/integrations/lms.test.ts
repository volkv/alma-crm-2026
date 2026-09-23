import { describe, expect, it } from 'vitest';
import { lmsSettingsFormSchema, lmsSettingsSchema } from '$lib/contracts/integrations';
import { hasCompleted, isStudent, type MoodleClient } from '$lib/server/integrations/lms/moodle';
import { academicYearOf, collectRows, toCsv } from '$lib/server/integrations/lms/sync';
import {
	MOCK_COURSES,
	MOCK_GRADE_MAX,
	MOCK_GRADE_PASS,
	mockEnrolment
} from '../../../mocks/mock-lms/moodle-data.ts';

/**
 * Клиент системы обучения и сборка снимка из её ответов.
 *
 * Синтетические данные берутся у имитатора стенда (`mocks/mock-lms`): выгрузка
 * обязана собираться ровно из того, что отдаёт он, а не из второй копии тех же
 * курсов.
 */

describe('завершение курса', () => {
	const item = (graderaw: number | null, gradepass: number | null, grademax = 100) => ({
		userid: 1,
		gradeitems: [{ itemtype: 'course', graderaw, grademax, gradepass }]
	});

	it('без оценки — не завершил', () => {
		// Пустая оценка это «ещё учится», а не «завершил с нулём».
		expect(hasCompleted(item(null, 60))).toBe(false);
	});

	it('сравнивается с проходным баллом, а при его отсутствии — с 60% максимума', () => {
		expect(hasCompleted(item(59, 60))).toBe(false);
		expect(hasCompleted(item(60, 60))).toBe(true);
		expect(hasCompleted(item(59, null))).toBe(false);
		expect(hasCompleted(item(61, null))).toBe(true);
	});

	it('не считает завершившим того, у кого нет итоговой оценки за курс', () => {
		expect(hasCompleted({ userid: 1, gradeitems: [] })).toBe(false);
	});

	it('в строки выгрузки идёт тот, кто учится, а не тот, кто ведёт', () => {
		const user = { id: 1, fullname: 'Кто-то', institution: 'СЗПУ', department: '' };

		expect(isStudent({ ...user, roles: [{ shortname: 'student' }] })).toBe(true);
		expect(isStudent({ ...user, roles: [{ shortname: 'editingteacher' }] })).toBe(false);
	});
});

describe('сборка строк выгрузки', () => {
	/** Клиент поверх тех же данных, что отдаёт мок, — без HTTP. */
	const client: MoodleClient = {
		siteInfo: () =>
			Promise.resolve({ sitename: 'Стенд', username: 'operator', release: '4.4', functions: [] }),
		courses: () =>
			Promise.resolve(MOCK_COURSES.map((course) => ({ ...course, startdate: 0, enddate: 0 }))),
		enrolledUsers: (courseId) =>
			Promise.resolve(
				mockEnrolment(courseId).map((user) => ({
					id: user.id,
					fullname: user.fullname,
					institution: user.institution,
					department: user.department,
					roles: [{ shortname: user.role }]
				}))
			),
		gradeItems: (courseId) =>
			Promise.resolve(
				mockEnrolment(courseId).map((user) => ({
					userid: user.id,
					gradeitems: [
						{
							itemtype: 'course',
							graderaw: user.grade,
							grademax: MOCK_GRADE_MAX,
							gradepass: MOCK_GRADE_PASS
						}
					]
				}))
			)
	};

	it('складывает слушателей по вузу и программе, преподавателей не считая', async () => {
		const rows = await collectRows(client);

		expect(rows.length).toBeGreaterThan(0);

		for (const row of rows) {
			expect(row.enrolled).toBeGreaterThan(0);
			expect(row.completed).toBeLessThanOrEqual(row.enrolled);
		}

		const students = mockEnrolment(MOCK_COURSES[0].id).filter((user) => user.role === 'student');
		const enrolled = rows
			.filter((row) => row.program === MOCK_COURSES[0].idnumber)
			.reduce((total, row) => total + row.enrolled, 0);

		// Преподаватели записаны на курс, но в выгрузку не идут: строка считает
		// тех, кто учится.
		expect(enrolled).toBe(students.length);
	});

	it('даёт одну и ту же таблицу при повторном заходе', async () => {
		const period = { start: '2026-09-01', end: '2027-08-31' };

		expect(toCsv(await collectRows(client), period)).toBe(toCsv(await collectRows(client), period));
	});

	it('обезвреживает название вуза, приехавшее из чужой системы', () => {
		// Поле `institution` заполняет тот, кто ведёт слушателей в LMS, а
		// собранный CSV лежит в разделе документов и открывается таблицей.
		const csv = toCsv(
			[
				{
					organization: '=HYPERLINK("http://attacker.example","Отчёт")',
					program: 'VO-MAG-01',
					enrolled: 1,
					completed: 0
				}
			],
			{ start: '2026-09-01', end: '2027-08-31' }
		);

		expect(csv).toContain('"\'=HYPERLINK');
		expect(csv).not.toContain('"=HYPERLINK');
	});

	it('не заводит колонку заявок: LMS о них ничего не знает', async () => {
		const csv = toCsv(await collectRows(client), { start: '2026-09-01', end: '2027-08-31' });

		expect(csv.split('\r\n')[0]).toBe(
			'Организация;Программа;Начало периода;Конец периода;Зачислено;Завершили обучение'
		);
		expect(csv).not.toContain('Заявки');
	});
});

describe('адрес системы обучения', () => {
	const settings = (baseUrl: string) =>
		lmsSettingsSchema.safeParse({ baseUrl, token: 'x', enabled: false, syncIntervalMinutes: 60 });

	it('принимает имена имитаторов стенда по http: сертификата у них нет', () => {
		// Ровно два имени и поимённо: образец вида `mock-*` открыл бы по http
		// любое имя внутри сети, а это и есть то, от чего правило защищает.
		expect(lmsSettingsSchema.parse({ baseUrl: 'http://mock-lms:8082' }).baseUrl).toBe(
			'http://mock-lms:8082'
		);
		expect(() => lmsSettingsSchema.parse({ baseUrl: 'http://mock-other:8082' })).toThrow();
	});

	it('принимает https и адрес на этой же машине', () => {
		expect(settings('https://lms.example.org').success).toBe(true);
		expect(settings('http://localhost:3000/mock-lms').success).toBe(true);
		expect(settings('http://127.0.0.1:8080').success).toBe(true);
	});

	it('не принимает http на чужую машину: сервер несёт туда токен веб-сервиса', () => {
		expect(settings('http://lms.internal/moodle').success).toBe(false);
		expect(settings('http://10.0.0.7:8080').success).toBe(false);
	});

	it('то же правило действует и в форме настроек', () => {
		const form = (baseUrl: string) =>
			lmsSettingsFormSchema.safeParse({
				baseUrl,
				token: '',
				enabled: false,
				syncIntervalMinutes: 60
			});

		expect(form('https://lms.example.org').success).toBe(true);
		// Пустое поле означает «адреса нет», а не «адрес не годится».
		expect(form('').success).toBe(true);
		expect(form('http://lms.internal/moodle').success).toBe(false);
		expect(form('ftp://lms.example.org').success).toBe(false);
	});
});

describe('учебный год', () => {
	it('начинается первого сентября', () => {
		expect(academicYearOf(new Date('2026-09-01T12:00:00.000Z'))).toEqual({
			start: '2026-09-01',
			end: '2027-08-31'
		});
		expect(academicYearOf(new Date('2026-08-31T12:00:00.000Z'))).toEqual({
			start: '2025-09-01',
			end: '2026-08-31'
		});
	});
});
