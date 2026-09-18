/**
 * Выгрузка из системы обучения: курсы и записанные слушатели становятся
 * снимком данных об обучении.
 *
 * Своей таблицы у выгрузки нет и быть не должно: число обучающихся в системе
 * уже живёт снимком (`docs/stats.md`), у которого есть источник, период,
 * область и файл, из которого всё приехало. Поэтому адаптер собирает из
 * ответов LMS обычную таблицу, кладёт её в тот же сервис снимков и получает
 * то же самое, что получил бы человек, загрузивший файл руками, — включая
 * исходный файл в разделе документов.
 *
 * Чего адаптер не делает — не подтверждает снимок. Подтверждение вводит числа
 * в показатели, и это решение человека: «выгрузка приехала» и «мы согласны,
 * что отчёт теперь такой» — разные события. Снимок останавливается на
 * состоянии «проверен», и его видно в разделе «Данные об обучении».
 *
 * Повторный заход за тот же период с тем же содержимым снимка не создаёт:
 * ответ на вопрос «это уже загружено?» даёт сама база — снимок источника `lms`
 * за тот же период, собранный из файла с тем же отпечатком.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { LmsSyncState } from '$lib/contracts/integrations';
import type { StatMapping } from '$lib/contracts/stats';
import { formatIsoDay } from '$lib/format';
import type { ActorContext } from '../../actor';
import { recordAuditEvent } from '../../audit';
import { getDb } from '../../db';
import { documents, statSnapshots } from '../../db/schema';
import { sha256Hex } from '../../documents/storage';
import { requirePermission } from '../../rbac';
import { getRedis } from '../../redis';
import { spreadsheetText } from '../../spreadsheet';
import { applyMapping, createSnapshot, validateSnapshot } from '../../stats/import';
import { LMS_STATE_KEY } from '../redis-keys';
import { getLmsSettings } from '../settings';
import {
	createMoodleClient,
	hasCompleted,
	isStudent,
	MoodleError,
	type MoodleClient
} from './moodle';

/** Источник снимка: тот же код, что в справочнике источников `STAT_SOURCES`. */
const SOURCE = 'lms';

/** Колонки собранной таблицы и поля, в которые они сопоставлены. */
const COLUMNS = {
	organization: 'Организация',
	program: 'Программа',
	periodStart: 'Начало периода',
	periodEnd: 'Конец периода',
	enrolled: 'Зачислено',
	completed: 'Завершили обучение'
} as const;

/**
 * Сопоставление задано здесь, а не подсказкой по заголовкам: заголовки мы же и
 * написали, и угадывать собственную таблицу было бы притворством.
 *
 * Колонки «заявки» в выгрузке нет намеренно. LMS знает, кто записан и кто
 * доучился, но не знает, кто подавал заявку, а пустой столбец в снимке значил
 * бы «ноль заявок» — то есть неправду (см. `docs/stats.md`).
 */
const MAPPING: StatMapping = {
	[COLUMNS.organization]: 'organization',
	[COLUMNS.program]: 'program',
	[COLUMNS.periodStart]: 'periodStart',
	[COLUMNS.periodEnd]: 'periodEnd',
	[COLUMNS.enrolled]: 'enrolled',
	[COLUMNS.completed]: 'completed'
};

/**
 * Учебный год, в котором мы сейчас: с 1 сентября по 31 августа. Считается по
 * московскому календарю — как и всё остальное время в продукте.
 */
export function academicYearOf(now: Date = new Date()): { start: string; end: string } {
	const [year, month] = formatIsoDay(now).split('-').map(Number);
	const startYear = month >= 9 ? year : year - 1;

	return { start: `${startYear}-09-01`, end: `${startYear + 1}-08-31` };
}

/** Строка собранной таблицы: вуз, программа и два числа. */
type SyncRow = {
	organization: string;
	program: string;
	enrolled: number;
	completed: number;
};

/**
 * Значение в CSV. Разделитель и кавычки внутри значения не должны его рвать, а
 * само значение — выполниться формулой: названия вузов приезжают из чужой
 * системы, и `=HYPERLINK(...)` в поле `institution` иначе сработал бы у того,
 * кто открыл файл выгрузки в разделе документов.
 */
