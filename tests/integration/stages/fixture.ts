/**
 * Общая обвязка проверок процесса: завести процесс группы, поставить на него
 * взаимодействие и провести его по стадиям.
 *
 * Группы кладёт миграция, а стадии — набор данных, поэтому каждый прогон после
 * `reset()` заводит процесс заново. Вынесено сюда, потому что этим пользуются
 * все проверки движка: повторять двадцать строк подготовки в каждом файле
 * значит однажды получить четыре разных «демонстрационных процесса».
 */
import { eq } from 'drizzle-orm';
import type { DocumentStatusFact } from '$lib/contracts/documents';
import { lmsEvidenceSchema, type LmsEvidence } from '$lib/contracts/exchange';
import {
	createInteractionSchema,
	type ChecklistItem,
	type ProcessDefinitionInput,
	type ProcessRevisionView
} from '$lib/contracts/interactions';
import type { ActorContext } from '$lib/server/actor';
import {
	documents,
	interactions,
	learningGroupResults,
	learningGroups
} from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { markDocument } from '$lib/server/documents/status';
import { createInteraction } from '$lib/server/interactions/write';
import { B2B_WORKSPACE_KEY, B2B_PROCESS, B2C_WORKSPACE_KEY } from '$lib/server/stages/definitions';
import {
	advanceStage,
	applyLmsEvidence,
	confirmStage,
	setChecklistItem,
	setStageResult
} from '$lib/server/stages/commands';
import {
	ensureProcess,
	readActiveRevision,
	readWorkspaceByKey,
	readWorkspaceRow,
	requireActiveRevision
} from '$lib/server/stages/process';
import { getInteractionStatus } from '$lib/server/stages/status';
import { insertOrganization, TEST_USER_IDS, type TestDatabase } from '../helpers/db';

export { B2B_WORKSPACE_KEY, B2B_PROCESS, B2C_WORKSPACE_KEY };

/** Действующая редакция группы: тесты читают её, чтобы адресовать стадии. */
export async function activeRevision(
	database: TestDatabase,
	workspaceKey: string
): Promise<ProcessRevisionView> {
	const workspace = await readWorkspaceByKey(database.db, workspaceKey);

	return requireActiveRevision(database.db, workspace);
}

/** Есть ли у группы действующая редакция вообще. */
export async function hasProcess(database: TestDatabase, workspaceKey: string): Promise<boolean> {
	const workspace = await readWorkspaceByKey(database.db, workspaceKey);

	return (await readActiveRevision(database.db, workspace)) !== null;
}

/** Заводит процесс группы и возвращает его действующую редакцию. */
export async function seedProcess(
	database: TestDatabase,
	workspaceKey: string,
	definition: ProcessDefinitionInput
): Promise<ProcessRevisionView> {
	await database.db.transaction((tx) => ensureProcess(tx, workspaceKey, definition));

	return activeRevision(database, workspaceKey);
}

/** Стадия редакции по ключу: тесты адресуют стадии именами, а не номерами. */
export function stageId(revision: ProcessRevisionView, key: string): string {
	const stage = revision.stages.find((item) => item.key === key);

	if (stage === undefined) {
		throw new Error(`В редакции процесса нет стадии «${key}»`);
	}

	return stage.id;
}

/**
 * Взаимодействие на процессе своей группы. Группу задаёт вид организации,
 * а не параметр: ровно так же её выбирает форма и приём заявки.
 */
export async function createInteractionOn(
	ctx: ActorContext,
	database: TestDatabase,
	options: {
		title?: string;
		organizationId?: string;
		kind?: 'educational_institution' | 'legal_entity';
		ownerUserId?: string;
	} = {}
): Promise<{ interactionId: string; organizationId: string }> {
	const kind = options.kind ?? 'educational_institution';
	const organizationId =
		options.organizationId ??
		(await insertOrganization(database.db, {
			shortName: `Контрагент ${crypto.randomUUID().slice(0, 8)}`,
			kind
		}));

	const interaction = await createInteraction(
		ctx,
		createInteractionSchema.parse({
			title: options.title ?? 'Подготовка специалистов',
			ownerUserId: options.ownerUserId ?? TEST_USER_IDS.admin,
			parties: [
				{
					organizationId,
					partyRole: kind === 'educational_institution' ? 'educational_institution' : 'customer',
					isPrimary: true
				}
			]
		})
	);

	return { interactionId: interaction.id, organizationId };
}

