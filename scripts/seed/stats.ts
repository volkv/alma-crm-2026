/**
 * Данные об обучении для демонстрационного стенда: два подтверждённых снимка
 * за соседние учебные годы и один проверенный, но ещё не принятый — с теми
 * самыми ошибками, ради которых проверка и существует.
 *
 * Числа выдуманы и выведены из ключа строки, а не из генератора случайных
 * чисел: стенд обязан выглядеть одинаково при каждой заливке, иначе снимок
 * экрана в презентации перестанет совпадать с тем, что на экране.
 *
 * В наборе намеренно есть и ноль, и пропуск: «ноль заявок» и «данных нет» —
 * разные ответы, и показать это можно только данными, где встречается и то и
 * другое.
 *
 * Файла у сидированных снимков нет: это не загрузка, а сразу её результат.
 * Проверить путь «файл → строки» можно загрузкой из интерфейса — на стенде она
 * работает так же, как у заказчика.
 */
import { statRows, statSnapshots } from '$lib/server/db/schema';
import type { StatMapping, StatRowIssue } from '$lib/contracts/stats';
import type { Tx } from '$lib/server/db/transaction';
import { seedId } from './ids';

/**
 * Идентификаторы снимков заданы явно: повторная заливка обязана узнать свои
 * строки. Ключи `seedId` перечислены под наборы справочника, а снимок — не
 * справочник, поэтому его идентификатор записан константой.
 */
const SNAPSHOT_IDS = {
	'2025': '00000000-0000-4000-8000-000000005701',
	'2026': '00000000-0000-4000-8000-000000005702',
	pending: '00000000-0000-4000-8000-000000005703'
} as const;

/**
 * Организации выгрузки и то, как они названы в файле. Короткие названия
 * повторяют справочник намеренно: `raw` хранит строку такой, какой её прислал
 * вуз, и подставлять туда идентификатор бессмысленно.
 */
const ORGANIZATIONS: readonly { key: string; name: string }[] = [
	{ key: 'szpu', name: 'СЗПУ' },
	{ key: 'pupi', name: 'ПУПИ' },
	{ key: 'uguis', name: 'УГУИС' },
	{ key: 'sivt', name: 'СИВТ' },
	{ key: 'yutus', name: 'ЮТУС' },
	{ key: 'batse', name: 'БАЦЭ' }
];

/**
 * Программы выгрузки и их коды в файле. Коды обязаны совпадать со справочником
 * (`directory.ts`, те же ключи): в `raw` лежит строка, которую видит человек в
 * построчной проверке, и код, которого в справочнике нет, читается как ошибка
 * загрузки — хотя строка разобралась и посчиталась.
 */
const PROGRAMS: readonly { key: string; code: string }[] = [
	{ key: 'vo-bak-01', code: 'VO-BAK-01' },
	{ key: 'vo-bak-02', code: 'VO-BAK-02' },
	{ key: 'vo-bak-03', code: 'VO-BAK-03' },
	{ key: 'vo-mag-01', code: 'VO-MAG-01' },
	{ key: 'vo-mag-02', code: 'VO-MAG-02' },
	{ key: 'spo-01', code: 'SPO-01' },
	{ key: 'spo-02', code: 'SPO-02' },
	{ key: 'school-01', code: 'SCH-01' },
	{ key: 'dpo-01', code: 'DPO-01' },
	{ key: 'dpo-02', code: 'DPO-02' }
];

/** Колонки файла и поля, в которые они сопоставлены. */
const MAPPING: StatMapping = {
	Вуз: 'organization',
	'Код программы': 'program',
	'Подано заявок': 'applications',
	Зачислено: 'enrolled',
	'Параллельные потоки': 'parallelStreams',
	'Завершили обучение': 'completed',
	'Охват, план': 'coveragePlan',
	'Охват, факт': 'coverageFact'
};

/** Учебные годы выгрузок. */
const PERIODS = {
	'2025': { start: '2025-09-01', end: '2026-08-31', confirmedAt: '2026-09-15T09:20:00.000Z' },
	'2026': { start: '2026-09-01', end: '2027-08-31', confirmedAt: '2026-09-10T11:40:00.000Z' }
} as const;

/**
 * Число, выведенное из ключа строки. Не случайное: одинаковая заливка обязана
 * дать одинаковый стенд, а `Math.random` дал бы новый набор при каждом запуске.
 */
function fromKey(key: string, min: number, max: number): number {
	let hash = 2166136261;

	for (let index = 0; index < key.length; index += 1) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 16777619) >>> 0;
	}

	return min + (hash % (max - min + 1));
}

type RowSeed = typeof statRows.$inferInsert;

/** Значение для `raw`: в файле всё текст, в том числе пропуск. */
function cell(value: number | null): string {
	return value === null ? '' : String(value);
}

