/**
 * Подключения обмена сохраняются по половинам: сайт (CMS) и система обучения
 * правятся разными формами. Правка одной половины не трогает вторую и не
 * стирает её секрет, а пустое поле секрета своей половины оставляет прежний.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTEGRATION_SETTING_KEYS } from '$lib/contracts/integrations';
import { auditEvents } from '$lib/server/db/schema';
import {
	getExchangeSettings,
	setExchangeCmsSettings,
	setExchangeLmsSettings,
	setExchangeSettings
} from '$lib/server/integrations/settings';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const CMS_SECRET = 'cms-secret-000000000000000000000000000001';
const LMS_SECRET = 'lms-secret-000000000000000000000000000002';

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database.stop();
});

beforeEach(async () => {
	await database.reset();

	await setExchangeSettings(testActor(), {
		cmsInstance: 'itschool-site',
		cmsStatusUrl: 'http://127.0.0.1:9/api/applications/{externalId}/status',
		cmsSecret: CMS_SECRET,
		cmsDefaultOwnerUserId: TEST_USER_IDS.manager,
		lmsInstance: 'moodle-itschool',
		lmsGroupsUrl: 'http://127.0.0.1:9/api/groups',
		lmsSecret: LMS_SECRET
	});
});

describe('половины подключений обмена', () => {
	it('сохранение сайта не меняет систему обучения и не стирает секреты', async () => {
		const before = await getExchangeSettings();

		const view = await setExchangeCmsSettings(testActor(), {
			cmsInstance: 'другой-сайт',
			cmsStatusUrl: '',
			cmsSecret: null,
			cmsDefaultOwnerUserId: null
		});

		const after = await getExchangeSettings();

		expect(after.lms).toEqual(before.lms);
		expect(after.cms).toEqual({
			instance: 'другой-сайт',
			statusUrl: null,
			secret: CMS_SECRET,
			defaultOwnerUserId: null
		});
		expect(view.lms.hasSecret).toBe(true);

		const events = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'settings.updated'));

		// Та же запись журнала, что у общей формы: по записи на каждое сохранение.
		expect(events).toHaveLength(2);
		for (const event of events) {
			expect(event.details).toMatchObject({ changedFields: [INTEGRATION_SETTING_KEYS.exchange] });
		}
		expect(JSON.stringify(events)).not.toContain(CMS_SECRET);
	});

	it('сохранение системы обучения не меняет сайт, новый секрет заменяет только свой', async () => {
		const before = await getExchangeSettings();

		await setExchangeLmsSettings(testActor(), {
			lmsInstance: 'moodle-2',
			lmsGroupsUrl: 'http://127.0.0.1:9/api/v2/groups',
			lmsSecret: 'lms-secret-new-0000000000000000000000000003'
		});

		const after = await getExchangeSettings();

		expect(after.cms).toEqual(before.cms);
		expect(after.lms).toEqual({
			instance: 'moodle-2',
			groupsUrl: 'http://127.0.0.1:9/api/v2/groups',
			secret: 'lms-secret-new-0000000000000000000000000003'
		});
	});
});
