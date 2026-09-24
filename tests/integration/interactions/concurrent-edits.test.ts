/**
 * Одновременная работа с одним делом: правки не перетирают друг друга молча.
 *
 * Два механизма, и оба проверяются здесь по отказу и по тому, что после
 * отказа ничего не записано.
 *
 * 1. **Запись стадии.** Команда по текущей стадии несёт запись, открытую у
 *    человека в форме; переход коллеги закрыл её — отказ, а новая стадия
 *    остаётся нетронутой.
 * 2. **Версия правки.** Форма плана и форма договора несут версию записи;
 *    чужая правка после неё — отказ со словами, чья правка и когда. Комментарий
 *    полей не переписывает и версию не сдвигает.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateInteractionSchema } from '$lib/contracts/interactions';
import { contracts, interactionChanges, products, users } from '$lib/server/db/schema';
import { getContract, saveContract, saveContractItem } from '$lib/server/directory/contracts';
import { ConflictError } from '$lib/server/errors';
import { getInteraction } from '$lib/server/interactions/read';
import { updateInteraction } from '$lib/server/interactions/write';
import { addComment, advanceStage, setStageResult } from '$lib/server/stages/commands';
import { getInteractionStatus } from '$lib/server/stages/status';
import {
	insertOrganization,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';
import {
	B2B_PROCESS,
	B2B_WORKSPACE_KEY,
	closeRequiredChecklist,
	createInteractionOn,
	openEntryId,
	seedProcess,
	stageId
} from '../stages/fixture';

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

const admin = () => testActor({ roleId: 'admin' });
/** Коллега: другой сотрудник, та же запись. */
const colleague = () => testActor({ roleId: 'manager', userId: TEST_USER_IDS.manager });

async function fullNameOf(userId: string): Promise<string> {
	const [row] = await database.db
		.select({ fullName: users.fullName })
		.from(users)
		.where(eq(users.id, userId));

	return row.fullName;
}

/** Отказ «запись изменил …» с автором этой версии. */
function staleBy(name: string) {
	return (error: unknown) =>
		error instanceof ConflictError &&
		new RegExp(
			`^Запись изменил ${name} в \\d\\d:\\d\\d — обновите карточку, ваш ввод сохранён$`
		).test(error.message);
}

describe('команды по стадии', () => {
	it('результат, набранный до перехода коллеги, не ложится в новую стадию', async () => {
		const ctx = admin();
		const revision = await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		const { interactionId } = await createInteractionOn(ctx, database);

		// Человек открыл диалог результата на первой стадии…
		const opened = await openEntryId(ctx, interactionId);

		// …а коллега тем временем перевёл дело дальше.
		await closeRequiredChecklist(colleague(), interactionId);
		await advanceStage(colleague(), {
			interactionId,
			revision: revision.version,
			fromStageId: stageId(revision, 'contact_search'),
			toStageId: stageId(revision, 'communication'),
			reason: null,
			resultText: null,
			checklistState: {}
		});

		await expect(
			setStageResult(ctx, {
				interactionId,
				stageEntryId: opened,
				resultText: 'Контакт найден, ждём ответа'
			})
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /^Стадия уже сменилась/.test(error.message)
		);

		const status = await getInteractionStatus(ctx, interactionId);

		expect(status.current?.snapshot.key).toBe('communication');
		expect(status.current?.resultText).toBeNull();
		expect(status.history.find((entry) => entry.id === opened)?.resultText).toBeNull();
	});
});

describe('версия правки', () => {
	it('вторая правка плана по той же версии получает отказ и ничего не пишет', async () => {
		const ctx = admin();
		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		const { interactionId, organizationId } = await createInteractionOn(ctx, database, {
			title: 'Подготовка специалистов'
		});

		// Оба открыли форму плана на одной версии.
		const { editVersion } = await getInteraction(ctx, interactionId);
		const plan = (title: string) =>
			updateInteractionSchema.parse({
				id: interactionId,
				editVersion,
				title,
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
			});

		// Обсуждение полей не переписывает: версия остаётся, план сохраняется.
		await addComment(colleague(), { interactionId, body: 'Сроки согласуем в пятницу' });
		expect((await getInteraction(ctx, interactionId)).editVersion).toBe(editVersion);

		await updateInteraction(colleague(), plan('Подготовка специалистов 2027'));

		await expect(updateInteraction(ctx, plan('Старое название с правкой'))).rejects.toSatisfy(
			staleBy(await fullNameOf(TEST_USER_IDS.manager))
		);

		const after = await getInteraction(ctx, interactionId);

		expect(after.title).toBe('Подготовка специалистов 2027');
		expect(after.editVersion).toBe(editVersion + 1);
		// В истории плана — одна правка, коллеги.
		expect(
			await database.db
				.select({ authorId: interactionChanges.authorId })
				.from(interactionChanges)
				.where(eq(interactionChanges.interactionId, interactionId))
		).toEqual([{ authorId: TEST_USER_IDS.manager }]);
	});

	it('правка договора после чужой правки его позиции получает отказ', async () => {
		const ctx = admin();
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз' });
		const [product] = await database.db
			.insert(products)
			.values({ code: 'RT-1', name: 'Продукт', status: 'active' })
			.returning({ id: products.id });

		const created = await saveContract(ctx, {
			id: null,
			organizationId,
			number: 'Д-1',
			signedOn: null,
			validUntil: null,
			status: 'draft',
			editVersion: null
		});

		// Коллега добавил позицию, пока открыта форма договора.
		await saveContractItem(colleague(), {
			id: null,
			contractId: created.id,
			productId: product.id,
			licenseSignedAt: null,
			licenseUntil: null,
			transferStatus: 'ожидает передачи',
			editVersion: created.editVersion
		});

		await expect(
			saveContract(ctx, {
				id: created.id,
				organizationId,
				number: 'Д-1/исправленный',
				signedOn: '2026-09-01',
				validUntil: null,
				status: 'active',
				editVersion: created.editVersion
			})
		).rejects.toSatisfy(staleBy(await fullNameOf(TEST_USER_IDS.manager)));

		const [row] = await database.db
			.select({ number: contracts.number, status: contracts.status })
			.from(contracts)
			.where(eq(contracts.id, created.id));

		expect(row).toEqual({ number: 'Д-1', status: 'draft' });
		expect((await getContract(ctx, created.id)).editVersion).toBe(created.editVersion + 1);
	});
});