/** Закрывает обязательные пункты чек-листа текущей стадии. */
export async function closeRequiredChecklist(
	ctx: ActorContext,
	interactionId: string
): Promise<void> {
	const status = await getInteractionStatus(ctx, interactionId);
	const current = status.current;

	if (current === null) {
		throw new Error('Взаимодействие не стоит ни на одной стадии');
	}

	for (const item of current.snapshot.checklist) {
		if (item.required) {
			await setChecklistItem(ctx, { interactionId, key: item.key, done: true });
		}
	}
}

/**
 * Факт системы обучения по взаимодействию: поток и его результат.
 *
 * Стадия с `requiresLmsData` ждёт именно его, и подделать его снимком стадии
 * нельзя — проверка перестала бы проверять правило. Строки те же, что кладёт
 * приём результата (`docs/exchange-contract.md`, направление 4), а
 * подтверждение ставит тот же движок, что зовёт приём: тест отличается от
 * настоящего обмена только тем, что сообщение не едет по сети.
 */
export async function provideLmsEvidence(
	ctx: ActorContext,
	database: TestDatabase,
	interactionId: string,
	counters: { enrolled: number; completed: number; expelled: number } = {
		enrolled: 20,
		completed: 18,
		expelled: 1
	}
): Promise<LmsEvidence> {
	const groupExternalId = crypto.randomUUID().slice(0, 8);
	const occurredAt = new Date();
	// Номер потока свой у каждого вызова: второй поток по взаимодействию —
	// обычное дело, и уникальность пары «взаимодействие + номер» этого ждёт.
	const streams = await database.db
		.select({ id: learningGroups.id })
		.from(learningGroups)
		.where(eq(learningGroups.interactionId, interactionId));

	const [workspace] = await database.db
		.insert(learningGroups)
		.values({
			interactionId,
			streamNumber: streams.length + 1,
			system: 'lms',
			instance: 'moodle-test',
			groupExternalId,
			plannedSeats: counters.enrolled,
			lastResultAt: occurredAt
		})
		.returning({ id: learningGroups.id });

	await database.db.insert(learningGroupResults).values({
		learningGroupId: workspace.id,
		occurredAt,
		...counters
	});

	const evidence = lmsEvidenceSchema.parse({
		system: 'lms',
		instance: 'moodle-test',
		groupExternalId,
		learningGroupId: workspace.id,
		occurredAt: occurredAt.toISOString(),
		...counters,
		finishedOn: null,
		periodStart: null,
		periodEnd: null
	});

	await withTransaction(ctx, (tx) => applyLmsEvidence(ctx, tx, { interactionId, evidence }));

	return evidence;
}

/**
 * Документ дела с нужной отметкой: факт, которым закрывается стадия с
 * `requiresDocumentMark`.
 *
 * Строка документа кладётся напрямую — хранилище файлов для этой проверки ни
 * при чём, а отметку ставит настоящий сервис (`markDocument`), и подтверждение
 * стадии ставит тот же движок, что зовётся из интерфейса. Подделать факт
 * снимком стадии нельзя: проверка перестала бы проверять правило.
 */
export async function provideDocumentMark(
	ctx: ActorContext,
	database: TestDatabase,
	interactionId: string,
	mark: DocumentStatusFact,
	title = 'Соглашение о сотрудничестве'
): Promise<string> {
	const [document] = await database.db
		.insert(documents)
		.values({
			interactionId,
			kind: 'agreement',
			title,
			filePath: `files/${crypto.randomUUID()}`,
			mime: 'text/plain',
			sizeBytes: 64,
			sha256: crypto.randomUUID().replaceAll('-', '').repeat(2)
		})
		.returning({ id: documents.id });

	await markDocument(ctx, document.id, mark);

	return document.id;
}

/**
 * Проводит взаимодействие вперёд до стадии с нужным ключом, закрывая по дороге
 * всё, чего стадия требует. Шаги идут по действующей редакции — той же, что
 * видит карточка.
 */
