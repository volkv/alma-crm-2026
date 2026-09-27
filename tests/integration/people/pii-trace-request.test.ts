/**
 * След просмотра персональных данных — одно событие на запрос.
 *
 * Загрузчик карточки читает людей в несколько приёмов: сначала стороны
 * записи, потом справочник, потом данные модулей. Каждое такое чтение
 * открывает и закрывает свою область сбора, и без внешней области на весь
 * запрос журнал получал по строке «Просмотр контактов» на каждый приём — с
 * одним и тем же номером запроса. Проверяется хук, через который идёт каждый
 * запрос браузера и API, на настоящей базе.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actorFromEvent } from '$lib/server/actor';
import { auditEvents } from '$lib/server/db/schema';
import { getPerson } from '$lib/server/directory/read';
import { piiTrace } from '$lib/server/hooks/pii-trace';
import { insertPerson, startTestDatabase, type TestDatabase } from '../helpers/db';
import { pageEvent } from '../helpers/event';

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
});

describe('след просмотра персональных данных на запрос', () => {
	it('последовательные чтения одного запроса оставляют одно событие со всеми людьми', async () => {
		const first = await insertPerson(database.db, { lastName: 'Первый' });
		const second = await insertPerson(database.db, { lastName: 'Второй' });
		const event = pageEvent();

		await piiTrace({
			event,
			resolve: async (resolved) => {
				const ctx = actorFromEvent(resolved);

				// Два приёма подряд, как у загрузчика карточки.
				await getPerson(ctx, first);
				await getPerson(ctx, second);

				return new Response('ok');
			}
		});

		const recorded = await database.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'people.pii_viewed'));

		expect(recorded).toHaveLength(1);
		expect(recorded[0].requestId).toBe(event.locals.requestId);
		expect(recorded[0].details).toEqual({ personIds: [first, second] });
	});
});
