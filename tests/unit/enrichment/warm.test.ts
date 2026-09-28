import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteReport } from '$lib/contracts/enrichment';

/**
 * Прогрев отчёта сайта — ускорение, а не обязанность: при выключенных
 * источниках наружу не ходит, прочитанное второй раз не читает, один сайт
 * греет один раз, а сбой остаётся в логе и вызывающего не роняет.
 */

const store = new Map<string, string>();
const settings = { enabled: true, dailyQuota: 50 };
const fetchSiteReport = vi.fn();

vi.mock('$lib/server/redis', () => ({
	getRedis: () => ({
		get: async (key: string) => store.get(key) ?? null,
		set: async (key: string, value: string, ...options: unknown[]) => {
			if (options.includes('NX') && store.has(key)) {
				return null;
			}

			store.set(key, value);
			return 'OK';
		},
		del: async (key: string) => (store.delete(key) ? 1 : 0)
	})
}));

vi.mock('$lib/server/settings', () => ({
	getSetting: async () => settings
}));

vi.mock('$lib/server/rbac', () => ({
	requirePermission: () => undefined,
	scopeFingerprint: () => 'all'
}));

vi.mock('$lib/server/enrichment/access', () => ({
	requireEnabled: async () => ({ dailyQuota: 50 }),
	consumeQuota: async () => undefined
}));

vi.mock('$lib/server/enrichment/passports', () => ({
	issuePassport: async () => null
}));

vi.mock('$lib/server/enrichment/sveden', async (original) => ({
	...(await original<typeof import('$lib/server/enrichment/sveden')>()),
	fetchSiteReport
}));

const { siteReadiness, warmSite, warmSiteReport } = await import('$lib/server/enrichment/warm');

const section = (path: string, found: boolean) => ({
	url: `https://polytech.example.ru/sveden/${path}`,
	found,
	truncated: false,
	problem: null
});

const report: SiteReport = {
	website: 'https://polytech.example.ru',
	fetchedAt: '2026-09-28T08:00:00.000Z',
	common: {
		url: 'https://polytech.example.ru/sveden/common',
		found: true,
		fields: {
			fullName: 'Политехнический университет',
			shortName: null,
			regDate: null,
			address: null,
			telephone: null,
			email: null,
			founder: null,
			headName: null,
			headPost: null
		},
		propertyCount: 1,
		problem: null
	},
	struct: section('struct', true),
	managers: section('managers', false),
	education: section('education', false),
	contacts: [],
	units: [{ name: 'Кафедра систем связи', address: null, email: null, phone: null, site: null }],
	programs: []
};

describe('прогрев сведений сайта', () => {
	beforeEach(() => {
		store.clear();
		settings.enabled = true;
		fetchSiteReport.mockReset();
		fetchSiteReport.mockResolvedValue(report);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('при выключенных источниках на сайт не ходит', async () => {
		settings.enabled = false;

		expect(await warmSite('polytech.example.ru')).toBe('disabled');
		expect(await siteReadiness('polytech.example.ru')).toEqual({ state: 'disabled' });
		expect(fetchSiteReport).not.toHaveBeenCalled();
	});

	it('читает один раз, дальше отдаёт прочитанное из кэша', async () => {
		expect(await warmSite('https://polytech.example.ru/sveden/struct')).toBe('fetched');
		expect(await warmSite('POLYTECH.example.ru')).toBe('cached');
		expect(fetchSiteReport).toHaveBeenCalledTimes(1);
		expect(await siteReadiness('polytech.example.ru')).toEqual({ state: 'ready', report });
		// Замок снят: следующий прогрев другого срока не ждёт.
		expect([...store.keys()].some((key) => key.includes(':warm:'))).toBe(false);
	});

	it('пока идёт чтение, второй прогрев того же сайта не начинается', async () => {
		let finish: (value: SiteReport) => void = () => undefined;

		fetchSiteReport.mockReturnValueOnce(new Promise<SiteReport>((resolve) => (finish = resolve)));

		const first = warmSite('polytech.example.ru');

		await vi.waitFor(() => expect(fetchSiteReport).toHaveBeenCalledTimes(1));
		expect(await warmSite('polytech.example.ru')).toBe('busy');
		expect(await siteReadiness('polytech.example.ru')).toEqual({ state: 'warming' });

		finish(report);

		expect(await first).toBe('fetched');
		expect(fetchSiteReport).toHaveBeenCalledTimes(1);
	});

	it('сбой чтения — строка в логе, а не исключение у вызывающего', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		fetchSiteReport.mockRejectedValueOnce(new Error('сайт не ответил'));

		expect(() => warmSiteReport('polytech.example.ru')).not.toThrow();
		await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
		expect(String(log.mock.calls[0][0])).toContain('https://polytech.example.ru');
		// Замок снят и после сбоя: следующее открытие карточки попробует снова.
		expect([...store.keys()].some((key) => key.includes(':warm:'))).toBe(false);
	});

	it('без сайта и прогревать нечего', async () => {
		expect(await warmSite(null)).toBe('no_site');
		expect(await siteReadiness('')).toEqual({ state: 'no_site' });
	});
});
