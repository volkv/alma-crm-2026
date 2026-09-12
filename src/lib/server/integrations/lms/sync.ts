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
 * состоянии «проверен», и его видно в разделе «Данные».
 *
 * Повторный заход за тот же период с тем же содержимым снимка не создаёт:
 * отпечаток выгрузки лежит в Redis (`lms:claim:<отпечаток>`), и второй такой
 * же заход честно сообщает, что изменений нет.
 */
import { createHash } from 'node:crypto';
import type { LmsSyncState } from '$lib/contracts/integrations';
import type { StatMapping } from '$lib/contracts/stats';
import { formatIsoDay } from '$lib/format';
import type { ActorContext } from '../../actor';
import { recordAuditEvent } from '../../audit';
import { requirePermission } from '../../rbac';
import { getRedis } from '../../redis';
import { applyMapping, createSnapshot, validateSnapshot } from '../../stats/import';
import { LMS_STATE_KEY, lmsClaimKey } from '../redis-keys';
import { getLmsSettings } from '../settings';
import { createMoodleClient, hasCompleted, isStudent, type MoodleClient } from './moodle';

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

/** Сколько живёт отпечаток выгрузки: дольше самого редкого расписания. */
const CLAIM_TTL_SECONDS = 30 * 24 * 60 * 60;

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

/** Значение в CSV: разделитель и кавычки внутри значения не должны его рвать. */
function csvCell(value: string): string {
	return /[";\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
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

/** Отпечаток выгрузки: источник, период и содержимое таблицы. */
export function fingerprintOf(period: { start: string; end: string }, csv: string): string {
	return createHash('sha256')
		.update(`${SOURCE}|${period.start}|${period.end}|${csv}`, 'utf8')
		.digest('hex');
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

	const fail = async (message: string): Promise<LmsSyncState> => {
		const state: LmsSyncState = {
			startedAt,
			finishedAt: new Date().toISOString(),
			ok: false,
			message,
			snapshotId: null,
			rows: 0
		};

		await writeState(state);
		await recordAuditEvent(ctx, { type: 'integrations.lms_sync_failed', outcome: 'failure' });

		return state;
	};

	const settings = await getLmsSettings();

	if (settings.baseUrl === null || settings.token === null) {
		return fail('Не настроено: укажите адрес системы обучения и токен веб-сервиса');
	}

	/** Отпечаток, который эта попытка успела занять: при сбое его надо вернуть. */
	let claimedFingerprint: string | null = null;

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
		const fingerprint = fingerprintOf(period, csv);

		const claimed = await getRedis().set(
			lmsClaimKey(fingerprint),
			startedAt,
			'EX',
			CLAIM_TTL_SECONDS,
			'NX'
		);

		if (claimed !== 'OK') {
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

		claimedFingerprint = fingerprint;

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
				bytes: new TextEncoder().encode(csv)
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
					? `Загружено строк: ${validated.rowCount}. Снимок ждёт подтверждения в разделе «Данные»`
					: `Загружено строк: ${validated.rowCount}, из них с ошибками: ${validated.errorCount}. Разберите их в разделе «Данные»`,
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
		if (claimedFingerprint !== null) {
			// Отпечаток занимается до записи снимка: не сложилось — значит, эта
			// выгрузка ещё не загружена, и следующая попытка обязана её принять, а
			// не отчитаться, что изменений нет.
			await getRedis().del(lmsClaimKey(claimedFingerprint));
		}

		return fail(error instanceof Error ? error.message : String(error));
	}
}
