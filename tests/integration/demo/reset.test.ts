import { and, count, eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '$lib/server/actor';
import {
	auditEvents,
	interactions,
	organizations,
	users,
	workflows,
	workspaces
} from '$lib/server/db/schema';
import { ForbiddenError } from '$lib/server/errors';
import { getRedis } from '$lib/server/redis';
import { DIRECTORY_SEED_SIZES } from '../../../scripts/seed/directory';
import { seedId } from '../../../scripts/seed/ids';
import { INTERACTION_SEED_SIZES } from '../../../scripts/seed/interactions';
import { seedAll } from '../../../scripts/seed/run';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * `DEMO_MODE` разбирается один раз за процесс, поэтому подменяется сама
 * функция конфигурации, а не переменная окружения.
 */
vi.mock('$lib/server/config', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/config')>();

	return { ...actual, getConfig: () => ({ ...actual.getConfig(), DEMO_MODE: true }) };
});

const { resetDemoData } = await import('$lib/server/demo/reset');
const { deactivateUser } = await import('$lib/server/auth/users');
const { getSetting, setSetting } = await import('$lib/server/settings');

let database: TestDatabase;

async function countRows(table: PgTable): Promise<number> {
	const [row] = await database.db.select({ value: count() }).from(table);

	return row.value;
}

beforeAll(async () => {
	database = await startTestDatabase();
	await database.reset();
	await seedAll();
}, 300_000);

afterAll(async () => {
	await getRedis().quit();
	await database?.stop();
});

describe('сброс демонстрационных данных', () => {
	it('стирает след показа и возвращает стенд к эталону сида', async () => {
		await database.db
			.update(organizations)
			.set({ shortName: 'Переименовано на показе' })
			.where(eq(organizations.kind, 'educational_institution'));
		await database.db.delete(interactions);

		const result = await resetDemoData(testActor());

		expect(result.interactionCount).toBe(INTERACTION_SEED_SIZES.interactions);
		expect(result.organizationCount).toBe(DIRECTORY_SEED_SIZES.organizations);
		await expect(countRows(interactions)).resolves.toBe(INTERACTION_SEED_SIZES.interactions);

		const [renamed] = await database.db
			.select({ value: count() })
			.from(organizations)
			.where(eq(organizations.shortName, 'Переименовано на показе'));

		expect(renamed.value).toBe(0);
	}, 120_000);

	it('возвращает то, что правит показ, и держит границу демонстрации', async () => {
		const staff = testActor();
		const base = testActor();
		const visitor: ActorContext = { ...base, user: { ...base.user!, isDemo: true } };
		const staffAdminId = seedId('user', 'staff-admin');

		// Штатный администратор включил расписание — его сброс обязан сохранить.
		await setSetting(staff, 'demo_reset_schedule', { enabled: true, hour: 4 });

		// Посетитель правит то, что ему открыто.
		await setSetting(visitor, 'stuck_threshold_days', 0);
		await setSetting(visitor, 'enrichment', { enabled: false, dailyQuota: 5 });
		await database.db
			.update(workflows)
			.set({ cardPanels: ['documents'], documentTemplateKeys: [] })
			.where(eq(workflows.key, 'b2b'));
		await database.db
			.update(workspaces)
			.set({ name: 'Переименовано на показе' })
			.where(eq(workspaces.key, 'b2b'));

		// И получает отказ там, где правка ломала бы стенд для следующих.
		await expect(
			setSetting(visitor, 'demo_reset_schedule', { enabled: false, hour: 3 })
		).rejects.toBeInstanceOf(ForbiddenError);
		await expect(deactivateUser(visitor, staffAdminId)).rejects.toBeInstanceOf(ForbiddenError);

		const [staffAdmin] = await database.db
			.select({ isActive: users.isActive })
			.from(users)
			.where(eq(users.id, staffAdminId));
		expect(staffAdmin.isActive).toBe(true);

		const [denied] = await database.db
			.select({ value: count() })
			.from(auditEvents)
			.where(
				and(
					eq(auditEvents.eventType, 'users.deactivated'),
					eq(auditEvents.outcome, 'denied'),
					eq(auditEvents.subjectId, staffAdminId)
				)
			);
		expect(denied.value).toBe(1);

		await resetDemoData(testActor());

		await expect(getSetting('stuck_threshold_days')).resolves.toBe(7);
		await expect(getSetting('enrichment')).resolves.toEqual({ enabled: true, dailyQuota: 200 });
		await expect(getSetting('demo_reset_schedule')).resolves.toEqual({ enabled: true, hour: 4 });

		const [card] = await database.db
			.select({ panels: workflows.cardPanels, templates: workflows.documentTemplateKeys })
			.from(workflows)
			.where(eq(workflows.key, 'b2b'));
		expect(card).toEqual({
			panels: ['terms', 'contract', 'learning', 'documents'],
			templates: ['agreement', 'sublicense', 'handover_act']
		});

		const [workspace] = await database.db
			.select({ name: workspaces.name })
			.from(workspaces)
			.where(eq(workspaces.key, 'b2b'));
		expect(workspace.name).toBe('Работа с ВУЗ');
	}, 120_000);
});
