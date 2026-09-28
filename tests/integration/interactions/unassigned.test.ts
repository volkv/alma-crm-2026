/**
 * Дело без ответственного: заводится без него, видно автору и руководителю
 * пространства, не видно чужому менеджеру, а первая стадия напоминает о
 * назначении необязательным пунктом-фактом.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractionSchema, interactionListQuerySchema } from '$lib/contracts/interactions';
import type { ActorContext } from '$lib/server/actor';
import { NotFoundError } from '$lib/server/errors';
import { getInteraction, listInteractions } from '$lib/server/interactions/read';
import { createInteraction } from '$lib/server/interactions/write';
import { setResponsible } from '$lib/server/stages/commands';
import { B2B_PROCESS, B2B_WORKSPACE_KEY } from '$lib/server/stages/definitions';
import { ensureWorkflow } from '$lib/server/stages/process';
import { getInteractionStatus } from '$lib/server/stages/status';
import {
	allWorkspaceIds,
	ensureSchoolOperator,
	insertOrganization,
	insertUser,
	scopedActor,
	startTestDatabase,
	testActor,
	type TestDatabase
} from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

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

const everything = interactionListQuerySchema.parse({});

async function visibleIds(ctx: ActorContext): Promise<string[]> {
	return (await listInteractions(ctx, everything)).items.map((item) => item.id);
}

describe('дело без ответственного', () => {
	it('видят автор и руководитель, чужой менеджер — нет', async () => {
		await ensureSchoolOperator(database.db);
		await database.db.transaction((tx) => ensureWorkflow(tx, B2B_WORKSPACE_KEY, B2B_PROCESS));

		const institutionId = await insertOrganization(database.db, {
			shortName: 'Вуз без исполнителя'
		});
		const authorId = await insertUser(database.db, { roleId: 'manager' });
		const author = await scopedActor(database.db, {
			userId: authorId,
			organizationIds: [institutionId]
		});

		const created = await createInteraction(
			author,
			B2B_WORKSPACE_KEY,
			createInteractionSchema.parse({
				title: 'Запрос без исполнителя',
				parties: [
					{ organizationId: institutionId, partyRole: 'educational_institution', isPrimary: true }
				]
			})
		);

		expect(created.ownerUserId).toBeNull();
		expect(created.ownerName).toBeNull();

		// Вуз уходит другому: автор больше не видит дело по стороне — только как автор.
		const partyOwnerId = await insertUser(database.db, { roleId: 'manager' });
		const partyOwner = await scopedActor(database.db, {
			userId: partyOwnerId,
			organizationIds: [institutionId]
		});
		const stranger = await scopedActor(database.db, { organizationIds: [] });
		const leadId = await insertUser(database.db, { roleId: 'lead' });
		const lead = testActor({
			roleId: 'lead',
			userId: leadId,
			scopeUserIds: [leadId],
			workspaceIds: await allWorkspaceIds(database.db)
		});

		expect(await visibleIds(author)).toEqual([created.id]);
		expect(await visibleIds(lead)).toEqual([created.id]);
		expect(await visibleIds(partyOwner)).toEqual([created.id]);
		expect(await visibleIds(stranger)).toEqual([]);
		await expect(getInteraction(stranger, created.id)).rejects.toBeInstanceOf(NotFoundError);

		// Первая стадия напоминает о назначении, но переход не держит.
		const before = await getInteractionStatus(author, created.id);
		const item = before.current?.snapshot.checklist.find(
			(point) =>
				point.completion?.kind === 'fact' && point.completion.rule === 'responsible_assigned'
		);

		expect(item).toMatchObject({ required: false, action: 'assign' });
		expect(before.current?.facts[item?.key ?? '']).toMatchObject({ done: false });

		// Руководитель раздаёт дело: пункт закрывается, а дело уходит из виду у
		// автора и у руководителя — новый ответственный не из его подчинённых.
		await setResponsible(lead, { interactionIds: [created.id], userId: partyOwnerId });

		const after = await getInteractionStatus(partyOwner, created.id);

		expect(after.current?.facts[item?.key ?? '']).toMatchObject({ done: true });
		expect(await visibleIds(author)).toEqual([]);
		expect(await visibleIds(lead)).toEqual([]);
	});
});
