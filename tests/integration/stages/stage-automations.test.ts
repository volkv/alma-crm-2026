// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessDefinitionInput } from '$lib/contracts/interactions';
import { systemActor } from '$lib/server/actor';
import { notificationDeliveries, users } from '$lib/server/db/schema';
import { ConflictError } from '$lib/server/errors';
import { closeLiveBus } from '$lib/server/live/bus';
import { STAGE_ENTER_SELF } from '$lib/server/notifications/stage-enter';
import { runNotificationCycle } from '$lib/server/notifications/watch';
import { getRedis } from '$lib/server/redis';
import { setSetting } from '$lib/server/settings';
import { advanceStage } from '$lib/server/stages/commands';
import {
	createDraft,
	processDefinition,
	publishProcess,
	updateDraft
} from '$lib/server/stages/process';
import { insertUser, startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import {
	activeRevision,
	B2C_WORKSPACE_KEY,
	createInteractionOn,
	openEntryId,
	seedProcess,
	stageId,
	threeStageProcess
} from './fixture';

/**
 * Уведомление при входе на стадию: одна строка на вход и канал, адресат —
 * руководитель ответственного, перенос публикацией уведомлений не даёт, а
 * автор перехода сам себя не уведомляет.
 *
 * Каналы — две заглушки: проверяется, кому и сколько раз система решила
 * сказать, а не почтовый сервер.
 */
let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await closeLiveBus();
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
	await setSetting(testActor(), 'notification_channels', {
		email: false,
		telegram: true,
		max: true
	});
});

/** Три стадии, у «Предложения» и «Завершения» — уведомление руководителю. */
function notifyingProcess(): ProcessDefinitionInput {
	const definition = threeStageProcess();

	return {
		...definition,
		stages: definition.stages.map((stage) =>
			stage.key === 'intake' ? stage : { ...stage, onEnterNotify: 'manager' as const }
		)
	};
}

async function stageEnteredRows() {
	return database.db
		.select()
		.from(notificationDeliveries)
		.where(eq(notificationDeliveries.kind, 'stage_entered'));
}

describe('уведомление при входе на стадию', () => {
	it('одно на вход и канал руководителю, без повторов от команды и публикации, без письма самому себе', async () => {
		const db = database.db;
		const lead = await insertUser(db, { roleId: 'lead', fullName: 'Руководитель' });
		const owner = await insertUser(db, { roleId: 'manager', fullName: 'Ведущий' });
		await db.update(users).set({ managerUserId: lead }).where(eq(users.id, owner));

		const ctx = testActor({ roleId: 'admin' });
		let revision = await seedProcess(database, B2C_WORKSPACE_KEY, notifyingProcess());

		const kept = await createInteractionOn(ctx, database, {
			kind: 'legal_entity',
			ownerUserId: owner
		});
		// Второе дело остаётся на «Приёме»: его перенесёт публикация.
		await createInteractionOn(ctx, database, {
			kind: 'legal_entity',
			ownerUserId: owner
		});

		// Первая стадия уведомления не настраивает: создание строк не даёт.
		expect(await stageEnteredRows()).toEqual([]);

		const command = {
			interactionId: kept.interactionId,
			fromStageId: stageId(revision, 'intake'),
			toStageId: stageId(revision, 'offer'),
			revision: revision.version,
			reason: null,
			resultText: null,
			checklistState: {}
		};

		await advanceStage(ctx, command);

		const entered = await stageEnteredRows();
		const offerEntry = await openEntryId(ctx, kept.interactionId);

		expect(entered.map((row) => row.channel).sort()).toEqual(['max', 'telegram']);
		for (const row of entered) {
			expect(row).toMatchObject({
				status: 'queued',
				recipientUserId: lead,
				stageEntryId: offerEntry,
				interactionId: kept.interactionId
			});
			expect(row.body).not.toContain('Ведущий');
		}

		// Повтор той же команды отказывает и строк не плодит.
		await expect(advanceStage(ctx, command)).rejects.toBeInstanceOf(ConflictError);
		expect(await stageEnteredRows()).toHaveLength(2);

		// Цикл разбирает очередь: адресат видит дело, заглушка отрабатывает.
		await runNotificationCycle(systemActor(randomUUID()));
		expect((await stageEnteredRows()).map((row) => row.status)).toEqual(['stub', 'stub']);

		// Публикация: «Предложение» сохранено по ключу (запись перепривязана),
		// «Приём» удалён с переносом на «Предложение» (запись переехала). Обе
		// стадии назначения уведомляют — и всё равно ни одной новой строки.
		const draft = processDefinition(await createDraft(ctx, B2C_WORKSPACE_KEY));
		await updateDraft(ctx, B2C_WORKSPACE_KEY, {
			...draft,
			stages: draft.stages.filter((stage) => stage.key !== 'intake'),
			transitions: draft.transitions.filter((transition) => transition.fromStageKey !== 'intake'),
			migrationRules: [{ removedStageKey: 'intake', targetStageKey: 'offer' }]
		});
		const publication = await publishProcess(ctx, B2C_WORKSPACE_KEY);

		expect(publication.reboundCount).toBe(1);
		expect(publication.migratedCount).toBe(1);
		expect(await stageEnteredRows()).toHaveLength(2);

		// Руководитель сам переводит дело на «Завершение»: адресат и автор
		// перехода — один человек, письма нет, строка с причиной есть.
		revision = await activeRevision(database, B2C_WORKSPACE_KEY);
		await advanceStage(testActor({ roleId: 'lead', userId: lead }), {
			interactionId: kept.interactionId,
			fromStageId: stageId(revision, 'offer'),
			toStageId: stageId(revision, 'done'),
			revision: revision.version,
			reason: null,
			resultText: null,
			checklistState: {}
		});

		const doneEntry = await openEntryId(ctx, kept.interactionId);
		const selfRows = await db
			.select()
			.from(notificationDeliveries)
			.where(
				and(
					eq(notificationDeliveries.kind, 'stage_entered'),
					eq(notificationDeliveries.stageEntryId, doneEntry)
				)
			);

		expect(selfRows).toHaveLength(2);
		for (const row of selfRows) {
			expect(row).toMatchObject({
				status: 'skipped',
				recipientUserId: lead,
				lastError: STAGE_ENTER_SELF,
				nextNotifyAt: null
			});
		}
	});
});
