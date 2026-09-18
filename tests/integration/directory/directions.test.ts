/**
 * Справочник ИТ-направлений на настоящей базе.
 *
 * Направление — разрез, по которому назначают ответственных за вуз и собирают
 * отчёт, поэтому здесь проверяются правила, а не запросы: позицию назначает
 * сервис, код уникален, записи не удаляются, архивное направление перестаёт
 * предлагаться формам и не принимается назначением, а состав продуктов и
 * программ считается без перемножения соединений.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { directionDirectoryQuerySchema } from '$lib/contracts/directory';
import { auditEvents, programs } from '$lib/server/db/schema';
import { getDirection, listDirectionRows } from '$lib/server/directory/read';
import { assignResponsible, listDirectionOptions } from '$lib/server/directory/responsibles';
import {
	archiveDirection,
	createDirection,
	createProduct,
	createProgram,
	linkProductDirection,
	restoreDirection,
	unlinkProductDirection,
	updateDirection
} from '$lib/server/directory/write';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '$lib/server/errors';
import {
	insertOrganization,
	insertUser,
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
	await database.stop();
});

beforeEach(async () => {
	await database.reset();
});

const firstPage = directionDirectoryQuerySchema.parse({});

/** Роль без права на запись справочника: у менеджера `directions.write` нет. */
function manager() {
	return testActor({ roleId: 'manager' });
}

describe('заведение и правка', () => {
	it('ставит новое направление в конец списка и не пускает второй код', async () => {
		const ctx = testActor();

		const first = await createDirection(ctx, { code: 'OPS', name: 'DevOps' });
		const second = await createDirection(ctx, { code: 'QA', name: 'Тестирование' });

		expect(first.position).toBe(1);
		expect(second.position).toBe(2);
		expect(first.isActive).toBe(true);

		await expect(createDirection(ctx, { code: 'OPS', name: 'Другое' })).rejects.toBeInstanceOf(
			ConflictError
		);
	});

	it('пишет в журнал имена изменённых полей, а не значения', async () => {
		const ctx = testActor();
		const direction = await createDirection(ctx, { code: 'OPS', name: 'DevOps' });

		const updated = await updateDirection(ctx, {
			id: direction.id,
			code: 'OPS',
			name: 'DevOps и эксплуатация'
		});

		expect(updated.name).toBe('DevOps и эксплуатация');
		// Позицию правка не трогает: её назначает заведение.
		expect(updated.position).toBe(direction.position);

		const events = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(
				and(eq(auditEvents.eventType, 'directions.updated'), eq(auditEvents.outcome, 'success'))
			);

		expect(events).toEqual([{ details: { changedFields: ['name'] } }]);
	});

	it('отвечает «не найдено» на чужой идентификатор', async () => {
		await expect(
			updateDirection(testActor(), {
				id: '11111111-2222-4333-8444-555555555555',
				code: 'OPS',
				name: 'DevOps'
			})
		).rejects.toBeInstanceOf(NotFoundError);
	});
});

describe('право на запись', () => {
	it('отказывает роли без `directions.write` и пишет отказ в журнал', async () => {
		const admin = testActor();
		const direction = await createDirection(admin, { code: 'OPS', name: 'DevOps' });
		const product = await createProduct(admin, {
			code: 'PRD-1',
			name: 'Продукт',
			vendorOrganizationId: null,
			description: null,
			status: 'active',
			externalSource: null,
			externalId: null
		});

		const ctx = manager();

		await expect(createDirection(ctx, { code: 'QA', name: 'Тестирование' })).rejects.toBeInstanceOf(
			ForbiddenError
		);
		await expect(
			updateDirection(ctx, { id: direction.id, code: 'OPS', name: 'Другое' })
		).rejects.toBeInstanceOf(ForbiddenError);
		await expect(archiveDirection(ctx, direction.id)).rejects.toBeInstanceOf(ForbiddenError);
		await expect(
			linkProductDirection(ctx, { directionId: direction.id, productId: product.id })
		).rejects.toBeInstanceOf(ForbiddenError);

		// Отказ по правам — событие журнала, а не молчание: администратор должен
		// узнать, что справочник пытались изменить.
		const denied = await database.db
			.select({ type: auditEvents.eventType })
			.from(auditEvents)
			.where(eq(auditEvents.outcome, 'denied'));

		expect(denied.length).toBe(4);
		expect(denied.every((row) => row.type.startsWith('directions.'))).toBe(true);
	});

	it('читать направления может и роль без права на запись', async () => {
		await createDirection(testActor(), { code: 'OPS', name: 'DevOps' });

		expect((await listDirectionRows(manager(), firstPage)).total).toBe(1);
	});
});