function rowsFor(snapshotId: string, year: '2025' | '2026'): RowSeed[] {
	const period = PERIODS[year];
	const rows: RowSeed[] = [];

	ORGANIZATIONS.forEach((organization, organizationIndex) => {
		PROGRAMS.forEach((program, programIndex) => {
			// Не каждый вуз ведёт каждую программу: сплошная решётка выглядела бы
			// как выдумка, а не как выгрузка.
			if ((organizationIndex * 3 + programIndex) % 4 === 3) {
				return;
			}

			const key = `${year}:${organization.key}:${program.key}`;
			const closed = fromKey(`${key}:closed`, 0, 10) === 0;

			// Программа заявлена, но набора в этом году не было: ноль — это
			// результат, и он обязан отличаться от пропуска.
			const applications = closed ? 0 : fromKey(`${key}:applications`, 14, 190);
			const enrolled = closed
				? 0
				: Math.round((applications * fromKey(`${key}:enrolled`, 55, 92)) / 100);
			const parallelStreams = enrolled === 0 ? 0 : Math.max(1, Math.ceil(enrolled / 28));
			// Учебный год ещё идёт — сколько человек его завершит, неизвестно.
			// Это не ноль, это отсутствие данных.
			const completed =
				year === '2026' ? null : Math.round((enrolled * fromKey(`${key}:completed`, 70, 97)) / 100);
			const coveragePlan = fromKey(`${key}:plan`, 2, 9) * 25;
			// У части вузов факт охвата ещё не собран: колонка в файле пустая.
			const coverageFact =
				fromKey(`${key}:fact`, 0, 4) === 0
					? null
					: Math.round((coveragePlan * fromKey(`${key}:factShare`, 60, 105)) / 100);

			rows.push({
				snapshotId,
				rowNo: rows.length + 1,
				organizationId: seedId('organization', organization.key),
				programId: seedId('program', program.key),
				periodStart: period.start,
				periodEnd: period.end,
				applications,
				enrolled,
				parallelStreams,
				completed,
				coveragePlan,
				coverageFact,
				raw: {
					Вуз: organization.name,
					'Код программы': program.code,
					'Подано заявок': cell(applications),
					Зачислено: cell(enrolled),
					'Параллельные потоки': cell(parallelStreams),
					'Завершили обучение': cell(completed),
					'Охват, план': cell(coveragePlan),
					'Охват, факт': cell(coverageFact)
				},
				issues: [],
				isValid: true
			});
		});
	});

	return rows;
}

/** Претензии тех строк, из-за которых снимок и остался непринятым. */
const PENDING_ISSUES: Record<number, StatRowIssue[]> = {
	4: [
		{
			field: 'organization',
			message: 'Организация «Институт цифровых технологий» не найдена в справочнике'
		}
	],
	5: [{ field: 'applications', message: 'Заявки: «много» не похоже на целое число' }],
	6: [{ field: 'enrolled', message: 'Зачислено: отрицательное значение -4' }]
};

/**
 * Снимок, дошедший до проверки: три строки разобрались, три — нет. Такой
 * снимок остаётся в системе и после отказа: по нему видно, что именно не
 * приняли и почему.
 */
function pendingRows(snapshotId: string): RowSeed[] {
	const period = PERIODS['2026'];

	const good = [0, 1, 2].map((index) => {
		const organization = ORGANIZATIONS[index];
		const program = PROGRAMS[index + 3];
		const applications = fromKey(`pending:${organization.key}:${program.key}`, 20, 90);
		const enrolled = Math.round((applications * 3) / 4);

		return {
			snapshotId,
			rowNo: index + 1,
			organizationId: seedId('organization', organization.key),
			programId: seedId('program', program.key),
			periodStart: period.start,
			periodEnd: period.end,
			applications,
			enrolled,
			parallelStreams: Math.max(1, Math.ceil(enrolled / 28)),
			completed: null,
			coveragePlan: null,
			coverageFact: null,
			raw: {
				Вуз: organization.name,
				'Код программы': program.code,
				'Подано заявок': String(applications),
				Зачислено: String(enrolled),
				'Параллельные потоки': String(Math.max(1, Math.ceil(enrolled / 28)))
			},
			issues: [],
			isValid: true
		} satisfies RowSeed;
	});

	const bad: RowSeed[] = [
		{
			snapshotId,
			rowNo: 4,
			organizationId: null,
			programId: seedId('program', PROGRAMS[0].key),
			periodStart: period.start,
			periodEnd: period.end,
			applications: 44,
			enrolled: 31,
			parallelStreams: 2,
			completed: null,
			coveragePlan: null,
			coverageFact: null,
			raw: {
				Вуз: 'Институт цифровых технологий',
				'Код программы': PROGRAMS[0].code,
				'Подано заявок': '44',
				Зачислено: '31',
				'Параллельные потоки': '2'
			},
			issues: PENDING_ISSUES[4],
			isValid: false
		},
		{
			snapshotId,
			rowNo: 5,
			organizationId: seedId('organization', ORGANIZATIONS[3].key),
			programId: seedId('program', PROGRAMS[1].key),
			periodStart: period.start,
			periodEnd: period.end,
			applications: null,
			enrolled: 18,
			parallelStreams: 1,
			completed: null,
			coveragePlan: null,
			coverageFact: null,
			raw: {
				Вуз: ORGANIZATIONS[3].name,
				'Код программы': PROGRAMS[1].code,
				'Подано заявок': 'много',
				Зачислено: '18',
				'Параллельные потоки': '1'
			},
			issues: PENDING_ISSUES[5],
			isValid: false
		},
		{
			snapshotId,
			rowNo: 6,
			organizationId: seedId('organization', ORGANIZATIONS[4].key),
			programId: seedId('program', PROGRAMS[2].key),
			periodStart: period.start,
			periodEnd: period.end,
			applications: 57,
			enrolled: null,
			parallelStreams: null,
			completed: null,
			coveragePlan: null,
			coverageFact: null,
			raw: {
				Вуз: ORGANIZATIONS[4].name,
				'Код программы': PROGRAMS[2].code,
				'Подано заявок': '57',
				Зачислено: '-4',
				'Параллельные потоки': ''
			},
			issues: PENDING_ISSUES[6],
			isValid: false
		}
	];

	return [...good, ...bad];
}

