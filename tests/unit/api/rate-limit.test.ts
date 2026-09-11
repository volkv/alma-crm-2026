import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { counters, expires } = vi.hoisted(() => ({
	counters: new Map<string, number>(),
	expires: new Map<string, number>()
}));

// Ограничитель — это две команды к Redis и арифметика над временем. Настоящий
// Redis проверяется интеграционным тестом; здесь важно, что окно считается
// правильно и что срок жизни ставится ровно один раз на окно.
vi.mock('$lib/server/redis', () => ({
	getRedis: () => ({
		incr: (key: string) => {
			const next = (counters.get(key) ?? 0) + 1;
			counters.set(key, next);
			return Promise.resolve(next);
		},
		expire: (key: string, seconds: number) => {
			expires.set(key, (expires.get(key) ?? 0) + 1);
			return Promise.resolve(seconds);
		}
	})
}));

const { API_RATE_LIMIT_WINDOW_SECONDS, consumeRateLimit, rateLimitHeaders, tighter, windowFor } =
	await import('$lib/server/api/rate-limit');

beforeEach(() => {
	counters.clear();
	expires.clear();
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-09-12T10:00:00.000Z'));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('окно ограничителя', () => {
	it('начинается на границе минуты и досчитывает секунды до следующей', () => {
		expect(windowFor(Date.parse('2026-09-12T10:00:00.000Z'))).toEqual({
			start: Date.parse('2026-09-12T10:00:00.000Z') / 1000,
			resetSeconds: 60
		});

		expect(windowFor(Date.parse('2026-09-12T10:00:45.900Z'))).toEqual({
			start: Date.parse('2026-09-12T10:00:00.000Z') / 1000,
			resetSeconds: 15
		});

		expect(windowFor(Date.parse('2026-09-12T10:01:00.000Z')).start).toBe(
			windowFor(Date.parse('2026-09-12T10:00:00.000Z')).start + API_RATE_LIMIT_WINDOW_SECONDS
		);
	});
});

describe('счётчик обращений', () => {
	it('пропускает до лимита и отказывает после него', async () => {
		expect(await consumeRateLimit('key:one', 2)).toMatchObject({
			allowed: true,
			limit: 2,
			remaining: 1
		});
		expect(await consumeRateLimit('key:one', 2)).toMatchObject({ allowed: true, remaining: 0 });
		expect(await consumeRateLimit('key:one', 2)).toMatchObject({ allowed: false, remaining: 0 });
	});

	it('считает корзины по отдельности', async () => {
		await consumeRateLimit('key:one', 1);

		expect(await consumeRateLimit('key:two', 1)).toMatchObject({ allowed: true });
		expect(await consumeRateLimit('key:one', 1)).toMatchObject({ allowed: false });
	});

	it('ставит срок жизни один раз на окно', async () => {
		await consumeRateLimit('key:one', 5);
		await consumeRateLimit('key:one', 5);
		await consumeRateLimit('key:one', 5);

		expect([...expires.values()]).toEqual([1]);
	});

	it('начинает счёт заново в следующем окне', async () => {
		await consumeRateLimit('key:one', 1);
		expect(await consumeRateLimit('key:one', 1)).toMatchObject({ allowed: false });

		vi.setSystemTime(new Date('2026-09-12T10:01:00.000Z'));

		expect(await consumeRateLimit('key:one', 1)).toMatchObject({ allowed: true, remaining: 0 });
	});

	it('отсчитывает остаток окна от текущего момента', async () => {
		vi.setSystemTime(new Date('2026-09-12T10:00:50.000Z'));

		expect(await consumeRateLimit('key:one', 5)).toMatchObject({ resetSeconds: 10 });
	});
});

describe('выбор вердикта и заголовки', () => {
	const allowed = { allowed: true, limit: 120, remaining: 5, resetSeconds: 30 };
	const denied = { allowed: false, limit: 600, remaining: 0, resetSeconds: 12 };

	it('сообщает наружу тот лимит, который ближе к отказу', () => {
		expect(tighter(allowed, denied)).toBe(denied);
		expect(tighter(denied, allowed)).toBe(denied);
		expect(tighter(allowed, { ...allowed, limit: 600, remaining: 500 })).toBe(allowed);
	});

	it('раскладывается в заголовки RateLimit-*', () => {
		expect(rateLimitHeaders(allowed)).toEqual({
			'RateLimit-Limit': '120',
			'RateLimit-Remaining': '5',
			'RateLimit-Reset': '30'
		});
	});
});
