import { expect, test as base, type APIRequestContext } from '@playwright/test';
import { E2E_EXCHANGE_KEYS, E2E_MOCK_CONTROL_TOKEN } from './exchange-keys';
import { STAFF_ADMIN_STATE } from './global-setup';

/**
 * Обмен против имитаторов стенда: демонстрационная кнопка идёт тем же триггером
 * имитатора CMS, а чужая заявка — ни через открытый триггер, ни от чужого
 * экземпляра — в CRM не попадает. Полный круг «заявка → статус → группа в
 * LMS → результат» проходит `e2e/scenario.test.ts`.
 *
 * Имитаторы подняты контейнерами из `docker-compose.yml` (`mock-cms` на 58081),
 * ключи обмена завёл сид из тех же значений, с которыми поднялись имитаторы
 * (`e2e/exchange-keys.ts`).
 */
const staff = base.extend<object>({ storageState: STAFF_ADMIN_STATE });

const CMS_URL = 'http://localhost:58081';

/** Ключ заявки: свой на прогон, иначе вторая заявка обновила бы первую. */
const externalId = `e2e-${Date.now().toString(36)}`;

type MockState = {
	objects: {
		applications?: {
			externalId: string;
			origin: string;
			revision: number | null;
		}[];
	};
};

/**
 * Заголовок управления имитатором: `__state`, `__scenario` и собственное тело
 * заявки у триггера сцены. Имитаторы прогона подняты с токеном — ровно так же,
 * как на стенде (`e2e/exchange-keys.ts`).
 */
const CONTROL_HEADERS = { 'x-mock-control': E2E_MOCK_CONTROL_TOKEN };

async function mockState(request: APIRequestContext, service: string): Promise<MockState> {
	const response = await request.get(`${service}/__state`, { headers: CONTROL_HEADERS });

	expect(response.ok()).toBeTruthy();

	return (await response.json()) as MockState;
}

staff('кнопка стенда подаёт новую заявку тем же триггером имитатора', async ({ page, request }) => {
	// Демонстрационная кнопка не своя дорога в обход контракта: она жмёт тот же
	// `POST /__send-application`, и заявка приезжает в CRM от имитатора. Каждое
	// нажатие — новая заявка с новым ключом, а не новая ревизия заявки набора.
	await page.goto('/exchange');
	await page
		.getByRole('group', { name: 'Демо: заявка с сайта' })
		.getByRole('button', { name: 'Вуз (b2b)' })
		.click();

	const sent = page.getByText(/Имитатор CMS подал заявку/u).first();

	await expect(sent).toBeVisible();

	const key = /заявку\s+(\S+?):/u.exec(await sent.innerText());

	expect(key).not.toBeNull();

	const demoExternalId = key?.[1] ?? '';

	expect(demoExternalId).not.toBe('site-2026-000123');

	const after = await mockState(request, CMS_URL);
	const card = after.objects.applications?.find((item) => item.externalId === demoExternalId);

	// Заявку завела форма имитатора, а не снимок статуса из CRM, и это первая
	// ревизия новой заявки.
	expect(card?.origin).toBe('form');
	expect(card?.revision).toBe(1);
});

staff('открытый триггер имитатора не принимает чужой заявки', async ({ request }) => {
	// Триггер выходит наружу через прокси стенда, а имитатор подписывает
	// сообщение своим ключом обмена: прими он готовое тело от кого угодно — и
	// заявку в CRM заводил бы посетитель сайта, минуя и форму, и контракт.
	// Снаружи ему называют только набор и ключ заявки стенда.
	const forged = await request.post(`${CMS_URL}/__send-application`, {
		data: {
			form: 'b2b',
			data: {
				form: 'b2b',
				applicant: { kind: 'individual', lastName: 'Чужой', firstName: 'Проситель' },
				contact: { lastName: 'Чужой', firstName: 'Проситель', email: 'stranger@example.org' }
			}
		}
	});

	expect(forged.status()).toBe(403);

	// Ключ этой попытки не знает никто, кроме этого прогона: имитатор общий на
	// весь файл (`docs/development.md`, «Параллельные прогоны»), и соседний тест
	// параллельно заводит свою заявку под ключом набора — общий счёт карточек
	// растёт под его рукой, а не под этой. Признак чужой заявки — её собственный
	// ключ, не общее число карточек у имитатора.
	const strangeExternalId = `${externalId}-forged`;

	const strangeKey = await request.post(`${CMS_URL}/__send-application`, {
		data: { form: 'b2b', externalId: strangeExternalId }
	});

	expect(strangeKey.status()).toBe(400);

	const after = await mockState(request, CMS_URL);
	const strangeCard = after.objects.applications?.find(
		(item) => item.externalId === strangeExternalId
	);

	// До отправки в CRM дело не дошло: карточки с этим ключом у имитатора нет.
	expect(strangeCard).toBeUndefined();
});

staff('заявка чужого экземпляра не принимается', async ({ request }) => {
	const response = await request.post('/api/v1/applications', {
		headers: {
			authorization: `Bearer ${E2E_EXCHANGE_KEYS.cms}`,
			'content-type': 'application/json'
		},
		data: {
			schemaVersion: '3.0',
			eventId: crypto.randomUUID(),
			eventType: 'application.submitted',
			occurredAt: new Date().toISOString(),
			source: { system: 'cms', instance: 'другая-площадка' },
			data: {
				externalId: `${externalId}-stranger`,
				revision: 1,
				form: 'b2b',
				applicant: {
					kind: 'educational_institution',
					name: 'Чужая площадка',
					educationLevel: 'vo'
				},
				contact: {
					lastName: 'Иванов',
					firstName: 'Иван',
					email: `ivanov-${externalId}@example.org`
				}
			}
		}
	});

	// Экземпляр определяется подключением, а не полем из тела: иначе отправитель
	// переписал бы себе чужой экземпляр одной строкой в JSON.
	expect(response.status()).toBe(403);
});
