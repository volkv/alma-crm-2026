/**
 * Синтетическая система обучения: то, что имитатор отдаёт вместо настоящего
 * Moodle.
 *
 * Данные выдуманы целиком и выведены из ключа строки, а не из генератора
 * случайных чисел: стенд обязан выглядеть одинаково при каждом запуске, иначе
 * снимок экрана в презентации перестанет совпадать с тем, что на экране, а
 * повторная выгрузка каждый раз считалась бы новой.
 *
 * Курсы названы кодами образовательных программ, а слушатели отнесены к вузам
 * теми же краткими наименованиями, что стоят в демонстрационном справочнике:
 * LMS оператора учит тех же самых партнёров, и строке выгрузки иначе не к чему
 * привязаться. Ни один вуз, ни одна фамилия и ни один адрес настоящему лицу не
 * принадлежат.
 */

/** Курс LMS: `idnumber` — код образовательной программы в нашем справочнике. */
export type MockCourse = {
	id: number;
	shortname: string;
	fullname: string;
	idnumber: string;
};

export const MOCK_COURSES: readonly MockCourse[] = [
	{
		id: 101,
		shortname: 'VO-BAK-01',
		fullname: 'Прикладная информатика в цифровых сервисах',
		idnumber: 'VO-BAK-01'
	},
	{
		id: 102,
		shortname: 'VO-BAK-02',
		fullname: 'Информационные системы и технологии связи',
		idnumber: 'VO-BAK-02'
	},
	{
		id: 103,
		shortname: 'VO-MAG-01',
		fullname: 'Инженерия данных и машинное обучение',
		idnumber: 'VO-MAG-01'
	},
	{
		id: 104,
		shortname: 'SPO-01',
		fullname: 'Информационные системы и программирование',
		idnumber: 'SPO-01'
	},
	{
		id: 105,
		shortname: 'DPO-01',
		fullname: 'Повышение квалификации преподавателей по промышленной разработке',
		idnumber: 'DPO-01'
	}
];

/** Вузы, слушатели которых учатся в этой LMS. */
export const MOCK_INSTITUTIONS: readonly string[] = [
	'СЗПУ',
	'ПУПИ',
	'УГУИС',
	'СИВТ',
	'ЮТУС',
	'БАЦЭ'
];

/** Подразделения: у Moodle это поле пользователя, у нас — площадка вуза. */
const DEPARTMENTS: readonly string[] = [
	'Главный корпус',
	'Кафедра информационных систем',
	'Учебный городок'
];

/**
 * Число, выведенное из ключа. Не случайное: одинаковый запрос обязан дать
 * одинаковый ответ, иначе повторная выгрузка каждый раз была бы новой.
 */
function fromKey(key: string, min: number, max: number): number {
	let hash = 2166136261;

	for (let index = 0; index < key.length; index += 1) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 16777619) >>> 0;
	}

	return min + (hash % (max - min + 1));
}

export type MockEnrolment = {
	id: number;
	fullname: string;
	institution: string;
	department: string;
	role: 'student' | 'editingteacher';
	/** Итоговая оценка за курс; `null` — курс ещё не закрыт этим слушателем. */
	grade: number | null;
};

/** Проходной балл курса — тот же у всех курсов мока. */
export const MOCK_GRADE_PASS = 60;
export const MOCK_GRADE_MAX = 100;

/**
 * Кто записан на курс. У каждого вуза свой набор слушателей и один
 * преподаватель: без преподавателя выгрузка выглядела бы так, будто в LMS
 * бывают только студенты, и правило «в строки идут только слушатели» нечем
 * было бы проверить.
 */
export function mockEnrolment(courseId: number): MockEnrolment[] {
	const course = MOCK_COURSES.find((item) => item.id === courseId);

	if (course === undefined) {
		return [];
	}

	const users: MockEnrolment[] = [];

	MOCK_INSTITUTIONS.forEach((institution, institutionIndex) => {
		const key = `${course.idnumber}:${institution}`;

		// Не каждый вуз ведёт каждую программу: сплошная решётка выглядела бы как
		// выдумка, а не как выгрузка.
		if (fromKey(`${key}:present`, 0, 9) < 2) {
			return;
		}

		const count = fromKey(`${key}:count`, 8, 64);
		const base = course.id * 1000 + institutionIndex * 100;

		users.push({
			id: base,
			fullname: `Преподаватель ${institution}`,
			institution,
			department: DEPARTMENTS[institutionIndex % DEPARTMENTS.length],
			role: 'editingteacher',
			grade: null
		});

		for (let index = 1; index <= count; index += 1) {
			const rowKey = `${key}:${index}`;
			// Часть слушателей ещё учится: пустая оценка — это «не завершил», а не
			// «завершил с нулём».
			const finished = fromKey(`${rowKey}:finished`, 0, 9) > 2;

			users.push({
				id: base + index,
				fullname: `Слушатель ${base + index}`,
				institution,
				department: DEPARTMENTS[(institutionIndex + index) % DEPARTMENTS.length],
				role: 'student',
				grade: finished ? fromKey(`${rowKey}:grade`, 35, 98) : null
			});
		}
	});

	return users;
}

/** Учебный год курса: с 1 сентября по 31 августа того года, в котором идём. */
export function mockCourseDates(now: Date): { startdate: number; enddate: number } {
	const year = now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;

	return {
		startdate: Math.floor(Date.UTC(year, 8, 1) / 1000),
		enddate: Math.floor(Date.UTC(year + 1, 7, 31) / 1000)
	};
}
