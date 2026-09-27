/**
 * Новое направление со своим процессом — без кода и без набора данных:
 * администратор заводит пустой процесс, описывает его черновиком с первой
 * стадии, применяет — и в пространстве с этим процессом дело встаёт на первую
 * стадию. Копия процесса сразу получает стадии, переходы и состав карточки
 * образца.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractionSchema, type ProcessDefinitionInput } from '$lib/contracts/interactions';
import { ConflictError } from '$lib/server/errors';
import { createInteraction } from '$lib/server/interactions/write';
import { getProcessCard, updateProcessCard } from '$lib/server/stages/card';
import {
	assignWorkspaceWorkflow,
	createDraft,
	createWorkflow,
	createWorkspace,
	getWorkflow,
	linkInsertedStage,
	processDefinition,
	publishProcess,
	updateDraft
} from '$lib/server/stages/process';
import { getInteractionStatus } from '$lib/server/stages/status';
import {
	insertOrganization,
	ensureSchoolOperator,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
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
	// Заведение дела ставит школу стороной и без неё отказывает.
	await ensureSchoolOperator(database.db);
});

type StageInput = ProcessDefinitionInput['stages'][number];

function stage(key: string, name: string, isFinal = false): StageInput {
	return {
		key,
		name,
		category: isFinal ? 'control' : 'contact',
		slaDays: 5,
		staleAfterDays: null,
		requiresResult: false,
		requiresConfirmation: false,
		requiresLmsData: false,
		requiresDocumentMark: null,
		requiresDocumentTemplate: null,
		lmsGroupPurposes: null,
		onEnterNotify: null,
		isFinal,
		checklist: []
	};
}

/** Вставка стадии так, как её делает редактор: место в списке плюс шаги вперёд. */
function insert(
	definition: ProcessDefinitionInput,
	added: StageInput,
	place: number
): ProcessDefinitionInput {
	const stages = [...definition.stages];

	stages.splice(place, 0, added);

	return {
		...definition,
		stages,
		transitions: linkInsertedStage(stages, definition.transitions, added.key).transitions
	};
}

describe('новый процесс', () => {
	it('пустой процесс описывается черновиком с нуля, и после применения в нём заводится дело', async () => {
		const ctx = testActor({ roleId: 'admin' });

		await createWorkspace(ctx, {
			key: 'corp',
			name: 'Корпоративное обучение',
			description: null,
			workflowKey: null
		});
		await createWorkflow(ctx, {
			key: 'corp',
			name: 'Корпоративное обучение',
			description: null,
			copyFromKey: null
		});
		await assignWorkspaceWorkflow(ctx, { key: 'corp', workflowKey: 'corp' });

		const organizationId = await insertOrganization(database.db, {
			shortName: 'ООО «Заказчик»',
			kind: 'legal_entity'
		});
		const open = () =>
			createInteraction(
				ctx,
				'corp',
				createInteractionSchema.parse({
					title: 'Курс Python для сотрудников',
					ownerUserId: TEST_USER_IDS.admin,
					parties: [{ organizationId, partyRole: 'customer', isPrimary: true }]
				})
			);

		// Пока стадий нет, дело завести нельзя — и отказ говорит, где их описать.
		await expect(open()).rejects.toSatisfy(
			(error: unknown) => error instanceof ConflictError && /ещё нет стадий/.test(error.message)
		);

		// Черновик у процесса без действующей редакции заводится пустым.
		const draft = await createDraft(ctx, 'corp');
		expect(draft.stages).toEqual([]);

		let definition: ProcessDefinitionInput = {
			name: 'Корпоративное обучение',
			note: null,
			stages: [],
			transitions: [],
			migrationRules: []
		};

		// Первая стадия, потом следующие — по одной, как в редакторе.
		definition = insert(definition, stage('lead', 'Заявка принята'), 0);
		await updateDraft(ctx, 'corp', definition);
		definition = insert(definition, stage('contract', 'Договор и оплата'), 1);
		definition = insert(definition, stage('done', 'Обучение завершено', true), 2);

		// Вставка в середину встраивает стадию в цепочку сама.
		definition = insert(definition, stage('offer', 'Предложение'), 1);
		expect(
			definition.transitions.map((link) => `${link.fromStageKey}>${link.toStageKey}`).sort()
		).toEqual(['contract>done', 'lead>offer', 'offer>contract']);

		await updateDraft(ctx, 'corp', definition);
		expect((await getWorkflow(ctx, 'corp')).issues).toEqual([]);

		const published = await publishProcess(ctx, 'corp');
		expect(published.migratedCount).toBe(0);

		const interaction = await open();
		const status = await getInteractionStatus(ctx, interaction.id);
		expect(status.current?.snapshot.key).toBe('lead');

		// Копия берёт действующие стадии, переходы и состав карточки образца и
		// сразу действует — назначать её можно без черновика.
		await updateProcessCard(ctx, 'corp', { panels: ['terms', 'documents'], templates: [] });
		await createWorkflow(ctx, {
			key: 'corp-copy',
			name: 'Корпоративное обучение: регионы',
			description: null,
			copyFromKey: 'corp'
		});

		const copy = await getWorkflow(ctx, 'corp-copy');
		const original = await getWorkflow(ctx, 'corp');

		expect(copy.draft).toBeNull();
		expect(copy.active).not.toBeNull();
		const shape = (definition: ProcessDefinitionInput) => ({
			stages: definition.stages,
			transitions: definition.transitions
				.map((link) => `${link.fromStageKey}>${link.toStageKey}:${link.kind}`)
				.sort()
		});

		expect(shape(processDefinition(copy.active!))).toEqual(
			shape(processDefinition(original.active!))
		);
		expect(await getProcessCard(ctx, 'corp-copy')).toEqual({
			panels: ['terms', 'documents'],
			templates: []
		});
	});
});
