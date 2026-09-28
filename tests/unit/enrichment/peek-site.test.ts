import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteReport } from '$lib/contracts/enrichment';
import type { ActorContext } from '$lib/server/actor';

/**
 * Карточка вуза показывает раздел «Сведения», если его уже читали в эти сутки.
 * Держится это на одном: заглядывание в кэш находит ровно то, что положило
 * настоящее чтение, и само ни квоту не тратит, ни на сайт не ходит.
 */

const store = new Map<string, string>();
const consumeQuota = vi.fn(async () => undefined);
const fetchSiteReport = vi.fn();

vi.mock('$lib/server/redis', () => ({
	getRedis: () => ({
		get: async (key: string) => store.get(key) ?? null,
		set: async (key: string, value: string) => {
			store.set(key, value);
			return 'OK';
		}
	})
}));

vi.mock('$lib/server/rbac', () => ({
	requirePermission: () => undefined,
	scopeFingerprint: () => 'all'
}));

vi.mock('$lib/server/enrichment/access', () => ({
	requireEnabled: async () => ({ dailyQuota: 100 }),
	consumeQuota
}));

vi.mock('$lib/server/enrichment/passports', () => ({
	issuePassport: async (_ctx: unknown, kind: string, passport: unknown) => ({ kind, passport })
}));

vi.mock('$lib/server/enrichment/sveden', async (original) => ({
	...(await original<typeof import('$lib/server/enrichment/sveden')>()),
	fetchSiteReport
}));

const { lookupSite, peekSiteReport } = await import('$lib/server/enrichment');

const ctx = {} as ActorContext;

const section = (path: string) => ({
	url: `https://polytech.example.ru/sveden/${path}`,
	found: false,
	truncated: false,
	problem: null
});

const report: SiteReport = {
	website: 'https://polytech.example.ru',
	fetchedAt: '2026-09-24T08:00:00.000Z',
	common: {
		url: 'https://polytech.example.ru/sveden/common',
		found: false,
		fields: {
			fullName: null,
			shortName: null,
			regDate: null,
			address: null,
			telephone: null,
			email: null,
			founder: null,
			headName: null,
			headPost: null
		},
		propertyCount: 0,
		problem: null
	},
	struct: section('struct'),
	managers: section('managers'),
	education: section('education'),
	contacts: [],
	units: [],
	programs: []
};

describe('раздел «Сведения» из кэша', () => {
	beforeEach(() => {
		store.clear();
		consumeQuota.mockClear();
		fetchSiteReport.mockReset();
		fetchSiteReport.mockResolvedValue(report);
	});

	it('пока сайт не читали, отчёта нет и наружу никто не ходит', async () => {
		expect(await peekSiteReport(ctx, 'polytech.example.ru')).toBeNull();
		expect(fetchSiteReport).not.toHaveBeenCalled();
		expect(consumeQuota).not.toHaveBeenCalled();
	});

	it('находит прочитанное, как бы ни был записан адрес, и квоту не тратит', async () => {
		await lookupSite(ctx, 'https://polytech.example.ru/sveden/common');
		consumeQuota.mockClear();
		fetchSiteReport.mockClear();

		expect(await peekSiteReport(ctx, 'POLYTECH.example.ru')).toEqual(report);
		expect(fetchSiteReport).not.toHaveBeenCalled();
		expect(consumeQuota).not.toHaveBeenCalled();
	});
});