export async function advanceTo(
	ctx: ActorContext,
	database: TestDatabase,
	interactionId: string,
	key: string
): Promise<void> {
	const [row] = await database.db
		.select({ workspaceId: interactions.workspaceId })
		.from(interactions)
		.where(eq(interactions.id, interactionId));

	const revision = await requireActiveRevision(
		database.db,
		await readWorkspaceRow(database.db, row.workspaceId)
	);

	for (let step = 0; step < revision.stages.length + 1; step += 1) {
		const status = await getInteractionStatus(ctx, interactionId);
		const current = status.current;

		if (current === null || current.snapshot.key === key) {
			return;
		}

		await closeRequiredChecklist(ctx, interactionId);

		if (current.snapshot.requiresResult) {
			await setStageResult(ctx, {
				interactionId,
				resultText: `Результат стадии «${current.snapshot.name}»`
			});
		}

		if (current.snapshot.requiresDocumentMark !== null) {
			await provideDocumentMark(
				ctx,
				database,
				interactionId,
				current.snapshot.requiresDocumentMark
			);
		}

		if (current.snapshot.requiresLmsData) {
			// Факт обучения подтверждает стадию сам — видом `lms_record`, и
			// отметка ответственного поверх него стёрла бы то, чем стадия
			// подтверждена на самом деле.
			await provideLmsEvidence(ctx, database, interactionId);
		} else if (
			current.snapshot.requiresConfirmation &&
			current.snapshot.requiresDocumentMark === null
		) {
			await confirmStage(ctx, {
				interactionId,
				fromStageId: current.stageId,
				confirmation: { kind: 'mark' }
			});
		}

		const next = revision.transitions.find(
			(transition) => transition.fromStageId === current.stageId && transition.kind === 'forward'
		);

		if (next === undefined) {
			throw new Error(`Со стадии «${current.snapshot.key}» нет шага вперёд`);
		}

		await advanceStage(ctx, {
			interactionId,
			fromStageId: current.stageId,
			toStageId: next.toStageId,
			revision: status.revision,
			reason: null,
			resultText: null,
			checklistState: {}
		});
	}

	throw new Error(`Не удалось дойти до стадии «${key}»`);
}

/**
 * Процесс из трёх стадий: на средней можно стоять, её же можно удалить, и
 * первую есть чем закрыть. Минимум, на котором виден и переезд, и перепривязка.
 *
 * Чек-листы задаются параметром: правило переноса отметок проверяется тем, что
 * у стадий совпадают ключи пунктов, а подписи — нет.
 */
export function threeStageProcess(
	options: { checklist?: Partial<Record<'intake' | 'offer' | 'done', ChecklistItem[]>> } = {}
): ProcessDefinitionInput {
	return {
		name: 'Процесс из трёх стадий',
		note: null,
		migrationRules: [],
		stages: [
			{
				key: 'intake',
				name: 'Приём',
				category: 'contact',
				slaDays: 3,
				staleAfterDays: null,
				requiresResult: false,
				requiresConfirmation: false,
				requiresLmsData: false,
				requiresDocumentMark: null,
				isFinal: false,
				checklist: options.checklist?.intake ?? []
			},
			{
				key: 'offer',
				name: 'Предложение',
				category: 'documents',
				slaDays: 5,
				staleAfterDays: null,
				requiresResult: false,
				requiresConfirmation: false,
				requiresLmsData: false,
				requiresDocumentMark: null,
				isFinal: false,
				checklist: options.checklist?.offer ?? []
			},
			{
				key: 'done',
				name: 'Завершение',
				category: 'control',
				slaDays: 7,
				staleAfterDays: null,
				requiresResult: false,
				requiresConfirmation: false,
				requiresLmsData: false,
				requiresDocumentMark: null,
				isFinal: true,
				checklist: options.checklist?.done ?? []
			}
		],
		transitions: [
			{
				fromStageKey: 'intake',
				toStageKey: 'offer',
				kind: 'forward',
				requiredPermissionKey: 'stages.transition',
				requiresReason: false
			},
			{
				fromStageKey: 'offer',
				toStageKey: 'done',
				kind: 'forward',
				requiredPermissionKey: 'stages.transition',
				requiresReason: false
			}
		]
	};
}

/** Процесс из двух стадий: минимум, на котором проверяют одно правило. */
export function twoStageProcess(options: {
	name?: string;
	requiresReason?: boolean;
}): ProcessDefinitionInput {
	return {
		name: options.name ?? 'Процесс из двух стадий',
		note: null,
		migrationRules: [],
		stages: [
			{
				key: 'first',
				name: 'Первая стадия',
				category: 'contact',
				slaDays: 5,
				staleAfterDays: null,
				requiresResult: false,
				requiresConfirmation: false,
				requiresLmsData: false,
				requiresDocumentMark: null,
				isFinal: false,
				checklist: []
			},
			{
				key: 'second',
				name: 'Вторая стадия',
				category: 'control',
				slaDays: 5,
				staleAfterDays: null,
				requiresResult: false,
				requiresConfirmation: false,
				requiresLmsData: false,
				requiresDocumentMark: null,
				isFinal: true,
				checklist: []
			}
		],
		transitions: [
			{
				fromStageKey: 'first',
				toStageKey: 'second',
				kind: 'forward',
				requiredPermissionKey: 'stages.transition',
				requiresReason: options.requiresReason ?? false
			}
		]
	};
}
