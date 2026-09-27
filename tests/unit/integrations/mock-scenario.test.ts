import { describe, expect, it } from 'vitest';
import { createScenario } from '../../../mocks/shared/scenario.ts';

describe('срок сценария имитатора', () => {
	it('по истечении срока имитатор возвращается в normal', () => {
		let now = Date.parse('2026-09-28T10:00:00Z');
		const scenario = createScenario({ now: () => now });

		expect(scenario.apply({ mode: 'offline', failNext: 2, ttlSeconds: 300 })).toEqual({
			ok: true,
			reset: false
		});
		expect(scenario.read()).toMatchObject({
			mode: 'offline',
			expiresAt: '2026-09-28T10:05:00.000Z'
		});

		now += 299_000;
		expect(scenario.read().mode).toBe('offline');

		now += 1_000;
		expect(scenario.read()).toEqual({
			failNext: 0,
			status: 503,
			delayMs: 0,
			mode: 'normal',
			match: null,
			expiresAt: null
		});
		expect(scenario.takeFailure()).toBeNull();
	});

	it('срок переживает частичную правку и снимается явным null', () => {
		const now = Date.parse('2026-09-28T10:00:00Z');
		const scenario = createScenario({ now: () => now });

		scenario.apply({ mode: 'offline', ttlSeconds: 60 });
		scenario.apply({ match: 'app-1' });
		expect(scenario.read().expiresAt).toBe('2026-09-28T10:01:00.000Z');

		scenario.apply({ mode: 'normal', ttlSeconds: null });
		expect(scenario.read().expiresAt).toBeNull();

		expect(scenario.apply({ ttlSeconds: 0 })).toEqual({
			ok: false,
			issues: ['ttlSeconds: ожидается число от 1 до 86400']
		});
	});
});
