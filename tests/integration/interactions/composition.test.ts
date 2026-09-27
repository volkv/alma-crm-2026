/**
 * Состав дела: оператор ставится самим заведением, правка состава пишет
 * содержательную историю, а миграция дополняет оператором только идущие дела.
 */
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractionSchema, updateInteractionSchema } from '$lib/contracts/interactions';
import {
	auditEvents,
	interactionParties,
	interactions,
	programVersions,
	programs
} from '$lib/server/db/schema';
import { ConflictError } from '$lib/server/errors';
import { getInteraction, listInteractionChanges } from '$lib/server/interactions/read';
import { createInteraction, updateInteraction } from '$lib/server/interactions/write';
import { B2B_PROCESS, B2B_WORKSPACE_KEY } from '$lib/server/stages/definitions';
import { ensureWorkflow } from '$lib/server/stages/process';
import {
	ensureSchoolOperator,
	insertInteractionWithStage,
	insertOrganization,
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
	await database.db.transaction((tx) => ensureWorkflow(tx, B2B_WORKSPACE_KEY, B2B_PROCESS));
});

const admin = () => testActor({ roleId: 'admin' });

async function createFor(institutionId: string, extra: { organizationId: string }[] = []) {
	return createInteraction(
		admin(),
		B2B_WORKSPACE_KEY,
		createInteractionSchema.parse({
			title: 'Подготовка специалистов',
			ownerUserId: TEST_USER_IDS.admin,
			parties: [
				{ organizationId: institutionId, partyRole: 'educational_institution', isPrimary: true },
				...extra.map((party) => ({ ...party, partyRole: 'operator' as const }))
			]
		})
	);
}

describe('оператор при заведении', () => {
	it('ставит школу стороной, если её не передали, и не дублирует переданную', async () => {
		const schoolId = await ensureSchoolOperator(database.db, 'ИТ Школа');
		const institutionId = await insertOrganization(database.db, { shortName: 'МАИ' });

		const implicit = await createFor(institutionId);
		const explicit = await createFor(await insertOrganization(database.db), [
			{ organizationId: schoolId }
		]);

		for (const view of [implicit, explicit]) {
			const operators = view.parties.filter((party) => party.partyRole === 'operator');

			expect(operators).toHaveLength(1);
			expect(operators[0].organizationId).toBe(schoolId);
			expect(operators[0].isPrimary).toBe(false);
		}
	});

	it('отказывает словами, когда школа в справочнике не указана или неоднозначна', async () => {
		const institutionId = await insertOrganization(database.db);

		await expect(createFor(institutionId)).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /не указана организация школы/.test(error.message)
		);

		await insertOrganization(database.db, { shortName: 'Школа А', kind: 'operator' });
		await insertOrganization(database.db, { shortName: 'Школа Б', kind: 'operator' });

		await expect(createFor(institutionId)).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /несколько организаций школы/.test(error.message)
		);
	});
});

