/**
 * Проба живости: приложение без хранилища файлов здоровым не считается.
 *
 * Проверять это на заглушке бессмысленно — вопрос ровно в том, как ведёт себя
 * проба, когда настоящее хранилище перестало отвечать. Поэтому файл в середине
 * гасит хранилище: после этого ни один тест этого файла в него уже не ходит.
 *
 * Хранилище здесь своё, а не общее на прогон (`isolatedStorage`): погашенное
 * общее унесло бы вместе с собой и все соседние файлы. Это единственный файл,
 * которому нужен собственный MinIO.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const healthEndpoint = await import('../../../src/routes/api/health/+server');
const health = healthEndpoint.GET as unknown as (event?: RequestEvent) => Promise<Response>;

type HealthBody = { status: string; db: string; redis: string; storage: string };

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase({ isolatedStorage: true });
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

describe('проба живости', () => {
	it('отвечает 200, пока отвечают база, Redis и хранилище', async () => {
		const response = await health();
		const body = (await response.json()) as HealthBody;

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ status: 'ok', db: 'ok', redis: 'ok', storage: 'ok' });
	});

	it('после остановки хранилища отвечает 503 и называет, что именно легло', async () => {
		await database.storage.stop();

		// Отказ хранилища — это ответ пробы, а не исключение: иначе healthcheck
		// контейнера получил бы пятисотую без единого слова о причине.
		const response = await health();
		const body = (await response.json()) as HealthBody;

		expect(response.status).toBe(503);
		expect(body.status).toBe('error');
		// База и Redis живы, и проба это показывает: чинить идут к хранилищу.
		expect(body.db).toBe('ok');
		expect(body.redis).toBe('ok');
		expect(body.storage).toMatch(/^Хранилище файлов не отвечает/);
		// Код отказа в сообщении есть, а адреса хранилища и ключей — нет: проба
		// открыта любому, кто дотянулся до порта приложения.
		expect(body.storage).toMatch(/\([A-Za-z_]+\)$/);
		expect(body.storage).not.toContain('test-access-key');
		expect(body.storage).not.toContain('test-secret-key');
		expect(body.storage).not.toContain(new URL(database.storage.env.S3_ENDPOINT).host);
	});
});
