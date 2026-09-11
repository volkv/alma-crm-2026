import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	auditEvents,
	organizations,
	stageEntries,
	stageEntryStatus,
	stagePauses
} from '$lib/server/db/schema';
import {
	daysFrom,
	failureCode,
	insertInteractionWithStage,
	insertUser,
	startTestDatabase,
	type TestDatabase
} from './helpers/db';

// Vitest поднимает этот вызов выше импортов. Без него `$env/dynamic/private`
// остаётся слепком `.env`, снятым при старте Vitest, и сервисы пойдут в базу
// разработчика вместо контейнера.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const DAY_SECONDS = 24 * 60 * 60;

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

describe('миграции', () => {
	it('создают таблицы схемы и представление статуса стадии', async () => {
		const rows = await database.raw<{ name: string | null }[]>`
			select to_regclass('public.' || name)::text as name
			from unnest(array[
				'users', 'roles', 'permissions', 'role_permissions', 'app_settings',
				'audit_events', 'organizations', 'sites', 'people', 'affiliations',
				'programs', 'program_versions', 'products', 'stage_routes', 'stages',
				'stage_transitions', 'interactions', 'interaction_parties',
				'interaction_party_sites', 'interaction_programs', 'interaction_products',
				'interaction_changes', 'stage_entries', 'stage_pauses', 'blockers',
				'comments', 'document_templates', 'documents', 'api_keys',
				'stage_entry_status'
			]) as name
		`;

		expect(rows).toHaveLength(30);
		expect(rows.filter((row) => row.name === null)).toEqual([]);
	});
});

describe('журнал действий', () => {
	async function insertEvent(): Promise<void> {
		await database.db.insert(auditEvents).values({
			requestId: 'req-1',
			source: 'ui',
			eventType: 'auth.login',
			outcome: 'success',
			actorLabel: 'Тестовый Пользователь'
		});
	}

	it('не позволяет изменить запись', async () => {
		await insertEvent();

		expect(await failureCode(database.raw`update audit_events set outcome = 'failure'`)).toBe(
			'23001'
		);
	});

	it('не позволяет удалить запись', async () => {
		await insertEvent();

		expect(await failureCode(database.raw`delete from audit_events`)).toBe('23001');

		const [row] = await database.raw<{ count: string }[]>`select count(*) from audit_events`;
		expect(Number(row.count)).toBe(1);
	});
});

describe('ограничения справочника', () => {
	it('требует уровень образования ровно у учебных заведений', async () => {
		expect(
			await failureCode(
				database.db.insert(organizations).values({
					kind: 'customer_company',
					educationLevel: 'vo',
					legalName: 'ООО «Заказчик»',
					shortName: 'Заказчик'
				})
			)
		).toBe('23514');

		expect(
			await failureCode(
				database.db.insert(organizations).values({
					kind: 'educational_institution',
					legalName: 'Университет',
					shortName: 'Университет'
				})
			)
		).toBe('23514');

		await database.db.insert(organizations).values({
			kind: 'educational_institution',
			educationLevel: 'vo',
			legalName: 'Университет',
			shortName: 'Университет'
		});

		const rows = await database.db.select({ id: organizations.id }).from(organizations);
		expect(rows).toHaveLength(1);
	});

	it('не пускает две записи с одной внешней ссылкой и не мешает записям без неё', async () => {
		await database.db.insert(organizations).values({
			kind: 'operator',
			legalName: 'Оператор',
			shortName: 'Оператор',
			externalSource: 'moodle',
			externalId: '42'
		});

		expect(
			await failureCode(
				database.db.insert(organizations).values({
					kind: 'operator',
					legalName: 'Оператор-двойник',
					shortName: 'Двойник',
					externalSource: 'moodle',
					externalId: '42'
				})
			)
		).toBe('23505');

		// Другая система с тем же идентификатором — другая запись.
		await database.db.insert(organizations).values({
			kind: 'operator',
			legalName: 'Оператор из 1С',
			shortName: '1С',
			externalSource: '1c',
			externalId: '42'
		});

		// Записей без внешней ссылки может быть сколько угодно.
		await database.db.insert(organizations).values([
			{ kind: 'customer_company', legalName: 'Первая', shortName: 'Первая' },
			{ kind: 'customer_company', legalName: 'Вторая', shortName: 'Вторая' }
		]);

		const rows = await database.db.select({ id: organizations.id }).from(organizations);
		expect(rows).toHaveLength(4);
	});
});

