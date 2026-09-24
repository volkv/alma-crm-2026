/**
 * Чем стадия подтверждается: документ нужного шаблона и группа нужного
 * назначения.
 *
 * Отметку, поставленную до входа на стадию, движок засчитывает, а итог по
 * любому потоку взаимодействия — тоже. Без сужения стадию передачи материалов
 * закрыло бы соглашение, утверждённое ещё на подписании, а «Ведение занятий» —
 * итог потока преподавателей.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '$lib/server/actor';
import { getInteractionStatus } from '$lib/server/stages/status';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import {
	advanceTo,
	B2B_PROCESS,
	B2B_WORKSPACE_KEY,
	createInteractionOn,
	provideDocumentMark,
	provideLmsEvidence,
	seedProcess
} from './fixture';

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

async function createFixture(): Promise<{ ctx: ActorContext; interactionId: string }> {
	const ctx = testActor({ roleId: 'admin' });
	await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
	const { interactionId } = await createInteractionOn(ctx, database);

	return { ctx, interactionId };
}

describe('подтверждение стадии', () => {
	it('передачу материалов закрывает утверждённый акт передачи, а не соглашение', async () => {
		const { ctx, interactionId } = await createFixture();
		// По дороге подписание закрывает утверждённое соглашение.
		await advanceTo(ctx, database, interactionId, 'materials_handover');

		const entered = await getInteractionStatus(ctx, interactionId);

		expect(entered.current?.snapshot.key).toBe('materials_handover');
		expect(entered.current?.documentMarkEvidence).toBeNull();
		expect(entered.current?.confirmation).toBeNull();

		// Ещё одно утверждённое соглашение — не акт.
		await provideDocumentMark(ctx, database, interactionId, 'approved');

		const afterAgreement = await getInteractionStatus(ctx, interactionId);

		expect(afterAgreement.current?.confirmation).toBeNull();

		const actId = await provideDocumentMark(ctx, database, interactionId, 'approved', {
			templateKey: 'handover_act'
		});

		const afterAct = await getInteractionStatus(ctx, interactionId);

		expect(afterAct.current?.documentMarkEvidence).toMatchObject({
			documentId: actId,
			mark: 'approved'
		});
		expect(afterAct.current?.confirmation).toMatchObject({
			kind: 'document_mark',
			documentId: actId
		});
	});

	it('«Ведение занятий» подтверждает итог потока студентов, а не преподавателей', async () => {
		const { ctx, interactionId } = await createFixture();
		await advanceTo(ctx, database, interactionId, 'classes');

		await provideLmsEvidence(ctx, database, interactionId, undefined, 'teachers');

		const afterTeachers = await getInteractionStatus(ctx, interactionId);

		expect(afterTeachers.current?.snapshot.key).toBe('classes');
		expect(afterTeachers.current?.lmsEvidence).toBeNull();
		expect(afterTeachers.current?.confirmation).toBeNull();

		const students = await provideLmsEvidence(ctx, database, interactionId, undefined, 'students');

		const afterStudents = await getInteractionStatus(ctx, interactionId);

		expect(afterStudents.current?.lmsEvidence).toMatchObject({
			learningGroupId: students.learningGroupId
		});
		expect(afterStudents.current?.confirmation).toMatchObject({ kind: 'lms_record' });
	});
});