describe('правка состава', () => {
	it('пишет в историю смену роли стороны и версии программы', async () => {
		const ctx = admin();
		const schoolId = await ensureSchoolOperator(database.db, 'ИТ Школа');
		const institutionId = await insertOrganization(database.db, { shortName: 'МАИ' });
		const partnerId = await insertOrganization(database.db, {
			shortName: 'Партнёр',
			kind: 'customer_company'
		});
		const [program] = await database.db
			.insert(programs)
			.values({ code: '09.03.01', name: 'Информатика', level: 'bachelor', status: 'active' })
			.returning({ id: programs.id });
		const [version] = await database.db
			.insert(programVersions)
			.values({
				programId: program.id,
				version: 2,
				summary: 'Новая редакция',
				effectiveFrom: '2026-09-01'
			})
			.returning({ id: programVersions.id });

		const created = await createInteraction(
			ctx,
			B2B_WORKSPACE_KEY,
			createInteractionSchema.parse({
				title: 'Состав меняется',
				ownerUserId: TEST_USER_IDS.admin,
				parties: [
					{ organizationId: institutionId, partyRole: 'educational_institution', isPrimary: true },
					{ organizationId: partnerId, partyRole: 'customer' }
				],
				programs: [{ programId: program.id }]
			})
		);

		// Тот же набор организаций и та же программа — сравнение по одним
		// идентификаторам сочло бы такую правку пустой.
		await updateInteraction(
			ctx,
			updateInteractionSchema.parse({
				id: created.id,
				editVersion: created.editVersion,
				title: created.title,
				ownerUserId: created.ownerUserId,
				reason: 'Партнёр стал оператором площадки, перешли на новую редакцию',
				parties: [
					{ organizationId: institutionId, partyRole: 'educational_institution', isPrimary: true },
					{ organizationId: partnerId, partyRole: 'educational_institution' },
					{ organizationId: schoolId, partyRole: 'operator' }
				],
				programs: [{ programId: program.id, programVersionId: version.id }]
			})
		);

		const byField = new Map(
			(await listInteractionChanges(ctx, created.id)).map((change) => [change.field, change])
		);

		expect(byField.get('parties')?.oldLabel).toContain('Партнёр (компания-заказчик)');
		expect(byField.get('parties')?.newLabel).toContain('Партнёр (учебное заведение)');
		expect(byField.get('programs')?.oldLabel).toBe('Информатика');
		expect(byField.get('programs')?.newLabel).toBe('Информатика (версия 2)');
		expect((await getInteraction(ctx, created.id)).programs[0].programVersionId).toBe(version.id);
	});
});

describe('миграция 0039: оператор у идущих дел', () => {
	/** Та же миграция, что применяет `drizzle-kit`, — по её собственным разделителям. */
	async function runBackfill(): Promise<void> {
		const text = readFileSync('drizzle/0039_operator_party_backfill.sql', 'utf8');

		await database.raw.begin(async (sql) => {
			for (const statement of text.split('--> statement-breakpoint')) {
				await sql.unsafe(statement);
			}
		});
	}

	async function operatorsOf(interactionId: string) {
		return database.db
			.select({ organizationId: interactionParties.organizationId })
			.from(interactionParties)
			.where(
				and(
					eq(interactionParties.interactionId, interactionId),
					eq(interactionParties.partyRole, 'operator')
				)
			);
	}

	it('добавляет школу только незавершённым делам без оператора, со следом в журнале', async () => {
		const active = await insertInteractionWithStage(database.db, {
			ownerUserId: TEST_USER_IDS.admin
		});
		const completed = await insertInteractionWithStage(database.db, {
			ownerUserId: TEST_USER_IDS.admin
		});

		await database.db
			.update(interactions)
			.set({ status: 'completed' })
			.where(eq(interactions.id, completed.interactionId));

		// Школы в справочнике нет — выбирать не из чего, и миграция ничего не трогает.
		await runBackfill();
		expect(await operatorsOf(active.interactionId)).toHaveLength(0);

		const schoolId = await ensureSchoolOperator(database.db, 'ИТ Школа');
		const [before] = await database.db
			.select({ editVersion: interactions.editVersion })
			.from(interactions)
			.where(eq(interactions.id, active.interactionId));

		await runBackfill();

		expect(await operatorsOf(active.interactionId)).toEqual([{ organizationId: schoolId }]);
		expect(await operatorsOf(completed.interactionId)).toHaveLength(0);

		const [after] = await database.db
			.select({ editVersion: interactions.editVersion, editedVia: interactions.editedVia })
			.from(interactions)
			.where(eq(interactions.id, active.interactionId));

		expect(after).toEqual({ editVersion: before.editVersion + 1, editedVia: 'system' });

		const journal = await database.db
			.select({ eventType: auditEvents.eventType, source: auditEvents.source })
			.from(auditEvents)
			.where(eq(auditEvents.subjectId, active.interactionId));

		expect(journal).toContainEqual({ eventType: 'interactions.updated', source: 'system' });

		// Повтор ничего не добавляет: оператор уже стоит.
		await runBackfill();
		expect(await operatorsOf(active.interactionId)).toHaveLength(1);
	});
});
