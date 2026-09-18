import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { serverTiming, trackDatabaseQuery } from '$lib/server/hooks/server-timing';

/** Заголовок в разобранном виде: имя показателя → миллисекунды. */
function durations(response: Response): Record<string, number> {
	const header = response.headers.get('Server-Timing') ?? '';
	const parsed: Record<string, number> = {};

	for (const part of header.split(', ')) {
		const match = /^([a-z]+);dur=(\d+\.\d)$/.exec(part);

		if (match === null) {
			throw new Error(`Показатель «${part}» записан не по форме Server-Timing`);
		}

		parsed[match[1]] = Number(match[2]);
	}

	return parsed;
}

/** Запрос в том объёме, в каком его читает хук: он смотрит только на ответ. */
const event = {} as RequestEvent;

/** Занять поток на заданное время: `performance.now()` меряет настоящие часы. */
function spend(milliseconds: number): void {
	const until = performance.now() + milliseconds;

	while (performance.now() < until) {
		// Пустое ожидание намеренно: таймер отдал бы поток, и замер поймал бы
		// не работу, а простой.
	}
}

describe('Server-Timing', () => {
	it('называет три показателя и ничего сверх них', async () => {
		const response = await serverTiming({ event, resolve: () => new Response('страница') });

		expect(Object.keys(durations(response))).toStrictEqual(['db', 'app', 'total']);
	});

	it('складывается: ожидание базы плюс работа приложения — это всё время запроса', async () => {
		const response = await serverTiming({
			event,
			resolve: async () => {
				const finished = trackDatabaseQuery();
				await new Promise((wake) => setTimeout(wake, 30));
				finished?.();
				spend(20);

				return new Response('страница');
			}
		});

		const { db, app, total } = durations(response);

		expect(db).toBeGreaterThanOrEqual(25);
		expect(app).toBeGreaterThanOrEqual(15);
		// Округление до десятой доли миллисекунды — единственная разница между
		// суммой слагаемых и целым.
		expect(Math.abs(db + app - total)).toBeLessThanOrEqual(0.2);
	});

	it('считает одновременные запросы к базе временем ожидания, а не суммой длительностей', async () => {
		const response = await serverTiming({
			event,
			resolve: async () => {
				// Загрузчик страницы запускает свои чтения разом; сложенные
				// длительности дали бы втрое больше, чем длился сам запрос, и
				// «работа приложения» ушла бы в минус.
				await Promise.all(
					[0, 0, 0].map(async () => {
						const finished = trackDatabaseQuery();
						await new Promise((wake) => setTimeout(wake, 30));
						finished?.();
					})
				);

				return new Response('страница');
			}
		});

		const { db, total } = durations(response);

		expect(db).toBeLessThan(90);
		expect(db).toBeLessThanOrEqual(total);
	});

	it('не мешает ответу: заголовки и тело остаются теми же', async () => {
		const response = await serverTiming({
			event,
			resolve: () =>
				new Response('страница', { status: 201, headers: { 'x-request-id': 'probe-1' } })
		});

		expect(response.status).toBe(201);
		expect(response.headers.get('x-request-id')).toBe('probe-1');
		await expect(response.text()).resolves.toBe('страница');
	});

	it('вне запроса не заводит счётчика: сид и фоновая работа ничего не меряют', () => {
		expect(trackDatabaseQuery()).toBeNull();
	});
});
