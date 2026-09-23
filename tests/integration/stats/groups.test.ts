// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	interactionPrograms,
	learningGroupResults,
	learningGroups,
	programs,
	statSnapshots
} from '$lib/server/db/schema';
import { getRedis } from '$lib/server/redis';
import { B2B_PROCESS, B2B_WORKSPACE_KEY } from '$lib/server/stages/definitions';
import { ensureWorkflow } from '$lib/server/stages/process';
import { buildGroupSnapshot } from '$lib/server/stats/groups';
import { confirmSnapshot } from '$lib/server/stats/import';
import { getRanking } from '$lib/server/stats/ranking';
import { listIndicators } from '$lib/server/stats/read';
import { createInteractionOn } from '../stages/fixture';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';

/**
 * Результат учебной группы доходит до статистики обучения и до рейтинга одними
 * и теми же числами, и ни один путь не считает людей дважды: у группы берётся
 * последний результат, а повторная сборка того же периода замещает прежнюю.
 */
let database: TestDatabase;

const PERIOD = { start: '2025-09-01', end: '2026-08-31' };
const SNAPSHOT_PERIOD = {
	periodKind: 'academic' as const,
	periodStart: PERIOD.start,
	periodEnd: PERIOD.end
};

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();

	await database.db.transaction(async (tx) => {
		await ensureWorkflow(tx, B2B_WORKSPACE_KEY, B2B_PROCESS);
	});
});

/** Взаимодействие с группой, у которой промежуточный и итоговый результат. */
async function groupWithResults(): Promise<{ programId: string; organizationId: string }> {
	const { interactionId, organizationId } = await createInteractionOn(testActor(), database);
	const [program] = await database.db
		.insert(programs)
		.values({
			code: 'P-STAT-01',
			name: 'Программа статистики',
			level: 'bachelor',
			status: 'active'
		})
		.returning({ id: programs.id });

	await database.db.insert(interactionPrograms).values({ interactionId, programId: program.id });

	const [group] = await database.db
		.insert(learningGroups)
		.values({
			interactionId,
			streamNumber: 1,
			system: 'lms',
			instance: 'moodle-itschool',
			groupExternalId: 'LMS-STAT-1',
			startsOn: '2025-10-01',
			endsOn: '2026-05-31',
			programId: program.id
		})
		.returning({ id: learningGroups.id });

	await database.db.insert(learningGroupResults).values([
		{
			learningGroupId: group.id,
			occurredAt: new Date('2026-02-01T09:00:00Z'),
			enrolled: 25,
			completed: 0,
			expelled: 1
		},
		{
			learningGroupId: group.id,
			occurredAt: new Date('2026-06-01T09:00:00Z'),
			finishedOn: '2026-05-31',
			enrolled: 25,
			completed: 20,
			expelled: 2
		}
	]);

	return { programId: program.id, organizationId };
}

describe('результаты учебных групп в статистике', () => {
	it('доходят до снимка и рейтинга одними числами, а повторная сборка их не удваивает', async () => {
		const admin = testActor();
		const { programId, organizationId } = await groupWithResults();

		const ranking = await getRanking(admin, PERIOD);
		const entry = ranking.programs.find((candidate) => candidate.id === programId);

		expect(entry?.facts).toStrictEqual({
			applications: 0,
			streams: 1,
			enrolled: 25,
			completed: 20
		});

		const first = await buildGroupSnapshot(admin, SNAPSHOT_PERIOD);

		expect(first.status).toBe('validated');
		await confirmSnapshot(admin, first.id);

		const second = await buildGroupSnapshot(admin, SNAPSHOT_PERIOD);
		const confirmed = await confirmSnapshot(admin, second.id);

		expect(confirmed.snapshot.supersedesSnapshotId).toBe(first.id);

		const [previous] = await database.db
			.select({ isCurrent: statSnapshots.isCurrent })
			.from(statSnapshots)
			.where(eq(statSnapshots.id, first.id));

		expect(previous.isCurrent).toBe(false);

		const indicators = await listIndicators(admin, {
			programId,
			organizationId,
			page: 1,
			pageSize: 10,
			period: PERIOD
		});

		expect(indicators.items).toHaveLength(1);
		expect(indicators.items[0]).toMatchObject({
			parallelStreams: entry?.facts.streams,
			enrolled: entry?.facts.enrolled,
			completed: entry?.facts.completed,
			snapshotCount: 1
		});
	});

	it('считает рейтинг только по взаимодействиям в области вызывающего', async () => {
		await groupWithResults();

		// Сотрудник без пространств не видит ни одного взаимодействия — и рейтинг
		// не должен выдавать ему чужую работу.
		const outsider = testActor({
			roleId: 'manager',
			scopeUserIds: [TEST_USER_IDS.manager],
			workspaceIds: []
		});

		expect((await getRanking(outsider, PERIOD)).programs).toStrictEqual([]);
	});
});