describe('стадии', () => {
	it('допускает только одну открытую запись на взаимодействие', async () => {
		const ownerUserId = await insertUser(database.db);
		const { interactionId, stageId, snapshot } = await insertInteractionWithStage(database.db, {
			ownerUserId
		});

		await database.db.insert(stageEntries).values({
			interactionId,
			stageId,
			stageSnapshot: snapshot
		});

		expect(
			await failureCode(
				database.db.insert(stageEntries).values({ interactionId, stageId, stageSnapshot: snapshot })
			)
		).toBe('23505');

		// Закрытая запись освобождает место следующей.
		await database.db.update(stageEntries).set({ leftAt: new Date(), outcome: 'completed' });
		await database.db
			.insert(stageEntries)
			.values({ interactionId, stageId, stageSnapshot: snapshot });

		const rows = await database.db.select({ id: stageEntries.id }).from(stageEntries);
		expect(rows).toHaveLength(2);
	});

	it('допускает только одну открытую паузу на записи стадии', async () => {
		const ownerUserId = await insertUser(database.db);
		const { interactionId, stageId, snapshot } = await insertInteractionWithStage(database.db, {
			ownerUserId
		});

		const [entry] = await database.db
			.insert(stageEntries)
			.values({ interactionId, stageId, stageSnapshot: snapshot })
			.returning({ id: stageEntries.id });

		await database.db.insert(stagePauses).values({
			stageEntryId: entry.id,
			reason: 'waiting_counterparty',
			note: 'Ждём ответа вуза'
		});

		expect(
			await failureCode(
				database.db.insert(stagePauses).values({
					stageEntryId: entry.id,
					reason: 'waiting_internal',
					note: 'И ещё чего-то ждём'
				})
			)
		).toBe('23505');

		const rows = await database.db.select({ id: stagePauses.id }).from(stagePauses);
		expect(rows).toHaveLength(1);
	});
});

