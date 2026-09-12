import { describe, expect, it } from 'vitest';
import { hasCompleted, isStudent, type MoodleClient } from '$lib/server/integrations/lms/moodle';
import { academicYearOf, collectRows, toCsv } from '$lib/server/integrations/lms/sync';
import {
	MOCK_COURSES,
	MOCK_GRADE_MAX,
	MOCK_GRADE_PASS,
	mockEnrolment
} from '$lib/server/integrations/mock-lms/data';
import {
	MOCK_LMS_PASSWORD,
	MOCK_LMS_SERVICE,
	MOCK_LMS_TOKEN,
	MOCK_LMS_USERNAME,
	mockRest,
	mockToken
} from '$lib/server/integrations/mock-lms/server';

function params(values: Record<string, string>): URLSearchParams {
	return new URLSearchParams(values);
}

const NOW = new Date('2026-09-12T10:00:00.000Z');

function rest(values: Record<string, string>): unknown {
	return mockRest(params({ wstoken: MOCK_LMS_TOKEN, moodlewsrestformat: 'json', ...values }), NOW)
		.body;
}

describe('мок системы обучения', () => {
	it('выдаёт токен по логину и паролю и отказывает чужому', () => {
		expect(
			mockToken(
				params({
					username: MOCK_LMS_USERNAME,
					password: MOCK_LMS_PASSWORD,
					service: MOCK_LMS_SERVICE
				})
			).body
		).toMatchObject({ token: MOCK_LMS_TOKEN });

		expect(
			mockToken(params({ username: MOCK_LMS_USERNAME, password: 'нет', service: MOCK_LMS_SERVICE }))
				.body
		).toMatchObject({ errorcode: 'invalidlogin' });
	});

	it('отказывает без токена так же, как Moodle: кодом 200 и телом-исключением', () => {
		const response = mockRest(params({ wsfunction: 'core_course_get_courses' }), NOW);

		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({
			exception: 'moodle_exception',
			errorcode: 'invalidtoken'
		});
	});

	it('описывает площадку и отдаёт курсы кодами программ', () => {
		expect(rest({ wsfunction: 'core_webservice_get_site_info' })).toMatchObject({
			sitename: expect.stringContaining('оператора')
		});

		const courses = rest({ wsfunction: 'core_course_get_courses' }) as { idnumber: string }[];

		expect(courses.map((course) => course.idnumber)).toEqual(
			MOCK_COURSES.map((course) => course.idnumber)
		);
	});

	it('отдаёт одинаковый состав слушателей при каждом запросе', () => {
		const first = rest({
			wsfunction: 'core_enrol_get_enrolled_users',
			courseid: String(MOCK_COURSES[0].id)
		});
		const second = rest({
			wsfunction: 'core_enrol_get_enrolled_users',
			courseid: String(MOCK_COURSES[0].id)
		});

		expect(first).toEqual(second);
		expect((first as unknown[]).length).toBeGreaterThan(0);
	});

	it('жалуется на неизвестную функцию', () => {
		expect(rest({ wsfunction: 'core_user_delete_users' })).toMatchObject({
			errorcode: 'accessexception'
		});
	});
});

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

	it('не заводит колонку заявок: LMS о них ничего не знает', async () => {
		const csv = toCsv(await collectRows(client), { start: '2026-09-01', end: '2027-08-31' });

		expect(csv.split('\r\n')[0]).toBe(
			'Организация;Программа;Начало периода;Конец периода;Зачислено;Завершили обучение'
		);
		expect(csv).not.toContain('Заявки');
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
