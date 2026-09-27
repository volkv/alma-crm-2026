/**
 * Пункты-факты чек-листа на настоящей базе: факт закрывают данные дела, а не
 * галочка; публикация переносит отметки только между совместимыми пунктами;
 * возврат не сбрасывает сделанное; штатное завершение спрашивает чек-лист.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChecklistItem } from '$lib/contracts/interactions';
import { stageEntries } from '$lib/server/db/schema';
import { ConflictError, ValidationError } from '$lib/server/errors';
import type { ActorContext } from '$lib/server/actor';
import {
	advanceStage,
	completeInteraction,
	returnStage,
	setChecklistItem
} from '$lib/server/stages/commands';
import {
	createDraft,
	processDefinition,
	publishProcess,
	updateDraft
} from '$lib/server/stages/process';
import { getInteractionStatus } from '$lib/server/stages/status';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import {
	advanceTo,
	B2B_PROCESS,
	B2B_WORKSPACE_KEY,
	B2C_WORKSPACE_KEY,
	createInteractionOn,
	openEntryId,
	provideRequiredFacts,
	seedProcess,
	stageId,
	threeStageProcess
} from './fixture';

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

const admin = (): ActorContext => testActor({ roleId: 'admin' });

const manual = (key: string, label: string): ChecklistItem => ({ key, label, required: true });

describe('пункт-факт', () => {
	it('не закрывается галочкой ни из карточки, ни командой перехода, и закрывается данными', async () => {
		const ctx = admin();
		const revision = await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		const { interactionId } = await createInteractionOn(ctx, database);
		const stageEntryId = await openEntryId(ctx, interactionId);

		await expect(
			setChecklistItem(ctx, { interactionId, stageEntryId, key: 'profile_unit_found', done: true })
		).rejects.toBeInstanceOf(ValidationError);

		await setChecklistItem(ctx, {
			interactionId,
			stageEntryId,
			key: 'contact_confirmed',
			done: true
		});

		const command = {
			interactionId,
			revision: revision.version,
			fromStageId: stageId(revision, 'contact_search'),
			toStageId: stageId(revision, 'communication'),
			reason: null,
			resultText: null
		};

		await expect(
			advanceStage(ctx, { ...command, checklistState: { profile_unit_found: true } })
		).rejects.toBeInstanceOf(ValidationError);
		await expect(advanceStage(ctx, { ...command, checklistState: {} })).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /закрывают данные дела/.test(error.message)
		);

		const before = (await getInteractionStatus(ctx, interactionId)).current;

		if (before === null) throw new Error('Дело не стоит на стадии');
		expect(before.facts.profile_unit_found).toEqual({ done: false, evidence: null });

		// Подразделение выбрано у стороны — пункт закрыт данными, без галочки.
		await provideRequiredFacts(ctx, database, interactionId, before);

		const after = await getInteractionStatus(ctx, interactionId);

		expect(after.current?.facts.profile_unit_found.done).toBe(true);
		expect(after.current?.checklistState.profile_unit_found).toBeUndefined();

		await advanceStage(ctx, { ...command, checklistState: {} });

		// При выходе результат проверки остаётся в записи и не пересчитывается.
		const passed = await getInteractionStatus(ctx, interactionId);

		expect(passed.history[0].facts.profile_unit_found).toEqual({ done: true, evidence: null });
	});

	it('возврат на стадию не сбрасывает отметки, сделанные на ней', async () => {
		const ctx = admin();
		const revision = await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		const { interactionId } = await createInteractionOn(ctx, database);

		await advanceTo(ctx, database, interactionId, 'communication');
		await returnStage(ctx, {
			interactionId,
			revision: revision.version,
			fromStageId: stageId(revision, 'communication'),
			toStageId: stageId(revision, 'contact_search'),
			reason: 'Контакт сменился'
		});

		const status = await getInteractionStatus(ctx, interactionId);

		expect(status.current?.snapshot.key).toBe('contact_search');
		expect(status.current?.checklistState).toEqual({ contact_confirmed: true });
		// Стадия, пройденная до возврата, снова впереди: «Дальше» — вторая, а не третья.
		expect(status.progress.find((stage) => stage.key === 'communication')?.state).toBe('pending');
	});
});

describe('публикация процесса', () => {
	it('переносит отметки только между пунктами, которые спрашивают о той же работе', async () => {
		const ctx = admin();

		await seedProcess(
			database,
			B2C_WORKSPACE_KEY,
			threeStageProcess({
				checklist: {
					offer: [
						manual('same', 'Условия отправлены'),
						manual('renamed', 'Счёт выставлен'),
						manual('to_fact', 'Итог записан')
					]
				}
			})
		);

		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });

		await advanceTo(ctx, database, interactionId, 'offer');

		const stageEntryId = await openEntryId(ctx, interactionId);

		for (const key of ['same', 'renamed', 'to_fact']) {
			await setChecklistItem(ctx, { interactionId, stageEntryId, key, done: true });
		}

		const draft = processDefinition(await createDraft(ctx, B2C_WORKSPACE_KEY));

		await updateDraft(ctx, B2C_WORKSPACE_KEY, {
			...draft,
			stages: draft.stages.map((stage) =>
				stage.key !== 'offer'
					? stage
					: {
							...stage,
							checklist: [
								manual('same', 'Условия отправлены'),
								manual('renamed', 'Счёт выставлен и оплачен'),
								{
									...manual('to_fact', 'Итог записан'),
									completion: { kind: 'fact', rule: 'stage_result' }
								}
							]
						}
			)
		});
		await publishProcess(ctx, B2C_WORKSPACE_KEY);

		const [entry] = await database.db
			.select({ checklistState: stageEntries.checklistState })
			.from(stageEntries)
			.where(eq(stageEntries.id, stageEntryId));

		expect(entry.checklistState).toEqual({ same: true });
	});
});

describe('завершение', () => {
	it('штатное завершение требует закрытый обязательный чек-лист финальной стадии', async () => {
		const ctx = admin();
		const revision = await seedProcess(
			database,
			B2C_WORKSPACE_KEY,
			threeStageProcess({ checklist: { done: [manual('report', 'Отчёт собран')] } })
		);
		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });

		await advanceTo(ctx, database, interactionId, 'done');

		const complete = () =>
			completeInteraction(ctx, {
				interactionId,
				revision: revision.version,
				summary: 'Работа закончена',
				force: false
			});

		await expect(complete()).rejects.toSatisfy(
			(error: unknown) => error instanceof ConflictError && /«Отчёт собран»/.test(error.message)
		);

		await setChecklistItem(ctx, {
			interactionId,
			stageEntryId: await openEntryId(ctx, interactionId),
			key: 'report',
			done: true
		});
		await complete();

		const status = await getInteractionStatus(ctx, interactionId);

		expect(status.current).toBeNull();
	});
});