describe('представление stage_entry_status', () => {
	type Entry = { entryId: string; interactionId: string };

	async function makeEntry(
		ownerUserId: string,
		options: { enteredAt: Date; leftAt?: Date; slaDays?: number }
	): Promise<Entry> {
		const { interactionId, stageId, snapshot } = await insertInteractionWithStage(database.db, {
			ownerUserId,
			slaDays: options.slaDays ?? 5
		});

		const [entry] = await database.db
			.insert(stageEntries)
			.values({
				interactionId,
				stageId,
				stageSnapshot: snapshot,
				enteredAt: options.enteredAt,
				leftAt: options.leftAt ?? null,
				outcome: options.leftAt === undefined ? null : 'completed'
			})
			.returning({ id: stageEntries.id });

		return { entryId: entry.id, interactionId };
	}

	async function status(entryId: string) {
		const [row] = await database.db
			.select()
			.from(stageEntryStatus)
			.where(eq(stageEntryStatus.stageEntryId, entryId));

		return row;
	}

	it('сдвигает срок ровно на длительность пересечения паузы с окном', async () => {
		const ownerUserId = await insertUser(database.db);
		const base = new Date();
		const enteredAt = daysFrom(base, -10);

		const plain = await makeEntry(ownerUserId, { enteredAt });
		const paused = await makeEntry(ownerUserId, { enteredAt });
		const overlapping = await makeEntry(ownerUserId, { enteredAt });

		// Пауза целиком внутри окна: двое суток.
		await database.db.insert(stagePauses).values({
			stageEntryId: paused.entryId,
			reason: 'waiting_counterparty',
			note: 'Ждём подписи',
			startedAt: daysFrom(base, -8),
			endedAt: daysFrom(base, -6)
		});

		// Пауза началась до входа на стадию: считается только пересечение — сутки.
		await database.db.insert(stagePauses).values({
			stageEntryId: overlapping.entryId,
			reason: 'other',
			note: 'Началась раньше входа',
			startedAt: daysFrom(base, -12),
			endedAt: daysFrom(base, -9)
		});

		const plainStatus = await status(plain.entryId);
		const pausedStatus = await status(paused.entryId);
		const overlappingStatus = await status(overlapping.entryId);

		expect(plainStatus.pausedSeconds).toBe(0);
		expect(pausedStatus.pausedSeconds).toBe(2 * DAY_SECONDS);
		expect(overlappingStatus.pausedSeconds).toBe(DAY_SECONDS);

		const shift = pausedStatus.dueAt.getTime() - plainStatus.dueAt.getTime();
		expect(shift).toBe(2 * DAY_SECONDS * 1000);
		expect(plainStatus.dueAt.getTime()).toBe(enteredAt.getTime() + 5 * DAY_SECONDS * 1000);
	});

	it('останавливает закрытую запись на моменте выхода со стадии', async () => {
		const ownerUserId = await insertUser(database.db);
		const base = new Date();
		const enteredAt = daysFrom(base, -10);
		const leftAt = daysFrom(base, -4);

		const closed = await makeEntry(ownerUserId, { enteredAt, leftAt });

		// Пауза осталась открытой: у закрытой записи она обрезается по `left_at`.
		await database.db.insert(stagePauses).values({
			stageEntryId: closed.entryId,
			reason: 'waiting_internal',
			note: 'Забыли закрыть',
			startedAt: daysFrom(base, -5)
		});

		const closedStatus = await status(closed.entryId);

		expect(closedStatus.windowEnd.getTime()).toBe(leftAt.getTime());
		expect(closedStatus.pausedSeconds).toBe(DAY_SECONDS);
		expect(closedStatus.isPaused).toBe(false);
		// Срок: вход + 5 дней норматива + сутки паузы — и он не зависит от `now()`.
		expect(closedStatus.dueAt.getTime()).toBe(enteredAt.getTime() + 6 * DAY_SECONDS * 1000);
		expect(closedStatus.remainingSeconds).toBe(
			(closedStatus.dueAt.getTime() - leftAt.getTime()) / 1000
		);
		expect(closedStatus.activeSeconds).toBe(5 * DAY_SECONDS);
	});

	it('отмечает просрочку и не отмечает её раньше срока', async () => {
		const ownerUserId = await insertUser(database.db);
		const base = new Date();

		const overdue = await makeEntry(ownerUserId, { enteredAt: daysFrom(base, -10), slaDays: 5 });
		const onTime = await makeEntry(ownerUserId, { enteredAt: daysFrom(base, -1), slaDays: 5 });

		const overdueStatus = await status(overdue.entryId);
		const onTimeStatus = await status(onTime.entryId);

		expect(overdueStatus.isOverdue).toBe(true);
		expect(overdueStatus.remainingSeconds).toBeLessThan(0);
		expect(overdueStatus.overdueSeconds).toBeCloseTo(-overdueStatus.remainingSeconds, 6);

		expect(onTimeStatus.isOverdue).toBe(false);
		expect(onTimeStatus.remainingSeconds).toBeGreaterThan(0);
		expect(onTimeStatus.overdueSeconds).toBe(0);
	});

	it('открытая пауза держит запись на паузе, закрытая — нет', async () => {
		const ownerUserId = await insertUser(database.db);
		const base = new Date();
		const open = await makeEntry(ownerUserId, { enteredAt: daysFrom(base, -2) });

		const before = await status(open.entryId);
		expect(before.isPaused).toBe(false);

		const [pause] = await database.db
			.insert(stagePauses)
			.values({
				stageEntryId: open.entryId,
				reason: 'waiting_counterparty',
				note: 'Ждём',
				startedAt: daysFrom(base, -1)
			})
			.returning({ id: stagePauses.id });

		expect((await status(open.entryId)).isPaused).toBe(true);

		await database.db
			.update(stagePauses)
			.set({ endedAt: new Date() })
			.where(eq(stagePauses.id, pause.id));

		expect((await status(open.entryId)).isPaused).toBe(false);
	});
});
