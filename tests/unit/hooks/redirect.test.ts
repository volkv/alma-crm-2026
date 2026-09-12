import { isRedirect, type RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({ config: { ORIGIN: 'https://crm.example.org' } }));

vi.mock('$lib/server/config', () => ({ getConfig: () => config }));

const { guard } = await import('$lib/server/hooks/guard');

/**
 * Хук, который решил не пускать запрос дальше, обязан именно **бросить**
 * перенаправление.
 *
 * Вид ответа выбирает SvelteKit: обычной навигации — 303 с заголовком
 * `location`, запросу данных клиентского маршрутизатора — конверт JSON, форме,
 * отправленной через `use:enhance`, — свой конверт. Готовый `Response`, который
 * хук собрал сам, такого разбора не проходит: форма на странице с погасшей
 * сессией получила бы разметку страницы входа вместо JSON и сломалась бы на его
 * разборе. Поэтому проверяется, что из хука вылетает `Redirect`, а не ответ.
 */
function appEvent(path: string, user: RequestEvent['locals']['user']): RequestEvent {
	const url = new URL(`https://crm.example.org${path}`);

	return {
		url,
		request: new Request(url),
		route: { id: '/(app)/audit' },
		locals: { requestId: 'test', user, apiKey: null }
	} as unknown as RequestEvent;
}

/** Маршрут, до которого анонима не пускают: сюда доходить не должно. */
const unreachable = (): Response => {
	throw new Error('гвардия обязана остановить запрос до маршрута');
};

describe('перенаправление гвардии', () => {
	it('бросается, а не собирается ответом', async () => {
		const event = appEvent('/audit?from=2026-09-01', null);

		const thrown = await Promise.resolve(guard({ event, resolve: unreachable })).then(
			(response: Response) => response,
			(failure: unknown) => failure
		);

		expect(isRedirect(thrown)).toBe(true);
		expect(thrown).toMatchObject({
			status: 303,
			location: '/login?next=%2Faudit%3Ffrom%3D2026-09-01'
		});
	});

	it('вошедшего пропускает дальше', async () => {
		const event = appEvent('/audit', { id: 'u1' } as RequestEvent['locals']['user']);

		const response = await guard({ event, resolve: () => new Response('страница') });

		expect(response.status).toBe(200);
	});
});