describe('архив', () => {
	it('убирает направление из подбора формы, но оставляет в списке', async () => {
		const ctx = testActor();
		const direction = await createDirection(ctx, { code: 'OPS', name: 'DevOps' });

		expect(await listDirectionOptions(ctx)).toEqual([{ id: direction.id, name: 'DevOps' }]);

		const archived = await archiveDirection(ctx, direction.id);

		expect(archived.isActive).toBe(false);
		expect(await listDirectionOptions(ctx)).toEqual([]);

		const rows = await listDirectionRows(ctx, firstPage);
		expect(rows.total).toBe(1);
		expect(rows.items[0]?.direction.isActive).toBe(false);

		// Повторный архив — конфликт, а не молчаливый успех.
		await expect(archiveDirection(ctx, direction.id)).rejects.toBeInstanceOf(ConflictError);

		const restored = await restoreDirection(ctx, direction.id);
		expect(restored.isActive).toBe(true);
		await expect(restoreDirection(ctx, direction.id)).rejects.toBeInstanceOf(ConflictError);

		// Возврат — правка с одним изменённым полем: по нему отвечают на вопрос
		// «когда вернули», отдельного кода события на это не заводят.
		const updates = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(
				and(eq(auditEvents.eventType, 'directions.updated'), eq(auditEvents.outcome, 'success'))
			);

		expect(updates).toEqual([{ details: { changedFields: ['isActive'] } }]);
	});

	it('не принимается назначением ответственного', async () => {
		const ctx = testActor();
		const direction = await createDirection(ctx, { code: 'OPS', name: 'DevOps' });
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const userId = await insertUser(database.db, { roleId: 'manager' });

		await archiveDirection(ctx, direction.id);

		// Спрятать направление из подсказки мало: идентификатор набирают руками.
		await expect(
			assignResponsible(ctx, {
				organizationId,
				userId,
				directionId: direction.id,
				transferInteractions: false
			})
		).rejects.toBeInstanceOf(ValidationError);
	});

	it('не принимает новых продуктов, пока лежит в архиве', async () => {
		const ctx = testActor();
		const direction = await createDirection(ctx, { code: 'OPS', name: 'DevOps' });
		const product = await createProduct(ctx, {
			code: 'PRD-1',
			name: 'Продукт',
			vendorOrganizationId: null,
			description: null,
			status: 'active',
			externalSource: null,
			externalId: null
		});

		await archiveDirection(ctx, direction.id);

		await expect(
			linkProductDirection(ctx, { directionId: direction.id, productId: product.id })
		).rejects.toBeInstanceOf(ConflictError);
	});
});

describe('связи направления', () => {
	it('привязывает продукт, снимает связь и отвергает повтор', async () => {
		const ctx = testActor();
		const direction = await createDirection(ctx, { code: 'OPS', name: 'DevOps' });
		const product = await createProduct(ctx, {
			code: 'PRD-1',
			name: 'Базис',
			vendorOrganizationId: null,
			description: null,
			status: 'active',
			externalSource: null,
			externalId: null
		});

		await linkProductDirection(ctx, { directionId: direction.id, productId: product.id });

		expect((await getDirection(ctx, direction.id)).products).toEqual([
			{ id: product.id, label: 'PRD-1 — Базис' }
		]);

		// Повторная связь — конфликт: её ловит первичный ключ пары, а не проверка.
		await expect(
			linkProductDirection(ctx, { directionId: direction.id, productId: product.id })
		).rejects.toBeInstanceOf(ConflictError);

		await unlinkProductDirection(ctx, { directionId: direction.id, productId: product.id });

		expect((await getDirection(ctx, direction.id)).products).toEqual([]);

		// Снимать нечего — это «не найдено», а не молчаливый успех.
		await expect(
			unlinkProductDirection(ctx, { directionId: direction.id, productId: product.id })
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it('не привязывает продукт, которого нет в справочнике', async () => {
		const ctx = testActor();
		const direction = await createDirection(ctx, { code: 'OPS', name: 'DevOps' });

		await expect(
			linkProductDirection(ctx, {
				directionId: direction.id,
				productId: '11111111-2222-4333-8444-555555555555'
			})
		).rejects.toBeInstanceOf(ValidationError);
	});

	it('считает продукты и программы направления, не перемножая их', async () => {
		const ctx = testActor();
		const direction = await createDirection(ctx, { code: 'OPS', name: 'DevOps' });

		for (const code of ['PRD-1', 'PRD-2']) {
			const product = await createProduct(ctx, {
				code,
				name: `Продукт ${code}`,
				vendorOrganizationId: null,
				description: null,
				status: 'active',
				externalSource: null,
				externalId: null
			});

			await linkProductDirection(ctx, { directionId: direction.id, productId: product.id });
		}

		for (const code of ['PRG-1', 'PRG-2', 'PRG-3']) {
			const program = await createProgram(ctx, {
				code,
				name: `Программа ${code}`,
				level: 'bachelor',
				directionCode: null,
				priority: null,
				status: 'active',
				externalSource: null,
				externalId: null
			});

			// Направление программы форма пока не задаёт: связь живёт в колонке
			// `programs.direction_id`, и карточка направления её читает.
			await database.db
				.update(programs)
				.set({ directionId: direction.id })
				.where(eq(programs.id, program.id));
		}

		const rows = await listDirectionRows(ctx, firstPage);

		// Два соединения в одном запросе: без `countDistinct` здесь стояло бы
		// шесть и там и там.
		expect(rows.items[0]?.productCount).toBe(2);
		expect(rows.items[0]?.programCount).toBe(3);

		const detail = await getDirection(ctx, direction.id);
		expect(detail.products).toHaveLength(2);
		expect(detail.programs).toHaveLength(3);
	});
});

describe('список', () => {
	it('отбирает по состоянию и ищет по коду и названию', async () => {
		const ctx = testActor();
		const devops = await createDirection(ctx, { code: 'OPS', name: 'DevOps' });
		await createDirection(ctx, { code: 'QA', name: 'Тестирование' });
		await archiveDirection(ctx, devops.id);

		const active = await listDirectionRows(
			ctx,
			directionDirectoryQuerySchema.parse({ state: 'active' })
		);
		expect(active.items.map((row) => row.direction.code)).toEqual(['QA']);

		const archived = await listDirectionRows(
			ctx,
			directionDirectoryQuerySchema.parse({ state: 'archived' })
		);
		expect(archived.items.map((row) => row.direction.code)).toEqual(['OPS']);

		const found = await listDirectionRows(
			ctx,
			directionDirectoryQuerySchema.parse({ q: 'тестиров' })
		);
		expect(found.items.map((row) => row.direction.code)).toEqual(['QA']);
	});
});
