/**
 * Подразделение с сайта вуза — площадкой организации на настоящей базе.
 *
 * Отчёт сайта кладётся в кэш напрямую, как его положил бы прогрев: сеть не
 * участвует. Импорт заводит площадку вида «Подразделение» с внешней системой
 * `sveden`, второй импорт того же подразделения второй площадки не заводит,
 * а кандидат в контакты из этого подразделения ложится ролью к ней.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteReport } from '$lib/contracts/enrichment';
import { storeCached } from '$lib/server/cache/region';
import { organizations, sites } from '$lib/server/db/schema';
import { siteContactDraft } from '$lib/server/directory/organization-card';
import { importSiteUnit, listSiteUnitOffers } from '$lib/server/directory/site-offers';
import { SITE_REPORT_CACHE, siteCacheKey } from '$lib/server/enrichment';
import { setSetting } from '$lib/server/settings';
import { insertOrganization, startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const WEBSITE = 'https://polytech.example.ru';

const section = (path: string, found: boolean) => ({
	url: `${WEBSITE}/sveden/${path}`,
	found,
	truncated: false,
	problem: null
});

const report: SiteReport = {
	website: WEBSITE,
	fetchedAt: '2026-09-28T08:00:00.000Z',
	common: {
		url: `${WEBSITE}/sveden/common`,
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
	struct: section('struct', true),
	managers: section('managers', false),
	education: section('education', false),
	contacts: [
		{
			unit: 'Кафедра «Системы связи»',
			name: 'Лебедев Олег Петрович',
			post: 'заведующий кафедрой',
			email: null,
			phone: null,
			address: null
		}
	],
	units: [
		{
			name: 'Кафедра «Системы связи»',
			address: 'корпус 2, ауд. 214',
			email: 'kaf-svyaz@polytech.example.ru',
			phone: null,
			site: null
		},
		{ name: 'Центр карьеры', address: null, email: null, phone: null, site: null }
	],
	programs: []
};

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

describe('подразделение с сайта вуза', () => {
	it('заводится площадкой «Подразделение» один раз и принимает роль своего руководителя', async () => {
		const admin = testActor();
		// Кандидат в контакты читается тем же путём, что кнопка «Прочитать» —
		// при включённых источниках, но из кэша, без квоты и без сети.
		await setSetting(admin, 'enrichment', { enabled: true, dailyQuota: 5 });

		const organizationId = await insertOrganization(database.db, { shortName: 'Политех' });
		await database.db
			.update(organizations)
			.set({ website: WEBSITE })
			.where(eq(organizations.id, organizationId));
		await storeCached(SITE_REPORT_CACHE, siteCacheKey(WEBSITE), report);

		const before = await listSiteUnitOffers(admin, organizationId);

		expect(before?.source.state).toBe('ready');
		expect(before?.units.map((unit) => unit.name)).toEqual([
			'Кафедра «Системы связи»',
			'Центр карьеры'
		]);

		// Название из формы — как угодно набранное: сверка терпима к кавычкам.
		const imported = await importSiteUnit(admin, {
			organizationId,
			name: 'кафедра системы связи'
		});
		const [row] = await database.db.select().from(sites).where(eq(sites.id, imported.id));

		expect(imported.created).toBe(true);
		expect(row).toMatchObject({
			organizationId,
			kind: 'department',
			name: 'Кафедра «Системы связи»',
			address: 'корпус 2, ауд. 214',
			externalSource: 'sveden'
		});

		// Повторный импорт — та же площадка, второй не заводится.
		const again = await importSiteUnit(admin, { organizationId, name: 'Кафедра «Системы связи»' });

		expect(again).toMatchObject({ id: imported.id, created: false });
		expect(
			await database.db.select().from(sites).where(eq(sites.organizationId, organizationId))
		).toHaveLength(1);

		// Заведённое больше не предлагается, остальное — да.
		const after = await listSiteUnitOffers(admin, organizationId);

		expect(after?.units.map((unit) => unit.name)).toEqual(['Центр карьеры']);
		expect(after?.total).toBe(2);

		// Руководитель подразделения ложится ролью к заведённой площадке.
		const draft = await siteContactDraft(admin, organizationId, {
			unit: 'Кафедра «Системы связи»',
			name: 'Лебедев Олег Петрович'
		});

		expect(draft.role.siteId).toBe(imported.id);
	});
});