const CONFIRMED_ROWS = {
	'2025': rowsFor(SNAPSHOT_IDS['2025'], '2025'),
	'2026': rowsFor(SNAPSHOT_IDS['2026'], '2026')
} as const;

const PENDING_ROWS = pendingRows(SNAPSHOT_IDS.pending);

/**
 * Сколько строк каждого набора описано в коде. Тест сверяет с этим то, что
 * оказалось в базе: расхождение означает, что часть строк молча не вставилась.
 */
export const STATS_SEED_SIZES = {
	snapshots: 3,
	confirmed: 2,
	rows: CONFIRMED_ROWS['2025'].length + CONFIRMED_ROWS['2026'].length + PENDING_ROWS.length,
	invalidRows: PENDING_ROWS.filter((row) => !row.isValid).length
} as const;

/**
 * Заливает снимки. Существующие строки не трогает: идентификаторы снимков и
 * пара «снимок + номер строки» известны заранее, поэтому повторный запуск
 * натыкается на ключ и пропускает строку — правки на стенде переживают
 * перезапуск контейнера.
 */
export async function seedStats(tx: Tx, options: { authorUserId: string }): Promise<void> {
	await tx
		.insert(statSnapshots)
		.values([
			{
				id: SNAPSHOT_IDS['2025'],
				source: 'file',
				mode: 'full',
				periodKind: 'academic',
				periodStart: PERIODS['2025'].start,
				periodEnd: PERIODS['2025'].end,
				status: 'confirmed',
				isCurrent: true,
				mapping: MAPPING,
				rowCount: CONFIRMED_ROWS['2025'].length,
				errorCount: 0,
				note: 'Свод по учебному году 2025/2026, принят от вузов одной выгрузкой.',
				createdBy: options.authorUserId,
				confirmedBy: options.authorUserId,
				confirmedAt: new Date(PERIODS['2025'].confirmedAt)
			},
			{
				id: SNAPSHOT_IDS['2026'],
				source: 'file',
				mode: 'full',
				periodKind: 'academic',
				periodStart: PERIODS['2026'].start,
				periodEnd: PERIODS['2026'].end,
				status: 'confirmed',
				isCurrent: true,
				mapping: MAPPING,
				rowCount: CONFIRMED_ROWS['2026'].length,
				errorCount: 0,
				note: 'Набор 2026/2027: обучение идёт, поэтому колонка «завершили» пустая.',
				createdBy: options.authorUserId,
				confirmedBy: options.authorUserId,
				confirmedAt: new Date(PERIODS['2026'].confirmedAt)
			},
			{
				id: SNAPSHOT_IDS.pending,
				source: 'lms',
				mode: 'append',
				periodKind: 'academic',
				periodStart: PERIODS['2026'].start,
				periodEnd: PERIODS['2026'].end,
				status: 'validated',
				isCurrent: false,
				mapping: MAPPING,
				rowCount: PENDING_ROWS.length,
				errorCount: STATS_SEED_SIZES.invalidRows,
				note: 'Выгрузка LMS за сентябрь: три строки не разобрались, снимок ждёт решения.',
				createdBy: options.authorUserId
			}
		])
		.onConflictDoNothing({ target: statSnapshots.id });

	await tx
		.insert(statRows)
		.values([...CONFIRMED_ROWS['2025'], ...CONFIRMED_ROWS['2026'], ...PENDING_ROWS])
		.onConflictDoNothing({ target: [statRows.snapshotId, statRows.rowNo] });
}
