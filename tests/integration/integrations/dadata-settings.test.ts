/**
 * Ключ Dadata на странице «Интеграции» на настоящей базе.
 *
 * Сервер не отдаёт ключ целиком: на экран уходит маска и источник, в базе
 * ключ лежит шифртекстом, в журнале — только «задан» или «удалён» и узел.
 * Ключ окружения действует, пока в интерфейсе ключа нет; ключ из интерфейса
 * его перекрывает, а удаление возвращает к окружению.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTEGRATION_SETTING_KEYS } from '$lib/contracts/integrations';
import { appSettings, auditEvents } from '$lib/server/db/schema';
import { ValidationError } from '$lib/server/errors';
import {
	clearDadataKey,
	getDadataConnection,
	getDadataSettingsView,
	setDadataSettings
} from '$lib/server/integrations/settings';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const ENV_KEY = 'environment-key-0000000000000000000000e4v1';
const UI_KEY = 'interface-key-000000000000000000000000ab12';

process.env.DADATA_API_KEY = ENV_KEY;

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

describe('ключ Dadata', () => {
	it('без настройки действует ключ окружения, а экран видит только маску', async () => {
		const ctx = testActor();
		const view = await getDadataSettingsView(ctx);

		expect(view).toEqual({
			baseUrl: 'https://suggestions.dadata.ru',
			customBaseUrl: false,
			keySource: 'environment',
			keyMask: '•••• e4v1',
			environmentKey: true
		});
		expect(JSON.stringify(view)).not.toContain(ENV_KEY);
		expect(await getDadataConnection()).toMatchObject({ key: ENV_KEY, source: 'environment' });
	});

	it('ключ из интерфейса перекрывает окружение и не выходит наружу ни в виде, ни в базе, ни в журнале', async () => {
		const ctx = testActor();
		const saved = await setDadataSettings(ctx, { baseUrl: null, apiKey: UI_KEY });

		expect(saved).toMatchObject({ keySource: 'settings', keyMask: '•••• ab12' });
		expect(JSON.stringify(saved)).not.toContain(UI_KEY);
		expect(JSON.stringify(await getDadataSettingsView(ctx))).not.toContain(UI_KEY);
		expect(await getDadataConnection()).toMatchObject({
			origin: 'https://suggestions.dadata.ru',
			key: UI_KEY,
			source: 'settings'
		});

		const [row] = await database.db
			.select({ value: appSettings.value })
			.from(appSettings)
			.where(eq(appSettings.key, INTEGRATION_SETTING_KEYS.dadata));

		expect(JSON.stringify(row.value)).not.toContain(UI_KEY);

		const events = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'settings.updated'));

		expect(events.map((event) => event.details)).toEqual([
			{
				changedFields: [INTEGRATION_SETTING_KEYS.dadata],
				mode: 'key_set',
				host: 'suggestions.dadata.ru'
			}
		]);
	});

	it('удаление ключа из интерфейса возвращает к ключу окружения', async () => {
		const ctx = testActor();

		await setDadataSettings(ctx, { baseUrl: null, apiKey: UI_KEY });
		const cleared = await clearDadataKey(ctx);

		expect(cleared).toMatchObject({ keySource: 'environment', keyMask: '•••• e4v1' });
		expect(await getDadataConnection()).toMatchObject({ key: ENV_KEY, source: 'environment' });
	});

	it('свой адрес без своего ключа не сохраняется: ключ окружения уходит только в облако', async () => {
		const ctx = testActor();

		await expect(
			setDadataSettings(ctx, { baseUrl: 'https://dadata.example.org', apiKey: null })
		).rejects.toBeInstanceOf(ValidationError);
		expect(await getDadataConnection()).toMatchObject({
			origin: 'https://suggestions.dadata.ru',
			key: ENV_KEY
		});
	});
});