function csvCell(value: string): string {
	const safe = spreadsheetText(value);

	return /[";\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toCsv(rows: readonly SyncRow[], period: { start: string; end: string }): string {
	const header = [
		COLUMNS.organization,
		COLUMNS.program,
		COLUMNS.periodStart,
		COLUMNS.periodEnd,
		COLUMNS.enrolled,
		COLUMNS.completed
	];

	const lines = [header.join(';')];

	for (const row of rows) {
		lines.push(
			[
				csvCell(row.organization),
				csvCell(row.program),
				period.start,
				period.end,
				String(row.enrolled),
				String(row.completed)
			].join(';')
		);
	}

	return `${lines.join('\r\n')}\r\n`;
}

/**
 * Курсы и записанные слушатели → строки «вуз × программа».
 *
 * Зерно строки то же, что у файловой выгрузки: организация и программа за
 * период. Организация берётся из поля `institution` слушателя — в Moodle это
 * место, где у слушателя записан его вуз.
 */
export async function collectRows(client: MoodleClient): Promise<SyncRow[]> {
	const courses = await client.courses();
	const rows = new Map<string, SyncRow>();

	for (const course of courses) {
		const program = course.idnumber.trim() === '' ? course.shortname : course.idnumber;
		const [users, grades] = await Promise.all([
			client.enrolledUsers(course.id),
			client.gradeItems(course.id)
		]);

		const completedUserIds = new Set(
			grades.filter((entry) => hasCompleted(entry)).map((entry) => entry.userid)
		);

		for (const user of users) {
			if (!isStudent(user)) {
				continue;
			}

			const organization = user.institution.trim();

			if (organization === '') {
				// Слушателя без вуза строке не к чему отнести, и придумывать ему вуз
				// нельзя. Такие в выгрузку не идут, а расхождение числа видно по
				// счётчикам снимка.
				continue;
			}

			// Ключ строки — пара целиком, а не склейка через разделитель: название
			// вуза и код программы приходят снаружи, и любой разделитель однажды
			// встретится внутри значения.
			const key = JSON.stringify([organization, program]);
			const row = rows.get(key) ?? { organization, program, enrolled: 0, completed: 0 };

			row.enrolled += 1;
			row.completed += completedUserIds.has(user.id) ? 1 : 0;
			rows.set(key, row);
		}
	}

	return [...rows.values()].sort(
		(left, right) =>
			left.organization.localeCompare(right.organization, 'ru') ||
			left.program.localeCompare(right.program, 'ru')
	);
}

/**
 * Загружена ли уже такая выгрузка.
 *
 * Вопрос задаётся базе, а не отметке в Redis. «Та же выгрузка» — это снимок
 * источника `lms` за тот же период, собранный из файла с тем же отпечатком, и
 * всё это в базе уже есть: отдельная отметка со своим сроком жизни была бы
 * вторым ответом на тот же вопрос — и расходилась бы с первым, стоило снимку
 * исчезнуть вместе с базой стенда.
 *
 * Отклонённый снимок в счёт не идёт: его отклонили именно для того, чтобы
 * загрузить данные заново, и отметка, пережившая отклонение, оставила бы
 * период без данных до конца своего срока.
 */
async function isAlreadyLoaded(
	period: { start: string; end: string },
	sha256: string
): Promise<boolean> {
	const [row] = await getDb()
		.select({ id: statSnapshots.id })
		.from(statSnapshots)
		.innerJoin(documents, eq(documents.id, statSnapshots.fileDocumentId))
		.where(
			and(
				eq(statSnapshots.source, SOURCE),
				eq(statSnapshots.periodStart, period.start),
				eq(statSnapshots.periodEnd, period.end),
				ne(statSnapshots.status, 'rejected'),
				eq(documents.sha256, sha256)
			)
		)
		.limit(1);

	return row !== undefined;
}

async function writeState(state: LmsSyncState): Promise<void> {
	await getRedis().set(LMS_STATE_KEY, JSON.stringify(state));
}

export async function readLmsState(): Promise<LmsSyncState | null> {
	const raw = await getRedis().get(LMS_STATE_KEY);

	return raw === null ? null : (JSON.parse(raw) as LmsSyncState);
}

/**
 * Заход в систему обучения.
 *
 * Исключений не бросает: недоступная LMS, отказ веб-сервиса и непринятая
 * таблица — это состояние интеграции, а не сбой запроса, и сотрудник обязан
 * увидеть его словами в разделе «Интеграции» и строкой в журнале. Отказ по
 * правам — другое дело: он выносится до всякой работы и летит наверх, как у
 * любого другого действия.
 *
 * Отказ самой LMS сотрудник видит одним текстом, без её кода ответа: адрес
 * площадки задаёт человек, и раздел, различающий «ответила 403» и
 * «недоступна», рассказывал бы ему про чужую сеть. Код ответа остаётся в
 * журнале, машинный код причины — в логе сервера.
 */
export async function syncLms(ctx: ActorContext): Promise<LmsSyncState> {
	requirePermission(ctx, 'integrations.manage');
	// Выгрузка кладёт в систему данные об обучении, и право на это отдельное:
	// настраивать обмен и вводить в отчёт числа — разные полномочия. Спрошено
	// здесь, а не внутри сервиса снимков, чтобы отказ не превратился в
	// «состояние интеграции», которым он не является.
	requirePermission(ctx, 'stats.import');

	const startedAt = new Date().toISOString();
	const period = academicYearOf();

	const fail = async (message: string, status?: number): Promise<LmsSyncState> => {
		const state: LmsSyncState = {
			startedAt,
			finishedAt: new Date().toISOString(),
			ok: false,
			message,
			snapshotId: null,
			rows: 0
		};

		await writeState(state);
		await recordAuditEvent(ctx, {
			type: 'integrations.lms_sync_failed',
			outcome: 'failure',
			// Код ответа — единственная подробность, которую журнал принимает от
			// чужой системы: словарь подробностей (`validateAuditDetails`) не берёт
			// произвольный текст, и это правильно — в нём не должно быть чужих строк.
			details: status === undefined ? undefined : { status }
		});

		return state;
	};

	const settings = await getLmsSettings();

	if (settings.baseUrl === null || settings.token === null) {
		return fail('Не настроено: укажите адрес системы обучения и токен веб-сервиса');
	}

	try {
		const client = createMoodleClient({ baseUrl: settings.baseUrl, token: settings.token });

		// Первый вопрос — «кто там»: негодный токен и чужой адрес видно сразу, а
		// не после выкачивания всех курсов. Заодно площадка называет себя, и в
		// снимке остаётся, откуда он приехал.
		const site = await client.siteInfo();
		const rows = await collectRows(client);

		if (rows.length === 0) {
			return fail('Система обучения ответила, но в ней нет ни одного записанного слушателя');
		}

		const csv = toCsv(rows, period);
		const bytes = new TextEncoder().encode(csv);

		if (await isAlreadyLoaded(period, sha256Hex(bytes))) {
			const state: LmsSyncState = {
				startedAt,
				finishedAt: new Date().toISOString(),
				ok: true,
				message: `Изменений нет: такая же выгрузка за ${period.start} — ${period.end} уже загружена`,
				snapshotId: null,
				rows: rows.length
			};

			await writeState(state);

			return state;
		}

		const created = await createSnapshot(ctx, {
			source: SOURCE,
			// Полная выгрузка: подтверждение вытеснит прежнюю выгрузку LMS за тот
			// же период, а не сложится с ней.
			mode: 'full',
			periodKind: 'academic',
			periodStart: period.start,
			periodEnd: period.end,
			note: `Выгрузка из системы обучения «${site.sitename}» (${settings.baseUrl})`,
			file: {
				name: `lms-${period.start}.csv`,
				bytes
			}
		});

		await applyMapping(ctx, created.id, MAPPING);
		const validated = await validateSnapshot(ctx, created.id);

		const state: LmsSyncState = {
			startedAt,
			finishedAt: new Date().toISOString(),
			ok: true,
			message:
				validated.errorCount === 0
					? `Загружено строк: ${validated.rowCount}. Снимок ждёт подтверждения в разделе «Данные об обучении»`
					: `Загружено строк: ${validated.rowCount}, из них с ошибками: ${validated.errorCount}. Разберите их в разделе «Данные об обучении»`,
			snapshotId: created.id,
			rows: validated.rowCount
		};

		await writeState(state);

		await recordAuditEvent(ctx, {
			type: 'integrations.lms_synced',
			outcome: 'success',
			subject: { type: 'stat_snapshot', id: created.id },
			details: { snapshotId: created.id }
		});

		return state;
	} catch (error) {
		if (error instanceof MoodleError) {
			// Причина отказа нужна тому, кто разбирается с обменом, и не нужна на
			// экране: в логе сервера она полная, на экране — общий текст.
			console.error('[integrations] система обучения отказала', {
				code: error.code,
				status: error.status
			});

			return fail(error.message, error.status ?? undefined);
		}

		return fail(error instanceof Error ? error.message : String(error));
	}
}
